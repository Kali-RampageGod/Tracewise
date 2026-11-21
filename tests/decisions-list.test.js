import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_SIZE, parseStatus, groupConflicts, shapeDecisions } from '../src/decisions/list.js';

const row = (id, status = 'active') => ({ id, page_id: 'p', page_title: 'T', page_version: 1, decision_text: 'txt ' + id, status, decided_at: null });
const finding = (decisionId, issueKey) => ({ title: issueKey + ' may contradict', detail: JSON.stringify({ decisionId, issueKey }) });

test('parseStatus defaults to active', () => {
  assert.equal(parseStatus('bogus'), 'active');
  assert.equal(parseStatus(undefined), 'active');
  assert.equal(parseStatus('all'), 'all');
  assert.equal(parseStatus('superseded'), 'superseded');
});

test('groupConflicts skips broken or unrelated detail', () => {
  const m = groupConflicts([finding('d1', 'TRAC-1'), finding('d1', 'TRAC-2'), { title: 'x', detail: '{bad' }, { title: 'y', detail: null }, { title: 'z', detail: '{}' }]);
  assert.equal(m.get('d1').length, 2);
  assert.equal(m.size, 1);
});

test('shape: pagination flag, replacement and conflicts attach to the right row', () => {
  const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => row('d' + i));
  rows[0] = row('d0', 'superseded');
  const out = shapeDecisions(rows, [{ id: 'n1', supersedes_id: 'd0', decision_text: 'new', page_version: 2 }], [finding('d1', 'TRAC-9')]);
  assert.equal(out.hasMore, true);
  assert.equal(out.rows.length, PAGE_SIZE);
  assert.equal(out.rows[0].replacedBy.text, 'new');
  assert.equal(out.rows[1].conflicts[0].issueKey, 'TRAC-9');
  assert.equal(out.rows[2].conflicts.length, 0);
});

test('shape: empty input', () => {
  assert.deepEqual(shapeDecisions([], [], []), { hasMore: false, rows: [] });
});
