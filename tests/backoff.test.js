import test from 'node:test';
import assert from 'node:assert/strict';
import { withBackoff } from '../src/backoff.js';

const res = (status, retryAfter) => ({ status, headers: { get: (h) => (h === 'retry-after' && retryAfter ? String(retryAfter) : null) } });
function seq(statuses) {
  let i = 0;
  const call = async () => res(statuses[Math.min(i++, statuses.length - 1)]);
  return { call, count: () => i };
}
const fast = (waits, extra = {}) => ({ sleep: async (ms) => waits.push(ms), random: () => 1, ...extra });

test('returns success at once, never sleeps', async () => {
  const waits = []; const s = seq([200]);
  assert.equal((await withBackoff(s.call, fast(waits))).status, 200);
  assert.equal(s.count(), 1);
  assert.deepEqual(waits, []);
});

test('non-retryable errors are returned without retry', async () => {
  for (const code of [400, 401, 403, 404, 500]) {
    const s = seq([code]);
    assert.equal((await withBackoff(s.call, fast([]))).status, code);
    assert.equal(s.count(), 1);
  }
});

test('retries 429 and 5xx gateway errors with growing waits, then succeeds', async () => {
  const waits = []; const s = seq([429, 503, 504, 200]);
  assert.equal((await withBackoff(s.call, fast(waits))).status, 200);
  assert.deepEqual(waits, [400, 800, 1600]);
});

test('wait is capped at maxMs', async () => {
  const waits = []; const s = seq([503, 503, 503, 503, 200]);
  await withBackoff(s.call, fast(waits, { baseMs: 4000, maxMs: 6000, budgetMs: 1e9, maxAttempts: 9 }));
  assert.deepEqual(waits, [4000, 6000, 6000, 6000]);
});

test('Retry-After header wins over the computed wait', async () => {
  const waits = []; let i = 0;
  const call = async () => (i++ === 0 ? res(429, 3) : res(200));
  await withBackoff(call, fast(waits));
  assert.deepEqual(waits, [3000]);
});

test('gives up after maxAttempts and returns the last failure', async () => {
  const s = seq([503]);
  assert.equal((await withBackoff(s.call, fast([], { maxAttempts: 3 }))).status, 503);
  assert.equal(s.count(), 3);
});

test('stops when the next wait would pass the time budget', async () => {
  const waits = []; const s = seq([503]);
  let t = 0;
  const r = await withBackoff(s.call, fast(waits, { budgetMs: 1000, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } }));
  assert.equal(r.status, 503);
  assert.deepEqual(waits, [400]); // 400 fits, then 800 would pass 1000
  assert.equal(s.count(), 2);
});

test('jitter keeps the wait between half and full backoff', async () => {
  const waits = []; const s = seq([503, 200]);
  await withBackoff(s.call, fast(waits, { random: () => 0 }));
  assert.deepEqual(waits, [200]);
});
