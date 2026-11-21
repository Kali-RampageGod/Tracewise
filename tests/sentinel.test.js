import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, findSecrets } from '../src/secrets/sentinel.js';

const AWS = 'AKIAIOSFODNN7EXAMPLE';

test('redact keeps first 4 and last 4 only', () => {
    assert.equal(redact(AWS), 'AKIA****MPLE');
    assert.equal(redact('short'), '****');
});

test('finds an AWS key and never returns the real secret', () => {
    const f = findSecrets(`deploy failed, key is ${AWS} please check`);
    assert.equal(f.length, 1);
    assert.equal(f[0].name, 'AWS Access Key');
    assert.equal(f[0].severity, 4);
    assert.equal(f[0].preview, 'AKIA****MPLE');
    assert.ok(!JSON.stringify(f).includes(AWS));
});

test('same secret twice gives one finding', () => {
    assert.equal(findSecrets(`${AWS} and again ${AWS}`).length, 1);
});

test('finds a generic api key with lower severity', () => {
    const f = findSecrets('api_key = abcd1234efgh5678ijkl');
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 3);
});

test('clean text and empty input give nothing', () => {
    assert.equal(findSecrets('Please update the login page').length, 0);
    assert.equal(findSecrets(null).length, 0);
});

// Built in pieces on purpose: a full fake key in the file could make GitHub block your push.
test('finds Google, Slack and Stripe keys', () => {
    const google = 'AIza' + 'a'.repeat(35);
    const slack = 'xox' + 'b-' + '1'.repeat(12);
    const stripe = 'sk_' + 'live_' + 'a'.repeat(24);
    const f = findSecrets(`${google} ${slack} ${stripe}`);
    assert.deepEqual(f.map((x) => x.name).sort(), ['Google API Key', 'Slack Token', 'Stripe Live Key']);
});