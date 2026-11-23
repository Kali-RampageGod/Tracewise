import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, normalizePolicy, normalizeRules, ruleId } from '../src/gate/policy.js';
import { evaluateGate, severityFromPriority, findNotesLinks, confluencePageId } from '../src/gate/evaluate.js';
import { makeGateRunner } from '../src/gate/runner.js';
import { computeScore, DEFAULT_CONFIG } from '../src/score/engine.js';

const issue = (key, { done = false, priority = 'Medium', links = [] } = {}) => ({
  id: key.replace(/\D/g, ''), key,
  fields: {
    summary: 'Work ' + key, priority: { name: priority }, issuetype: { name: 'Task' },
    status: { name: done ? 'Done' : 'To Do', statusCategory: { key: done ? 'done' : 'new' } },
    issuelinks: links,
  },
});
const version = { id: '10001', name: 'v1.0', released: false, releaseDate: null };
const goodNotes = { links: [{ title: 'Notes', url: 'x', pageId: null }], pageState: {} };
const NOW = new Date('2026-12-10T10:00:00Z');

test('policy: defaults, junk and partial input', () => {
  assert.deepEqual(normalizePolicy(null), DEFAULT_POLICY);
  assert.deepEqual(normalizePolicy('{bad'), DEFAULT_POLICY);
  const p = normalizePolicy('{"flagOverdue":false,"requireReleaseNotes":"yes","extra":1}');
  assert.equal(p.flagOverdue, false);
  assert.equal(p.requireReleaseNotes, true);
  assert.equal('extra' in p, false);
});

test('priority maps to severity; unknown is medium', () => {
  assert.equal(severityFromPriority('Highest'), 4);
  assert.equal(severityFromPriority('BLOCKER'), 4);
  assert.equal(severityFromPriority('High'), 3);
  assert.equal(severityFromPriority('Lowest'), 1);
  assert.equal(severityFromPriority(undefined), 2);
  assert.equal(severityFromPriority('Weird'), 2);
});

test('release notes links and page ids', () => {
  const links = findNotesLinks([
    { category: 'Release notes', title: 'RN', url: 'https://a.atlassian.net/wiki/spaces/X/pages/12345/Title' },
    { category: 'Other', title: 'Spec', url: 'https://x' },
  ]);
  assert.equal(links.length, 1);
  assert.equal(links[0].pageId, '12345');
  assert.equal(confluencePageId('https://a/wiki/pages/viewpage.action?pageId=987'), '987');
  assert.equal(confluencePageId('https://example.com'), null);
  assert.deepEqual(findNotesLinks(null), []);
});

test('all done with notes: no findings, all pass', () => {
  const r = evaluateGate({ version, issues: [issue('T-1', { done: true })], notes: goodNotes, policy: DEFAULT_POLICY, now: NOW });
  assert.equal(r.findings.length, 0);
  assert.deepEqual(r.stats, { total: 1, done: 1, unfinished: 0, truncated: false });
  assert.ok(r.checks.every((c) => c.status === 'pass' || c.status === 'skipped'));
});

test('unfinished issues become findings with priority severity', () => {
  const r = evaluateGate({ version, issues: [issue('T-1', { priority: 'Highest' }), issue('T-2', { done: true }), issue('T-3', { priority: 'Low' })], notes: goodNotes, policy: DEFAULT_POLICY, now: NOW });
  const f = r.findings.filter((x) => x.detail.kind === 'unfinished');
  assert.deepEqual(f.map((x) => [x.key, x.severity]), [['unfinished:T-1', 4], ['unfinished:T-3', 1]]);
  assert.equal(r.checks[0].status, 'fail');
});

test('blocked link: counts only open blockers of unfinished items', () => {
  const open = { type: { inward: 'is blocked by' }, inwardIssue: { key: 'T-9', fields: { status: { name: 'To Do', statusCategory: { key: 'new' } } } } };
  const closed = { type: { inward: 'is blocked by' }, inwardIssue: { key: 'T-8', fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } } };
  const relates = { type: { inward: 'relates to' }, inwardIssue: { key: 'T-7', fields: { status: { statusCategory: { key: 'new' } } } } };
  const r = evaluateGate({ version, issues: [issue('T-1', { links: [open, closed, relates] })], notes: goodNotes, policy: DEFAULT_POLICY, now: NOW });
  const b = r.findings.filter((x) => x.detail.kind === 'blocked');
  assert.equal(b.length, 1);
  assert.equal(b[0].key, 'blocked:T-1:T-9');
  const off = evaluateGate({ version, issues: [issue('T-1', { links: [open] })], notes: goodNotes, policy: { ...DEFAULT_POLICY, flagBlockedLinks: false }, now: NOW });
  assert.equal(off.findings.filter((x) => x.detail.kind === 'blocked').length, 0);
});

