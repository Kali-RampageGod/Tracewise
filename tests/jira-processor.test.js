import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJiraProcessor } from '../src/ingest/jira-processor.js';
import { handleJob } from '../src/ingest/handler.js';

const job = { sourceType: 'jira_issue', sourceId: '66400', sourceRef: 'TRAC-1', projectKey: 'TRAC', eventKey: 'jira:66400:cl:1', eventType: 'x' };

function setup(scanImpl) {
  const calls = [];
  const p = makeJiraProcessor({
    scanIssue: async (...a) => { calls.push(['scan', ...a]); if (scanImpl) return scanImpl(); },
    recordIngest: async (...a) => { calls.push(['record', a[0].eventKey, a[1]]); },
  });
  return { p, calls };
}

test('scans the issue, then records ingest', async () => {
  const { p, calls } = setup();
  await p(job);
  assert.deepEqual(calls, [['scan', 'TRAC', 'TRAC-1'], ['record', 'jira:66400:cl:1', 'ingest_jira']]);
});

test('deleted issue (404) is skipped but still recorded', async () => {
  const { p, calls } = setup(() => { throw Object.assign(new Error('gone'), { status: 404 }); });
  await p(job);
  assert.equal(calls.at(-1)[0], 'record');
});

test('server error is rethrown and nothing is recorded (so the job retries)', async () => {
  const { p, calls } = setup(() => { throw Object.assign(new Error('boom'), { status: 503 }); });
  await assert.rejects(() => p(job), /boom/);
  assert.equal(calls.filter((c) => c[0] === 'record').length, 0);
});

test('permission error (403) is rethrown, not swallowed', async () => {
  const { p } = setup(() => { throw Object.assign(new Error('no access'), { status: 403 }); });
  await assert.rejects(() => p(job), /no access/);
});

test('job without an issue key fails loudly', async () => {
  const { p } = setup();
  await assert.rejects(() => p({ ...job, sourceRef: null }), /no issue key/);
});

test('missing projectKey is passed as null so the scan can look it up', async () => {
  const { p, calls } = setup();
  await p({ ...job, projectKey: null });
  assert.deepEqual(calls[0], ['scan', null, 'TRAC-1']);
});

test('end to end with idempotency: same event twice scans once; failure then retry scans twice', async () => {
  let fail = true;
  const { p, calls } = setup(() => { if (fail) { fail = false; throw Object.assign(new Error('503'), { status: 503 }); } });
  const done = new Set();
  const deps = { isProcessed: async (k) => done.has(k), markProcessed: async (j) => done.add(j.eventKey), process: p };
  await assert.rejects(() => handleJob(job, deps));       // first try fails
  assert.equal((await handleJob(job, deps)).status, 'processed'); // retry works
  assert.equal((await handleJob(job, deps)).status, 'duplicate'); // redelivery skipped
  assert.equal(calls.filter((c) => c[0] === 'scan').length, 2);
});