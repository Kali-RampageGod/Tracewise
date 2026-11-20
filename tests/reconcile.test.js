import test from 'node:test';
import assert from 'node:assert/strict';
import { jobFromConfluencePage, jobFromJiraIssue, nextCursor, chunk } from '../src/ingest/normalize.js';
import { handleJob } from '../src/ingest/handler.js';

test('confluence page job key is page id + version', () => {
  const j = jobFromConfluencePage({ id: '123', title: 'Decision test', version: { number: 3, createdAt: '2026-11-19T04:00:00.000Z' } });
  assert.equal(j.eventKey, 'confluence:123:v3');
  assert.equal(j.occurredAt, Date.parse('2026-11-19T04:00:00.000Z'));
  assert.equal(jobFromConfluencePage({ id: '1' }), null);
  assert.equal(jobFromConfluencePage(null), null);
});

test('jira issue job key uses the updated time in ms', () => {
  const j = jobFromJiraIssue({ id: '66400', key: 'TRAC-1', fields: { updated: '2026-11-19T08:30:35.664-0500', project: { key: 'TRAC' } } });
  assert.equal(j.eventKey, 'jira:66400:upd:' + Date.parse('2026-11-19T08:30:35.664-0500'));
  assert.equal(j.projectKey, 'TRAC');
  assert.equal(jobFromJiraIssue({ id: '1', fields: {} }), null);
});

test('scanning the same page version twice processes it once', async () => {
  const done = new Set(); let n = 0;
  const deps = { isProcessed: async (k) => done.has(k), markProcessed: async (j) => done.add(j.eventKey), process: async () => { n++; } };
  const page = { id: '123', version: { number: 3, createdAt: '2026-11-19T04:00:00.000Z' } };
  await handleJob(jobFromConfluencePage(page), deps);
  await handleJob(jobFromConfluencePage(page), deps);
  await handleJob(jobFromConfluencePage({ ...page, version: { number: 4, createdAt: '2026-11-19T05:00:00.000Z' } }), deps);
  assert.equal(n, 2);
});

test('cursor extraction and chunking', () => {
  assert.equal(nextCursor({ next: '/wiki/api/v2/pages?limit=50&cursor=abc123' }), 'abc123');
  assert.equal(nextCursor({}), null);
  assert.equal(nextCursor(undefined), null);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});


import { normalizeEvent } from '../src/ingest/normalize.js';

const confEvent = (over = {}) => ({
  eventType: 'avi:confluence:updated:page', selfGenerated: false,
  eventCreatedDate: '2026-11-20T04:54:11.086Z', updateTrigger: 'edit_page',
  content: { id: '6389761', type: 'page', status: 'current', title: 'Events Trigger DEMo',
    space: { key: '~abc' }, version: { number: 3, when: '2026-11-20T04:54:10.757Z' } },
  ...over,
});

test('confluence event: key is page id + version', () => {
  const j = normalizeEvent(confEvent());
  assert.equal(j.eventKey, 'confluence:6389761:v3');
  assert.equal(j.sourceType, 'confluence_page');
  assert.equal(j.spaceKey, '~abc');
  assert.equal(j.occurredAt, Date.parse('2026-11-20T04:54:10.757Z'));
});

test('confluence event and reconcile scan produce the same key (cross-path dedupe)', () => {
  const fromEvent = normalizeEvent(confEvent());
  const fromScan = jobFromConfluencePage({ id: '6389761', title: 'x', version: { number: 3, createdAt: '2026-11-20T04:54:10.757Z' } });
  assert.equal(fromEvent.eventKey, fromScan.eventKey);
});

test('confluence event: ignores self-generated, drafts, non-pages, missing version', () => {
  assert.equal(normalizeEvent(confEvent({ selfGenerated: true })), null);
  assert.equal(normalizeEvent(confEvent({ content: { ...confEvent().content, status: 'draft' } })), null);
  assert.equal(normalizeEvent(confEvent({ content: { ...confEvent().content, type: 'blogpost' } })), null);
  assert.equal(normalizeEvent(confEvent({ content: { id: '1', type: 'page', status: 'current' } })), null);
});