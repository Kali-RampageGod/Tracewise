import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBlocks, extractDecisions, isDecision, MAX_DECISIONS_PER_PAGE } from '../src/decisions/extract.js';
import { planSync, planRemoval } from '../src/decisions/sync.js';
import { makeConfluenceProcessor } from '../src/ingest/confluence-processor.js';

const D = 'We decided to use Forge SQL instead of Forge storage for findings.';

test('extract: entities, nested li>p, local-id kept', () => {
  const html = `<ul><li><p local-id="a1">We decided &amp; agreed: use <strong>SQL</strong> &quot;only&quot;.</p></li></ul>`;
  const b = extractBlocks(html);
  assert.equal(b.length, 1);
  assert.equal(b[0].blockId, 'a1');
  assert.equal(b[0].text, 'We decided & agreed: use SQL "only".');
});

test('extract: no local-id gives stable hash id; only decision-like text kept', () => {
  const html = `<p>Meeting notes for Tuesday afternoon.</p><p>${D}</p>`;
  const a = extractDecisions(html);
  const b = extractDecisions(html);
  assert.equal(a.length, 1);
  assert.equal(a[0].blockId, b[0].blockId);
  assert.match(a[0].blockId, /^h-/);
});

test('extract: dedupes same block id, caps count, rejects too short/long', () => {
  assert.equal(extractDecisions(`<p local-id="x">${D}</p><p local-id="x">${D}</p>`).length, 1);
  const many = Array.from({ length: 150 }, (_, i) => `<p local-id="b${i}">${D} #${i}</p>`).join('');
  assert.equal(extractDecisions(many).length, MAX_DECISIONS_PER_PAGE);
  assert.equal(isDecision('decided'), false);
  assert.equal(isDecision('We decided ' + 'x'.repeat(1000)), false);
});

const row = (id, block, hash, version, status = 'active') => ({ id, block_id: block, content_hash: hash, page_version: version, status });
const dec = (blockId, hash) => ({ blockId, text: 't', hash });

test('plan: first ingest upserts, supersedes nothing', () => {
  const p = planSync([], { version: 1, decisions: [dec('a', 'h1')] });
  assert.equal(p.upserts.length, 1);
  assert.equal(p.upserts[0].supersedesId, null);
  assert.deepEqual(p.supersedeIds, []);
});

test('plan: re-running same version is idempotent (no supersede of own row)', () => {
  const p = planSync([row('r1', 'a', 'h1', 1)], { version: 1, decisions: [dec('a', 'h1')] });
  assert.deepEqual(p.keep, [{ id: 'r1' }]);
  assert.deepEqual(p.upserts, []);
  assert.deepEqual(p.supersedeIds, []);
});

test('plan: unchanged decision on new version is kept, not duplicated', () => {
  const p = planSync([row('r1', 'a', 'h1', 1)], { version: 2, decisions: [dec('a', 'h1')] });
  assert.deepEqual(p.keep, [{ id: 'r1' }]);
  assert.deepEqual(p.upserts, []);
});

test('plan: edited decision links to and supersedes the old row', () => {
  const p = planSync([row('r1', 'a', 'h1', 1)], { version: 2, decisions: [dec('a', 'h2')] });
  assert.equal(p.upserts[0].supersedesId, 'r1');
  assert.deepEqual(p.supersedeIds, ['r1']);
});

test('plan: edit re-run at same version rewrites in place, old row stays superseded once', () => {
  const existing = [row('r1', 'a', 'h1', 1, 'superseded'), row('r2', 'a', 'h2', 2)];
  const p = planSync(existing, { version: 2, decisions: [dec('a', 'h2')] });
  assert.deepEqual(p.keep, [{ id: 'r2' }]);
  assert.deepEqual(p.supersedeIds, []);
});

test('plan: removed block is superseded', () => {
  const p = planSync([row('r1', 'a', 'h1', 1)], { version: 2, decisions: [] });
  assert.deepEqual(p.supersedeIds, ['r1']);
});

