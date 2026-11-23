import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAction, nextStatus, buildRemediationIssue, claimState, remediationLabel, CLAIM_STALE_MS } from '../src/secrets/lifecycle.js';
import { makeRemediation } from '../src/secrets/remediation.js';
import { planSecretSync, planHistorySecrets, makeSecretScanner } from '../src/secrets/sync.js';
import { makeHistoryProcessor } from '../src/secrets/history.js';

test('validateAction: reason and code rules', () => {
  assert.equal(validateAction({ action: 'nope', reason: 'abc' }).ok, false);
  assert.equal(validateAction({ action: 'confirm_rotation', reason: ' ' }).ok, false);
  assert.equal(validateAction({ action: 'confirm_rotation', reason: 'x'.repeat(401) }).ok, false);
  assert.equal(validateAction({ action: 'dismiss', reason: 'test key' }).ok, false);          // code needed
  assert.equal(validateAction({ action: 'dismiss', reason: 'test key', code: 'bogus' }).ok, false);
  const ok = validateAction({ action: 'dismiss', reason: '  sandbox key  ', code: 'test_data' });
  assert.deepEqual(ok, { ok: true, reason: 'sandbox key', code: 'test_data' });
  assert.equal(validateAction({ action: 'allow_value', reason: 'public docs sample', code: 'x' }).code, null);
});

test('nextStatus: only open findings can be acted on', () => {
  assert.deepEqual(nextStatus('open', 'confirm_rotation'), { status: 'resolved', eventType: 'rotation_confirmed' });
  assert.equal(nextStatus('open', 'dismiss').status, 'dismissed');
  assert.equal(nextStatus('open', 'allow_source').eventType, 'allowlisted');
  assert.match(nextStatus('resolved', 'dismiss').error, /already resolved/);
  assert.match(nextStatus('dismissed', 'confirm_rotation').error, /already dismissed/);
});

test('remediation issue: uses the preview only, mentions the owner, links the page', () => {
  const f = { id: 'AbC-123', preview: 'AKIA****MPLE', detail: { detector: 'AWS Access Key', pageId: '42', pageTitle: 'Runbook', ownerAccountId: 'acc-1' } };
  const r = buildRemediationIssue({ finding: f, baseUrl: 'https://x.atlassian.net' });
  const json = JSON.stringify(r);
  assert.match(r.summary, /Rotate exposed AWS Access Key found in page "Runbook"/);
  assert.equal(r.label, 'tw-abc-123');
  assert.ok(json.includes('AKIA****MPLE'));
  assert.ok(json.includes('"id":"acc-1"'));
  assert.ok(json.includes('https://x.atlassian.net/wiki/pages/viewpage.action?pageId=42'));
  assert.equal(r.description.type, 'doc');
});

test('remediation issue: work item secret, no owner, no base url', () => {
  const r = buildRemediationIssue({ finding: { id: 'i', preview: '****', detail: { detector: 'Generic API Key', issueKey: 'TRAC-5' } } });
  assert.match(r.summary, /found in TRAC-5/);
  assert.ok(!JSON.stringify(r).includes('mention'));
  assert.equal(remediationLabel('X'), 'tw-x');
});

test('claimState covers all four cases', () => {
  const nowMs = 1_000_000;
  assert.equal(claimState({ issueKey: 'T-1', claimedAtMs: 1, nowMs }), 'done');
  assert.equal(claimState({ issueKey: null, claimedAtMs: null, nowMs }), 'create');
  assert.equal(claimState({ issueKey: null, claimedAtMs: nowMs - 1000, nowMs }), 'wait');
  assert.equal(claimState({ issueKey: null, claimedAtMs: nowMs - CLAIM_STALE_MS - 1, nowMs }), 'search');
});

