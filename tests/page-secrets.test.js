import test from 'node:test';
import assert from 'node:assert/strict';
import { pageText } from '../src/decisions/extract.js';
import { planSecretSync as planPageSecrets, makeSecretScanner } from '../src/secrets/sync.js';
import { makeConfluenceProcessor } from '../src/ingest/confluence-processor.js';

const S = (fp, name = 'AWS Access Key') => ({ name, severity: 4, fingerprint: fp, preview: 'AKIA****MPLE' });
const row = (id, fp, status = 'open', detail = null) => ({ id, fingerprint: fp, status, detail: detail && JSON.stringify(detail) });

test('pageText keeps code macro bodies and decodes entities', () => {
  const html = '<p>Run &amp; set</p><ac:structured-macro><ac:plain-text-body><![CDATA[export TOKEN=abc<d>ef]]></ac:plain-text-body></ac:structured-macro>';
  const t = pageText(html);
  assert.ok(t.includes('Run & set'));
  assert.ok(t.includes('export TOKEN=abc<d>ef'));
  assert.ok(!t.includes('CDATA'));
});

test('plan: new secret is an upsert and counts as changed', () => {
  const p = planPageSecrets([], [S('a')]);
  assert.equal(p.upserts.length, 1);
  assert.equal(p.upserts[0].existingId, null);
  assert.equal(p.changed, true);
});

test('plan: same secret seen again is not a change', () => {
  const p = planPageSecrets([row('r1', 'a', 'open', { inCurrentVersion: true })], [S('a')]);
  assert.equal(p.changed, false);
  assert.equal(p.markGone.length, 0);
});

test('plan: secret removed from the page stays open and is marked gone once', () => {
  const first = planPageSecrets([row('r1', 'a', 'open', { inCurrentVersion: true })], []);
  assert.deepEqual(first.markGone.map((g) => g.id), ['r1']);
  assert.equal(first.changed, true);
  const again = planPageSecrets([row('r1', 'a', 'open', { inCurrentVersion: false })], []);
  assert.equal(again.markGone.length, 0);
  assert.equal(again.changed, false);
});

test('plan: a removed secret that comes back is a change; resolved reopens; dismissed stays', () => {
  assert.equal(planPageSecrets([row('r1', 'a', 'open', { inCurrentVersion: false })], [S('a')]).changed, true);
  const reopen = planPageSecrets([row('r1', 'a', 'resolved')], [S('a')]);
  assert.equal(reopen.upserts[0].reopen, true);
  assert.equal(planPageSecrets([row('r1', 'a', 'dismissed')], [S('a')]).upserts.length, 0);
});

test('plan: bad detail JSON does not crash', () => {
  assert.doesNotThrow(() => planPageSecrets([{ id: 'r', fingerprint: 'a', status: 'open', detail: '{bad' }], []));
});

test('scanner: loads, plans, applies, reports', async () => {
  const calls = [];
  const seen = {};
  const scan = makeSecretScanner({
    load: async () => { calls.push('load'); return []; },
    apply: async (plan, ctx) => { calls.push('apply'); seen.ctx = ctx; },
    find: () => [S('a')],
  });
  const r = await scan({ sourceType: 'confluence_page', sourceId: '7', pageId: '7', title: 'T', version: 3, text: 'x' });
  assert.deepEqual(calls, ['load', 'apply']);
  assert.deepEqual(r, { changed: true, found: 1, opened: [] });
  assert.equal(seen.ctx.version, 3);
});

function harness({ page, scan = { changed: false }, failScan = false }) {
  const calls = [];
  const proc = makeConfluenceProcessor({
    fetchPage: async () => page,
    loadExisting: async () => [],
    apply: async () => calls.push('apply'),
    scanSecrets: async () => { calls.push('secrets'); if (failScan) throw new Error('db down'); return scan; },
    rescore: async () => calls.push('rescore'),
    recordIngest: async () => calls.push('record'),
  });
  return { proc, calls };
}
const page = { title: 'T', version: 1, decidedAt: null, storage: '<p>no decisions here at all</p>' };

test('page job: decisions, secrets, record; no rescore when nothing changed', async () => {
  const { proc, calls } = harness({ page });
  await proc({ sourceId: '9' });
  assert.deepEqual(calls, ['apply', 'secrets', 'record']);
});

test('page job: rescore runs once when secrets changed, before record', async () => {
  const { proc, calls } = harness({ page, scan: { changed: true } });
  await proc({ sourceId: '9' });
  assert.deepEqual(calls, ['apply', 'secrets', 'rescore', 'record']);
});

test('page job: scanner failure means the job is not recorded', async () => {
  const { proc, calls } = harness({ page, failScan: true });
  await assert.rejects(proc({ sourceId: '9' }), /db down/);
  assert.ok(!calls.includes('record'));
});

test('page job: deleted page does not scan secrets', async () => {
  const { proc, calls } = harness({ page: null });
  await proc({ sourceId: '9' });
  assert.ok(!calls.includes('secrets') && calls.includes('record'));
});
