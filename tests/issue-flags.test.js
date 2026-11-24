import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeIssueFlags } from '../src/decisions/issue-flags.js';

const dec = { id: 'd1', page_id: '10', page_title: 'Decision: Forge SQL', decision_text: 'Use Forge SQL.', rationale: 'Relational', scope: 'storage', title: 'Forge SQL' };
const f = (id, decisionId, score) => ({ id, detail: JSON.stringify({ decisionId, shared: ['forge'], score }) });

test('flag carries the rationale and sorts by score', () => {
    const r = shapeIssueFlags([f('a', 'd1', 1), f('b', 'd1', 5)], [dec], new Map([['page:10', 'ok']]));
    assert.equal(r[0].findingId, 'b');
    assert.equal(r[0].rationale, 'Relational');
    assert.equal(r[0].pageId, '10');
});

test('restricted page hides the decision', () => {
    const r = shapeIssueFlags([f('a', 'd1', 1)], [dec], new Map([['page:10', 'no']]));
    assert.deepEqual(r, [{ findingId: 'a', restricted: true, score: 1 }]);
});

test('bad detail or missing decision is handled', () => {
    const r = shapeIssueFlags([{ id: 'x', detail: '{bad' }, { id: 'y', detail: null }, f('z', 'gone', 2)], [dec], new Map());
    assert.equal(r.length, 1);
    assert.equal(r[0].restricted, true);
});