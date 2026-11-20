import test from 'node:test';
import assert from 'node:assert/strict';
import { isStale } from '../src/ingest/freshness.js';

test('never scanned is stale', () => assert.equal(isStale(null, 1000, 120000), true));
test('recent scan is fresh', () => assert.equal(isStale(1000, 61000, 120000), false));
test('old scan is stale', () => assert.equal(isStale(1000, 200000, 120000), true));
test('exactly at the limit is still fresh', () => assert.equal(isStale(0, 120000, 120000), false));