import test from 'node:test';
import assert from 'node:assert/strict';
import { planAction } from '../src/decisions/actions.js';

test('unknown action is rejected', () => {
  assert.equal(planAction('nope').error, 'Unknown action');
});

test('confirm keeps finding open with full confidence', () => {
  const p = planAction('confirm');
  assert.equal(p.findingStatus, 'open');
  assert.equal(p.confidence, 100);
});

test('dismiss needs a reason', () => {
  assert.equal(planAction('dismiss', { comment: ' ' }).error, 'Add a short reason');
  const p = planAction('dismiss', { comment: 'Not related' });
  assert.equal(p.findingStatus, 'dismissed');
  assert.equal(p.comment, 'Not related');
});

test('dismiss comment is cut to 500 characters', () => {
  const p = planAction('dismiss', { comment: 'x'.repeat(600) });
  assert.equal(p.comment.length, 500);
});

test('amend needs new text and closes the finding', () => {
  assert.equal(planAction('amend', {}).error, 'New decision text needed');
  const p = planAction('amend', { newText: 'Use Postgres' });
  assert.equal(p.findingStatus, 'resolved');
  assert.equal(p.newText, 'Use Postgres');
});

test('supersede marks the decision superseded', () => {
  const p = planAction('supersede');
  assert.equal(p.decisionStatus, 'superseded');
  assert.equal(p.findingStatus, 'resolved');
});