test('plan: stale job (stored data newer) does nothing', () => {
  const p = planSync([row('r1', 'a', 'h1', 5)], { version: 3, decisions: [] });
  assert.equal(p.stale, true);
  assert.deepEqual(p.supersedeIds, []);
});

test('plan: text reverted to an older wording reactivates', () => {
  const existing = [row('r1', 'a', 'h1', 1, 'superseded')];
  const p = planSync(existing, { version: 2, decisions: [dec('a', 'h1')] });
  assert.deepEqual(p.keep, [{ id: 'r1' }]);
});

test('plan: removal supersedes all active', () => {
  const p = planRemoval([row('r1', 'a', 'h', 1), row('r2', 'b', 'h', 1, 'superseded')]);
  assert.deepEqual(p.supersedeIds, ['r1']);
});

function harness({ page, existing = [], failFetch = false }) {
  const calls = [];
  const proc = makeConfluenceProcessor({
    fetchPage: async () => { calls.push('fetch'); if (failFetch) throw new Error('API 503'); return page; },
    loadExisting: async () => { calls.push('load'); return existing; },
    apply: async (plan, ctx) => { calls.push('apply'); calls.plan = plan; calls.ctx = ctx; },
    recordIngest: async () => calls.push('record'),
  });
  return { proc, calls };
}
const job = { sourceId: '42', occurredAt: 1 };

test('processor: normal page applies then records, in order', async () => {
  const { proc, calls } = harness({ page: { title: 'T', version: 2, decidedAt: null, storage: `<p local-id="a">${D}</p>` } });
  await proc(job);
  assert.deepEqual(calls.slice(0), ['load', 'fetch', 'apply', 'record']);
  assert.equal(calls.ctx.version, 2);
});

test('processor: deleted page supersedes everything', async () => {
  const { proc, calls } = harness({ page: null, existing: [row('r1', 'a', 'h', 1)] });
  await proc(job);
  assert.deepEqual(calls.plan.supersedeIds, ['r1']);
  assert.ok(calls.includes('record'));
});

test('processor: fetch error propagates and nothing is recorded', async () => {
  const { proc, calls } = harness({ failFetch: true });
  await assert.rejects(proc(job), /503/);
  assert.ok(!calls.includes('record') && !calls.includes('apply'));
});

test('processor: stale plan skips apply but still records', async () => {
  const { proc, calls } = harness({ page: { title: 'T', version: 1, storage: '' }, existing: [row('r1', 'a', 'h', 9)] });
  await proc(job);
  assert.ok(!calls.includes('apply') && calls.includes('record'));
});

test('processor: job without page id is rejected', async () => {
  const { proc } = harness({ page: null });
  await assert.rejects(proc({}), /no page id/);
});

const T = (rows) => `<table><tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td><p>${v}</p></td></tr>`).join('')}</tbody></table>`;

test('template: fields parsed, table not read twice', () => {
  const d = extractDecisions(T([['Decision', 'We decided to use Forge SQL.'], ['Status', 'Active'],
  ['Scope', 'storage'], ['Rationale', 'Relational queries'], ['Date', '2026-11-20']]));
  assert.equal(d.length, 1);
  assert.equal(d[0].scope, 'storage');
  assert.equal(d[0].rationale, 'Relational queries');
  assert.equal(d[0].decidedOn, '2026-11-20');
});

test('template: non-active status raises nothing; rationale edit changes hash', () => {
  assert.equal(extractDecisions(T([['Decision', 'Use Redis for the queue.'], ['Status', 'Superseded']])).length, 0);
  const a = extractDecisions(T([['Decision', 'Use Redis for the queue.'], ['Rationale', 'fast']]));
  const b = extractDecisions(T([['Decision', 'Use Redis for the queue.'], ['Rationale', 'cheap']]));
  assert.equal(a[0].blockId, b[0].blockId);
  assert.notEqual(a[0].hash, b[0].hash);
});
