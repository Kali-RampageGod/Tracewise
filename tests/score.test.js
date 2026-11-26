import test from 'node:test';
import assert from 'node:assert/strict';
import { computeScore, DEFAULT_CONFIG } from '../src/score/engine.js';

// Helper: builds one finding. Override only what the test cares about.
let n = 0;
const f = (o = {}) => ({
  id: 'f' + ++n, title: 'finding ' + n, type: 'gate', severity: 3,
  status: 'open', evidence_confidence: 100, ...o,
});

test('no findings: 100 and ready', () => {
  const r = computeScore([]);
  assert.equal(r.score, 100);
  assert.equal(r.band, 'ready');
  assert.equal(r.blockedReason, null);
});

test('one confirmed high finding takes 10 points', () => {
  const r = computeScore([f({ severity: 3 })]);
  assert.equal(r.score, 90);
  assert.equal(r.breakdown.length, 1);
  assert.equal(r.breakdown[0].points, 10);
});

test('unclear evidence (50) takes 25% of 10 = 2.5, score rounds to 98', () => {
  const r = computeScore([f({ severity: 3, evidence_confidence: 50 })]);
  assert.equal(r.score, 98);
});

test('very unclear evidence (20) takes nothing and is not listed', () => {
  const r = computeScore([f({ severity: 4, evidence_confidence: 20 })]);
  assert.equal(r.score, 100);
  assert.equal(r.breakdown.length, 0);
});

test('resolved and dismissed findings are ignored', () => {
  const r = computeScore([f({ status: 'resolved' }), f({ status: 'dismissed' })]);
  assert.equal(r.score, 100);
});

test('per-type cap: three critical conflicts take 30, not 75', () => {
  const list = [1, 2, 3].map(() => f({ type: 'decision_conflict', severity: 4 }));
  const r = computeScore(list);
  assert.equal(r.score, 70);
  assert.equal(r.breakdown.length, 2); // third one is fully capped
});

test('confirmed critical secret forces blocked even with a good score', () => {
  const r = computeScore([f({ type: 'secret', severity: 4 })]);
  assert.equal(r.score, 75);
  assert.equal(r.band, 'blocked');
  assert.equal(r.blockedReason, 'Critical secret found');
});

test('unclear critical secret does not force blocked', () => {
  const r = computeScore([f({ type: 'secret', severity: 4, evidence_confidence: 60 })]);
  assert.equal(r.score, 94); // 25 * 0.25 = 6.25
  assert.equal(r.band, 'ready');
});

test('band edges: 80 is ready, 78 is at_risk, 50 is at_risk', () => {
  const noCap = { ...DEFAULT_CONFIG, readyBlockedBySeverity: 0 }; // test the score lines alone
  assert.equal(computeScore([f(), f()], noCap).band, 'ready'); // 100-20 = 80
  const r78 = computeScore([f(), f(), f({ severity: 1 })], noCap); // 100-22
  assert.equal(r78.score, 78);
  assert.equal(r78.band, 'at_risk');
  const r50 = computeScore([
    f({ type: 'gate', severity: 4 }),
    f({ type: 'decision_conflict', severity: 4 }),
  ]);
  assert.equal(r50.score, 50);
  assert.equal(r50.band, 'at_risk');
});

test('below 50 is blocked, with no blocked reason', () => {
  const r = computeScore([
    f({ type: 'gate', severity: 4 }),
    f({ type: 'decision_conflict', severity: 4 }),
    f({ type: 'other', severity: 4 }),
  ]);
  assert.equal(r.score, 25);
  assert.equal(r.band, 'blocked');
  assert.equal(r.blockedReason, null);
});

test('score never goes below 0', () => {
  const list = [
    ...[1, 2, 3].map(() => f({ type: 'secret', severity: 4 })),
    ...[1, 2].map(() => f({ type: 'gate', severity: 4 })),
    ...[1, 2, 3].map(() => f({ type: 'decision_conflict', severity: 4 })),
    ...[1, 2].map(() => f({ type: 'other', severity: 4 })),
  ];
  assert.equal(computeScore(list).score, 0);
});
test('a confirmed high finding caps Ready at At risk, whatever the score', () => {
  const r = computeScore([f()]); // 100-10 = 90 would be ready
  assert.equal(r.score, 90);
  assert.equal(r.band, 'at_risk');
  assert.equal(r.blockedReason, 'A high-severity finding is still open');
});

test('medium and low findings do not cap Ready', () => {
  assert.equal(computeScore([f({ severity: 2 }), f({ severity: 1 })]).band, 'ready');
});

test('an unclear high finding does not cap Ready', () => {
  const r = computeScore([f({ evidence_confidence: 60 })]);
  assert.equal(r.band, 'ready');
  assert.equal(r.blockedReason, null);
});

test('a closed high finding does not cap Ready', () => {
  assert.equal(computeScore([f({ status: 'resolved' }), f({ status: 'dismissed' })]).band, 'ready');
});

test('the cap can be switched off, and a forced block keeps its own reason', () => {
  assert.equal(computeScore([f()], { ...DEFAULT_CONFIG, readyBlockedBySeverity: 0 }).band, 'ready');
  const r = computeScore([f({ type: 'secret', severity: 4 })]);
  assert.equal(r.band, 'blocked');
  assert.equal(r.blockedReason, 'Critical secret found');
});

test('a score already at risk keeps its band and gets no cap reason', () => {
  const r = computeScore([f(), f(), f(), f()]); // 100-40 = 60
  assert.equal(r.band, 'at_risk');
  assert.equal(r.blockedReason, null);
});