// ---- remediation runner ----
function rem(over = {}) {
  const db = { finding: { id: 'f1', status: 'open', redacted_preview: 'AKIA****MPLE', detail: JSON.stringify({ detector: 'AWS Access Key', pageId: '1', ownerAccountId: 'o' }), remediation_issue_key: null, claimed_at: null }, created: [], events: [] };
  const deps = {
    getConfig: async () => ({ enabled: true, projectKey: 'TRAC', baseUrl: 'https://x' }),
    loadFinding: async () => db.finding,
    claim: async () => { db.finding = { ...db.finding, claimed_at: Math.floor(Date.now() / 1000) }; db.claims = (db.claims || 0) + 1; },
    findByLabel: async () => db.existingByLabel || null,
    createIssue: async (a) => { db.created.push(a); return 'TRAC-' + (100 + db.created.length); },
    saveKey: async (id, key) => { db.finding = { ...db.finding, remediation_issue_key: key }; },
    logEvent: async (id, type) => db.events.push(type),
    ...over,
  };
  return { run: makeRemediation(deps), db };
}

test('remediation: creates one issue, saves the key, then is a no-op on repeat', async () => {
  const { run, db } = rem();
  assert.deepEqual(await run('f1'), { issueKey: 'TRAC-101', created: true });
  assert.deepEqual(await run('f1'), { issueKey: 'TRAC-101', existing: true });
  assert.equal(db.created.length, 1);
  assert.equal(db.created[0].assigneeAccountId, 'o');
  assert.deepEqual(db.events, ['remediation_created']);
});

test('remediation: not configured, disabled, missing, not open', async () => {
  assert.ok((await rem({ getConfig: async () => null }).run('f1')).skipped);
  assert.ok((await rem({ getConfig: async () => ({ enabled: false, projectKey: 'T' }) }).run('f1')).skipped);
  assert.ok((await rem({ loadFinding: async () => null }).run('f1')).skipped);
  const r = rem(); r.db.finding.status = 'dismissed';
  assert.match((await r.run('f1')).skipped, /dismissed/);
  assert.equal(r.db.created.length, 0);
});

test('remediation: crash after create, retry inside the claim window waits (retriable)', async () => {
  const r = rem({ saveKey: async () => { throw new Error('db blip'); } });
  await assert.rejects(r.run('f1'), /db blip/);
  assert.equal(r.db.created.length, 1);
  const retry = rem();                       // same db state: claimed a moment ago, no key
  retry.db.finding = { ...r.db.finding };
  await assert.rejects(retry.run('f1'), (e) => e.status === 503);
  assert.equal(retry.db.created.length, 0);  // nothing created twice
});

test('remediation: a stale claim looks the issue up by label before creating', async () => {
  const old = Math.floor(Date.now() / 1000) - 600;
  const a = rem(); a.db.finding.claimed_at = old; a.db.existingByLabel = 'TRAC-77';
  assert.deepEqual(await a.run('f1'), { issueKey: 'TRAC-77', existing: true });
  assert.equal(a.db.created.length, 0);
  assert.deepEqual(a.db.events, ['remediation_linked']);
  const b = rem(); b.db.finding.claimed_at = old;   // nothing found: create now
  assert.equal((await b.run('f1')).created, true);
});

test('remediation: a create failure leaves no key so the job can retry', async () => {
  const r = rem({ createIssue: async () => { throw new Error('API 400'); } });
  await assert.rejects(r.run('f1'), /400/);
  assert.equal(r.db.finding.remediation_issue_key, null);
});

// ---- planner / scanner / history ----
const row = (id, fp, status = 'open') => ({ id, fingerprint: fp, status, detail: null });
const sec = (fp) => ({ name: 'X', severity: 4, fingerprint: fp, preview: '****' });

test('planner marks brand-new and reopened findings as isNew', () => {
  const p = planSecretSync([row('r', 'old', 'resolved'), row('k', 'same')], [sec('new'), sec('old'), sec('same')]);
  assert.deepEqual(p.upserts.map((u) => [u.fingerprint, u.isNew]), [['new', true], ['old', true], ['same', false]]);
});