test('release notes: missing, page missing, unverified, policy off', () => {
  const done = [issue('T-1', { done: true })];
  const run = (notes, policy = DEFAULT_POLICY) => evaluateGate({ version, issues: done, notes, policy, now: NOW });
  assert.equal(run({ links: [] }).findings[0].key, 'notes:missing');
  const withPage = (st) => run({ links: [{ title: 'RN', url: 'u', pageId: '5' }], pageState: { 5: st } });
  assert.equal(withPage('missing').findings[0].key, 'notes:page-missing:5');
  assert.equal(withPage('missing').findings[0].confidence, 90);
  assert.equal(withPage('unverified').findings.length, 0);
  assert.equal(withPage('unverified').checks.find((c) => c.key === 'notes').status, 'warn');
  assert.equal(withPage('ok').findings.length, 0);
  assert.equal(run({ links: [] }, { ...DEFAULT_POLICY, requireReleaseNotes: false }).findings.length, 0);
});

test('overdue: severity grows, no date or future date is fine', () => {
  const done = [issue('T-1', { done: true })];
  const run = (releaseDate) => evaluateGate({ version: { ...version, releaseDate }, issues: done, notes: goodNotes, policy: DEFAULT_POLICY, now: NOW });
  assert.equal(run('2026-12-09').findings[0].severity, 2);
  assert.equal(run('2026-12-09').findings[0].title, 'Release date passed 1 day ago');
  assert.equal(run('2026-11-01').findings[0].severity, 3);
  assert.equal(run('2026-12-10').findings.length, 0);
  assert.equal(run('2027-01-01').findings.length, 0);
  assert.equal(run(null).findings.length, 0);
});

test('empty version is flagged; released version has no checks', () => {
  const r = evaluateGate({ version, issues: [], notes: goodNotes, policy: DEFAULT_POLICY, now: NOW });
  assert.ok(r.findings.some((f) => f.key === 'empty'));
  const rel = evaluateGate({ version: { ...version, released: true }, issues: [issue('T-1')], notes: { links: [] }, policy: DEFAULT_POLICY, now: NOW });
  assert.equal(rel.released, true);
  assert.equal(rel.findings.length, 0);
});

test('engine: open critical gate item forces Blocked only when switched on', () => {
  const f = [{ id: 'a', title: 't', type: 'gate', severity: 4, status: 'open', evidence_confidence: 100 }];
  const on = computeScore(f, { ...DEFAULT_CONFIG, forceBlockGate: true });
  assert.equal(on.band, 'blocked');
  assert.equal(on.blockedReason, 'Critical work item still open');
  const off = computeScore(f);
  assert.equal(off.blockedReason, null);
  assert.equal(off.score, 75);
  const unclear = computeScore([{ ...f[0], evidence_confidence: 50 }], { ...DEFAULT_CONFIG, forceBlockGate: true });
  assert.equal(unclear.blockedReason, null);
});

function runner(over = {}) {
  const calls = [];
  const deps = {
    listVersions: async () => [version, { id: '10002', name: 'old', released: true }],
    readIssues: async () => ({ issues: [issue('T-1', { priority: 'Highest' })], truncated: false }),
    readRelatedWork: async () => [],
    checkPage: async () => 'ok',
    loadPolicy: async () => DEFAULT_POLICY,
    syncFindings: async (p, v, f) => calls.push(['sync', v, f.length]),
    assess: async (p, v, cfg) => { calls.push(['assess', v, cfg]); return { score: 60, band: 'blocked', blockedReason: 'x', breakdown: [] }; },
    getHistory: async () => [],
    now: () => NOW,
    ...over,
  };
  return { ...makeGateRunner(deps), calls };
}

test('runner: reads, syncs, then scores with the policy; returns blockers sorted', async () => {
  const r = runner();
  const out = await r.runGate('T', '10001');
  assert.equal(out.version.name, 'v1.0');
  assert.deepEqual(r.calls.map((c) => c[0]), ['sync', 'assess']);
  assert.deepEqual(r.calls[1][2], { forceBlockGate: true });
  assert.equal(out.blockers[0].severity, 4);
  assert.equal(out.score.band, 'blocked');
});

test('runner: invalid or unknown version', async () => {
  const r = runner();
  assert.match((await r.runGate('T', 'abc; DROP')).error, /Invalid/);
  assert.match((await r.runGate('T', '999')).error, /does not exist/);
  assert.equal(r.calls.length, 0);
});

test('runner: released version syncs empty so old gate findings close', async () => {
  const r = runner();
  const out = await r.runGate('T', '10002');
  assert.equal(out.released, true);
  assert.deepEqual(r.calls[0], ['sync', '10002', 0]);
});

test('runner: a Jira error stops before saving anything', async () => {
  const r = runner({ readIssues: async () => { throw new Error('API 503'); } });
  await assert.rejects(r.runGate('T', '10001'), /503/);
  assert.equal(r.calls.length, 0);
});

