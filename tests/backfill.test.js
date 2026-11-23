import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackfill } from '../src/secrets/backfill.js';

const make = (cfg, ids = ['a', 'b']) => {
  const calls = [];
  const run = makeBackfill({
    getConfig: async () => cfg,
    listWithoutIssue: async (n) => { calls.push(['list', n]); return ids; },
    enqueue: async (x) => calls.push(['enqueue', x]),
  });
  return { run, calls };
};

test('backfill: queues findings without an issue when remediation is on', async () => {
  const { run, calls } = make({ enabled: true, projectKey: 'TRAC' });
  assert.deepEqual(await run(), { queued: 2 });
  assert.deepEqual(calls, [['list', 20], ['enqueue', ['a', 'b']]]);
});

test('backfill: does nothing when remediation is off, unset or has no project', async () => {
  for (const cfg of [null, { enabled: false, projectKey: 'T' }, { enabled: true, projectKey: null }]) {
    const { run, calls } = make(cfg);
    assert.deepEqual(await run(), { queued: 0 });
    assert.equal(calls.length, 0);
  }
});

test('backfill: nothing to queue means no queue call', async () => {
  const { run, calls } = make({ enabled: true, projectKey: 'T' }, []);
  assert.deepEqual(await run(), { queued: 0 });
  assert.deepEqual(calls, [['list', 20]]);
});
