import test from 'node:test';
import assert from 'node:assert/strict';
import { planSync } from '../src/decisions/sync.js';

const cur = { version: 3, decisions: [{ blockId: 'b1', text: 'Use MySQL', hash: 'h1' }] };
const row = (over) => ({ id: 'd1', block_id: 'b1', content_hash: 'h1', page_version: 2, status: 'active', manual: 0, ...over });

test('a decision superseded by a person stays superseded when the page is unchanged', () => {
  const p = planSync([row({ status: 'superseded', manual: 1 })], cur);
  assert.deepEqual(p.keep, []);
  assert.deepEqual(p.supersedeIds, []);
  assert.deepEqual(p.upserts, []);
});

test('a decision superseded by the page itself still comes back when the wording returns', () => {
  const p = planSync([row({ status: 'superseded', manual: 0 })], cur);
  assert.deepEqual(p.keep, [{ id: 'd1' }]);
});

test('an active decision is kept as before', () => {
  assert.deepEqual(planSync([row()], cur).keep, [{ id: 'd1' }]);
});

test('an edited page replaces a manually superseded decision with a new row', () => {
  const p = planSync([row({ status: 'superseded', manual: 1 })], { version: 3, decisions: [{ blockId: 'b1', text: 'Use Postgres', hash: 'h2' }] });
  assert.equal(p.upserts.length, 1);
  assert.equal(p.upserts[0].supersedesId, 'd1');
});