test('runner: release notes are only read when the policy needs them', async () => {
  let read = 0;
  const r = runner({ loadPolicy: async () => ({ ...DEFAULT_POLICY, requireReleaseNotes: false }), readRelatedWork: async () => { read++; return []; } });
  await r.runGate('T', '10001');
  assert.equal(read, 0);
});

test('refreshVersions: skips released, unknown and invalid ids; respects limit', async () => {
  const r = runner();
  assert.equal(await r.refreshVersions('T', ['10001', '10002', '999', 'x']), 1);
  assert.equal(r.calls.filter((c) => c[0] === 'assess').length, 1);
  assert.equal(await r.refreshVersions('T', []), 0);
});

test('policy: statuses and rules are cleaned, capped and get a stable id', () => {
  const p = normalizePolicy({ requiredStatuses: ' Done, done, Released ,, ', customRules: [
    { name: 'QA', jql: ' labels = qa ', severity: 9 }, { name: '', jql: 'x' }, { name: 'n', jql: '' }, null,
  ] });
  assert.deepEqual(p.requiredStatuses, ['Done', 'Released']);
  assert.equal(p.customRules.length, 1);
  assert.equal(p.customRules[0].severity, 3);
  assert.equal(p.customRules[0].jql, 'labels = qa');
  assert.equal(p.customRules[0].id, ruleId('labels = qa'));
  assert.equal(normalizeRules(Array.from({ length: 9 }, (_, i) => ({ name: 'n' + i, jql: 'j' + i }))).length, 5);
});

test('required statuses: only listed states count as ready', () => {
  const mk = (key, name, cat) => ({ ...issue(key), fields: { ...issue(key).fields, status: { name, statusCategory: { key: cat } } } });
  const issues = [mk('T-1', 'Done', 'done'), mk('T-2', 'Won\'t do', 'done')];
  const policy = normalizePolicy({ requiredStatuses: ['Done'] });
  const r = evaluateGate({ version, issues, notes: goodNotes, policy, now: NOW });
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].title, /T-2/);
  const plain = evaluateGate({ version, issues, notes: goodNotes, policy: DEFAULT_POLICY, now: NOW });
  assert.equal(plain.findings.length, 0);
});

test('custom rules: matches become findings, errors become a warning row', () => {
  const rule = normalizeRules([{ name: 'Needs QA', jql: 'labels = qa', severity: 3 }])[0];
  const r = evaluateGate({ version, issues: [issue('T-1', { done: true })], notes: goodNotes, policy: DEFAULT_POLICY, now: NOW,
    rules: [{ rule, issues: [issue('T-1', { done: true })] }, { rule: { ...rule, id: 'rbad', name: 'Bad' }, issues: [], error: 'nope' }] });
  const f = r.findings.find((x) => x.key === `rule:${rule.id}:T-1`);
  assert.ok(f); assert.equal(f.severity, 3);
  assert.equal(r.checks.find((c) => c.key === `rule:${rule.id}`).status, 'fail');
  assert.equal(r.checks.find((c) => c.key === 'rule:rbad').status, 'warn');
});

test('critical findings row: pass, fail, and off by policy', () => {
  const run = (criticalOpen, policy = DEFAULT_POLICY) =>
    evaluateGate({ version, issues: [issue('T-1', { done: true })], notes: goodNotes, policy, now: NOW, criticalOpen }).checks.find((c) => c.key === 'critical');
  assert.equal(run(0).status, 'pass');
  assert.equal(run(2).status, 'fail');
  assert.equal(run(null), undefined);
  assert.equal(run(2, { ...DEFAULT_POLICY, requireNoCriticalFindings: false }), undefined);
});

test('runner: rules run, a 400 is reported on its row, other errors stop the run', async () => {
  const rules = normalizeRules([{ name: 'A', jql: 'a = 1' }, { name: 'B', jql: 'b = 2' }]);
  const policy = { ...DEFAULT_POLICY, customRules: rules };
  const r = runner({
    loadPolicy: async () => policy,
    readRuleIssues: async (v, jql) => { if (jql === 'b = 2') { const e = new Error('bad'); e.status = 400; throw e; } return { issues: [issue('T-9')], truncated: false }; },
    countCritical: async () => 1,
  });
  const out = await r.runGate('TRAC', '10001');
  assert.equal(out.checks.find((c) => c.key === `rule:${rules[0].id}`).status, 'fail');
  assert.equal(out.checks.find((c) => c.key === `rule:${rules[1].id}`).status, 'warn');
  assert.equal(out.checks.find((c) => c.key === 'critical').status, 'fail');
  const boom = runner({ loadPolicy: async () => policy, readRuleIssues: async () => { const e = new Error('down'); e.status = 503; throw e; } });
  await assert.rejects(() => boom.runGate('TRAC', '10001'));
  assert.equal(boom.calls.length, 0);
});
