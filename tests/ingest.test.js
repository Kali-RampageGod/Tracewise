import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../src/ingest/normalize.js';
import { handleJob, isRetriable, retryDelaySeconds } from '../src/ingest/handler.js';

const jiraUpdate = (clId, ts = '1795095035937') => ({
  eventType: 'avi:jira:updated:issue', selfGenerated: false, timestamp: ts,
  changelog: { id: clId, items: [] },
  issue: { id: '66400', key: 'TRAC-1', fields: { project: { key: 'TRAC' } } },
});

function makeDeps({ failTimes = 0 } = {}) {
  const done = new Set();
  const calls = [];
  let failures = failTimes;
  return {
    done, calls,
    isProcessed: async (k) => done.has(k),
    markProcessed: async (j) => { done.add(j.eventKey); },
    process: async (j) => {
      calls.push(j.eventKey);
      if (failures-- > 0) throw Object.assign(new Error('boom halfway'), { status: 503 });
    },
  };
}

test('normalize: jira update uses changelog id', () => {
  const j = normalizeEvent(jiraUpdate('243647'));
  assert.equal(j.eventKey, 'jira:66400:cl:243647');
  assert.equal(j.sourceId, '66400');
  assert.equal(j.projectKey, 'TRAC');
});

test('normalize: created, no-changelog fallback, self-generated, unknown', () => {
  assert.equal(normalizeEvent({ eventType: 'avi:jira:created:issue', timestamp: '1', issue: { id: '5', fields: {} } }).eventKey, 'jira:5:created');
  assert.equal(normalizeEvent({ eventType: 'avi:jira:updated:issue', timestamp: '99', issue: { id: '5', fields: {} } }).eventKey, 'jira:5:ts:99');
  assert.equal(normalizeEvent({ ...jiraUpdate('1'), selfGenerated: true }), null);
  assert.equal(normalizeEvent({ eventType: 'avi:something:else' }), null);
  assert.equal(normalizeEvent(null), null);
});

test('same event delivered 3 times is processed once', async () => {
  const deps = makeDeps();
  const job = normalizeEvent(jiraUpdate('243647'));
  const r = [await handleJob(job, deps), await handleJob(job, deps), await handleJob(job, deps)];
  assert.deepEqual(r.map((x) => x.status), ['processed', 'duplicate', 'duplicate']);
  assert.equal(deps.calls.length, 1);
});

test('two different updates to one issue are both processed', async () => {
  const deps = makeDeps();
  await handleJob(normalizeEvent(jiraUpdate('243647')), deps);
  await handleJob(normalizeEvent(jiraUpdate('243648', '1795095520041')), deps);
  assert.deepEqual(deps.calls, ['jira:66400:cl:243647', 'jira:66400:cl:243648']);
});

test('late, out-of-order delivery still processes each event exactly once', async () => {
  const deps = makeDeps();
  const b = normalizeEvent(jiraUpdate('243648', '2'));
  const a = normalizeEvent(jiraUpdate('243647', '1'));
  await handleJob(b, deps); await handleJob(a, deps); await handleJob(b, deps);
  assert.equal(deps.calls.length, 2);
});

test('failure halfway is not marked processed, and the retry succeeds', async () => {
  const deps = makeDeps({ failTimes: 1 });
  const job = normalizeEvent(jiraUpdate('243647'));
  await assert.rejects(() => handleJob(job, deps), /boom halfway/);
  assert.equal(deps.done.has(job.eventKey), false);
  assert.equal((await handleJob(job, deps)).status, 'processed');
  assert.equal(deps.calls.length, 2);
});

test('two workers on the same source: duplicate work is harmless', async () => {
  const state = new Map();
  const deps = makeDeps();
  deps.process = async (j) => { await new Promise((r) => setTimeout(r, 5)); state.set(j.sourceId, j.eventKey); };
  const job = normalizeEvent(jiraUpdate('243647'));
  await Promise.all([handleJob(job, deps), handleJob(job, deps)]);
  assert.equal(state.size, 1);
  assert.equal(state.get('66400'), job.eventKey);
});

test('retry classification and backoff', () => {
  assert.equal(isRetriable({ status: 429 }), true);
  assert.equal(isRetriable({ status: 503 }), true);
  assert.equal(isRetriable(new Error('fetch failed')), true);
  assert.equal(isRetriable({ status: 400, message: 'bad' }), false);
  assert.deepEqual([0, 1, 2, 3, 10].map(retryDelaySeconds), [30, 60, 120, 240, 900]);
});