import test from 'node:test';
import assert from 'node:assert/strict';
import { findSecrets, redact } from '../src/secrets/sentinel.js';
import { entropy, isPlaceholder, looksLikeSecretValue } from '../src/secrets/entropy.js';
import { POSITIVES, NEGATIVES } from './fixtures/secrets.js';

for (const p of POSITIVES) {
    test(`true positive: ${p.name} in "${p.text('<S>').slice(0, 40)}"`, () => {
        const text = p.text(p.secret);
        const f = findSecrets(text);
        assert.ok(f.some((x) => x.name === p.name), `expected ${p.name}, got ${JSON.stringify(f.map((x) => x.name))}`);
        // Leak check: the real value is never in the output, only the redacted preview.
        const out = JSON.stringify(f);
        assert.ok(!out.includes(p.secret), 'raw secret leaked into the result');
        assert.ok(f.every((x) => x.preview === '****' || x.preview.includes('****')));
    });
}

for (const t of NEGATIVES) {
    test(`false positive guard: "${t.slice(0, 50)}"`, () => {
        assert.deepEqual(findSecrets(t).map((x) => x.name), []);
    });
}

test('one secret found by two detectors gives one finding', () => {
    const f = findSecrets('api_key = abcd1234efgh5678ijkl and password: abcd1234efgh5678ijkl');
    assert.equal(f.length, 1);
});

test('same fingerprint wherever the secret sits', () => {
    const a = findSecrets('password: Tr0ub4dor&3xYz');
    const b = findSecrets('see the note. "password=Tr0ub4dor&3xYz" ok');
    assert.equal(a[0].fingerprint, b[0].fingerprint);
});

test('preview of a short password never reveals it', () => {
    assert.equal(redact('Tr0ub4dor&3xYz'), 'Tr0u****3xYz');
    assert.equal(findSecrets('password: Summer24!')[0].preview, '****');
});

test('entropy and placeholder helpers', () => {
    assert.equal(entropy(''), 0);
    assert.ok(entropy('aaaaaaaa') < 0.1);
    assert.ok(entropy('k9Xq2Lm7Zp4Wv8Nb') > 3.5);
    assert.equal(isPlaceholder('xxxxxxxx'), true);
    assert.equal(isPlaceholder('${TOKEN}'), true);
    assert.equal(isPlaceholder('Zx9Qp7Lm2Vb'), false);
    assert.equal(looksLikeSecretValue('getUserTokenFromCache'), false);
    assert.equal(looksLikeSecretValue('Zx9Qp7Lm2Vb!'), true);
});
