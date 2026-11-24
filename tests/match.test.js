import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, findMatches } from '../src/decisions/match.js';

const mysql = {
    id: 'd1', status: 'active',
    page_title: 'Decision: Use MySQL, not MongoDB',
    decision_text: 'We will use MySQL as the database. We will not use MongoDB.',
};

test('tokenize drops small words and short words, lowercases', () => {
    const t = tokenize('We will Use the MongoDB and a DB');
    assert.deepEqual([...t], ['mongodb']);
});

test('tokenize handles empty input', () => {
    assert.equal(tokenize('').size, 0);
    assert.equal(tokenize(null).size, 0);
});

test('tokenize cuts trailing dots', () => {
    assert.ok(tokenize('MongoDB.').has('mongodb'));
});

test('contradicting issue matches the decision', () => {
    const r = findMatches('Set up MongoDB for the orders database. Create a MongoDB cluster.', [mysql]);
    assert.equal(r.length, 1);
    assert.equal(r[0].decision.id, 'd1');
    assert.deepEqual(r[0].shared.sort(), ['database', 'mongodb']);
});

test('unrelated issue does not match', () => {
    assert.equal(findMatches('Fix the login button colour on the home page', [mysql]).length, 0);
});

test('one shared word is not enough (default minOverlap is 2)', () => {
    assert.equal(findMatches('Back up the database every night', [mysql]).length, 0);
});

test('minOverlap can be lowered', () => {
    assert.equal(findMatches('Back up the database every night', [mysql], 1).length, 1);
});

test('superseded decisions are ignored', () => {
    const old = { ...mysql, status: 'superseded' };
    assert.equal(findMatches('Set up MongoDB for the orders database', [old]).length, 0);
});

test('best match comes first and only 3 are returned', () => {
    const mk = (id, text) => ({ id, status: 'active', page_title: '', decision_text: text });
    const list = [
        mk('a', 'mongodb database cluster'),
        mk('b', 'mongodb database'),
        mk('c', 'mongodb database cluster orders'),
        mk('d', 'mongodb database orders cluster sharding'),
    ];
    const r = findMatches('mongodb database cluster orders sharding', list);
    assert.equal(r.length, 3);
    assert.equal(r[0].decision.id, 'd');
    assert.ok(r[0].score >= r[1].score && r[1].score >= r[2].score);
});

test('BM25: the decision about the rarer shared words ranks first', () => {
    const sql = { id: 'd2', status: 'active', page_title: 'Decision: Forge SQL', decision_text: 'We will use Forge SQL for findings storage.' };
    const other = { id: 'd3', status: 'active', page_title: 'Decision: Storage', decision_text: 'We keep findings storage simple and storage cheap.' };
    const r = findMatches('Move findings storage to Redis, forge sql is slow', [other, sql, mysql]);
    assert.equal(r[0].decision.id, 'd2');
    assert.ok(r[0].score > r[1].score);
});

test('BM25: score is positive; superseded, empty query and empty list give nothing', () => {
    const r = findMatches('Set up MongoDB for the orders database', [mysql]);
    assert.ok(r[0].score > 0);
    assert.equal(findMatches('Set up MongoDB for the orders database', [{ ...mysql, status: 'superseded' }]).length, 0);
    assert.equal(findMatches('', [mysql]).length, 0);
    assert.equal(findMatches('MongoDB database', []).length, 0);
});

const mkDec = (id, extra = {}) => ({
    id, status: 'active', page_title: 'Decision: ' + id,
    decision_text: 'We will use Forge SQL for findings storage.', ...extra
});
const QUERY = 'Move findings storage off forge sql';

test('boost: matching scope ranks a decision higher', () => {
    const r = findMatches(QUERY, [mkDec('a'), mkDec('b', { scope: 'storage' })]);
    assert.equal(r[0].decision.id, 'b');
});

test('boost: newer decision ranks above an old one, project key counts', () => {
    const now = Date.parse('2026-12-06');
    const r = findMatches(QUERY, [mkDec('old', { decided_at: '2024-01-01' }), mkDec('new', { decided_at: '2026-12-01' })], { now });
    assert.equal(r[0].decision.id, 'new');
    const p = findMatches(QUERY, [mkDec('x'), mkDec('y', { project_key: 'TRAC' })], { projectKey: 'TRAC' });
    assert.equal(p[0].decision.id, 'y');
});

test('threshold: minScore drops weak matches; top 3 only', () => {
    assert.equal(findMatches(QUERY, [mkDec('a')], { minScore: 999 }).length, 0);
    assert.equal(findMatches(QUERY, [mkDec('a'), mkDec('b'), mkDec('c'), mkDec('d')]).length, 3);
});

test('scope and rationale are searchable', () => {
    const d = { id: 'r', status: 'active', page_title: 'X', decision_text: 'Chosen option approved.', rationale: 'Relational queries' };
    assert.equal(findMatches('Need relational queries chosen', [d]).length, 1);
});