test('history planner skips known fingerprints and duplicates', () => {
  const out = planHistorySecrets([row('r', 'a', 'dismissed'), row('s', 'b', 'resolved')], [sec('a'), sec('b'), sec('c'), sec('c')]);
  assert.deepEqual(out.map((s) => s.fingerprint), ['c']);
});

test('scanner: allowlisted secrets are dropped before planning', async () => {
  let planned;
  const scan = makeSecretScanner({
    load: async () => [], loadAllowed: async () => new Set(['a']),
    apply: async (plan) => { planned = plan; return { opened: ['n1'] }; },
    find: () => [sec('a'), sec('b')],
  });
  const r = await scan({ sourceType: 'jira_issue', sourceId: '1', text: 'x' });
  assert.deepEqual(planned.upserts.map((u) => u.fingerprint), ['b']);
  assert.deepEqual(r.opened, ['n1']);
});

function hist(over = {}) {
  const st = { scanned: new Set(), texts: { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' }, applied: [], follow: [] };
  const deps = {
    fetchMeta: async () => ({ title: 'T', version: 5, ownerId: 'o' }),
    listVersionNumbers: async () => [1, 2, 3, 4, 5],
    fetchVersionText: async (p, n) => st.texts[n] ?? null,
    isScanned: async (p, n) => st.scanned.has(n),
    markScanned: async (p, n) => st.scanned.add(n),
    loadExisting: async () => [],
    loadAllowed: async () => new Set(),
    applyHistory: async (fresh, ctx) => { st.applied.push([ctx.version, fresh.map((s) => s.fingerprint)]); return { opened: fresh.map((s) => 'id-' + s.fingerprint) }; },
    followUp: async (p, n) => st.follow.push(n),
    find: (t) => (t === 'two' ? [sec('fp2')] : []),
    ...over,
  };
  return { run: makeHistoryProcessor(deps), st };
}

test('history: scans old versions newest first, never the current one, finds the old secret', async () => {
  const h = hist();
  const r = await h.run({ sourceId: '9' });
  assert.deepEqual([...h.st.scanned].sort(), [1, 2, 3, 4]);
  assert.deepEqual(h.st.applied, [[2, ['fp2']]]);
  assert.deepEqual(r.opened, ['id-fp2']);
});

test('history: respects the per-run cap and asks for a follow-up; second run finishes', async () => {
  const h = hist({ perRun: 2 });
  const r1 = await h.run({ sourceId: '9' });
  assert.equal(r1.scanned, 2);
  assert.deepEqual(h.st.follow, [2]);
  const r2 = await h.run({ sourceId: '9' });
  assert.equal(r2.scanned, 2);
  assert.equal(r2.remaining, 0);
  assert.equal(h.st.follow.length, 1);
});

test('history: unreadable versions are still marked scanned; a fetch error marks nothing further', async () => {
  const h = hist({ fetchVersionText: async (p, n) => (n === 3 ? null : 'x') });
  await h.run({ sourceId: '9' });
  assert.ok(h.st.scanned.has(3));
  const bad = hist({ fetchVersionText: async (p, n) => { if (n === 3) throw new Error('API 503'); return 'x'; } });
  await assert.rejects(bad.run({ sourceId: '9' }), /503/);
  assert.ok(bad.st.scanned.has(4) && !bad.st.scanned.has(3));
});

test('history: allowlisted and known secrets do not create findings; gone page is skipped', async () => {
  const a = hist({ loadAllowed: async () => new Set(['fp2']) });
  await a.run({ sourceId: '9' });
  assert.deepEqual(a.st.applied, []);
  const k = hist({ loadExisting: async () => [row('r', 'fp2', 'resolved')] });
  await k.run({ sourceId: '9' });
  assert.deepEqual(k.st.applied, []);
  assert.ok((await hist({ fetchMeta: async () => null }).run({ sourceId: '9' })).skipped);
  await assert.rejects(hist().run({}), /no page id/);
});
