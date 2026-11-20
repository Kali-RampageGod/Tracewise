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