import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  pickProjectKey, pickIssueKey, clampLimit, findVersion, linkUrl, presentForAdvisor,
  shapeConfidence, explainDeduction, shapeConflicts, isFindingId,
} from '../src/advisor/shape.js';

test('project key: Jira context wins over the model input; junk is refused', () => {
  assert.equal(pickProjectKey({ jira: { projectKey: 'TRAC' } }, 'OTHER'), 'TRAC');
  assert.equal(pickProjectKey({}, ' trac '), 'TRAC');
  assert.equal(pickProjectKey({}, 'TRAC; DROP'), null);
  assert.equal(pickProjectKey(null, ''), null);
});

test('issue key shape and limits', () => {
  assert.equal(pickIssueKey({}, 'trac-9'), 'TRAC-9');
  assert.equal(pickIssueKey({}, 'TRAC-9" OR 1=1'), null);
  assert.equal(clampLimit(undefined), 10);
  assert.equal(clampLimit(99), 15);
  assert.equal(clampLimit(-3), 10);
  assert.equal(isFindingId('0fa9e0a6-65d3-40a8-a7a1-0b2f5301621e'), true);
  assert.equal(isFindingId("x' OR '1'='1"), false);
});

test('version by name: exact, partial, ambiguous, missing', () => {
  const v = [{ name: 'v2.4' }, { name: 'v2.40' }, { name: 'v3.0' }];
  assert.equal(findVersion(v, 'V2.4').version.name, 'v2.4');
  assert.equal(findVersion(v, '3').version.name, 'v3.0');
  assert.deepEqual(findVersion(v, 'v2').ambiguous, ['v2.4', 'v2.40']);
  assert.equal(findVersion(v, 'v9').missing, true);
  assert.equal(findVersion(v, '').none, true);
});

test('links need a site address', () => {
  assert.equal(linkUrl('https://x.atlassian.net/', { kind: 'issue', key: 'T-1' }), 'https://x.atlassian.net/browse/T-1');
  assert.match(linkUrl('https://x.atlassian.net', { kind: 'page', id: '5' }), /pageId=5$/);
  assert.equal(linkUrl('https://x.atlassian.net', { kind: 'version', id: '9' }, 'TRAC'), 'https://x.atlassian.net/projects/TRAC/versions/9');
  assert.equal(linkUrl(null, { kind: 'issue', key: 'T-1' }), null);
});

const finding = { id: 'f1', type: 'secret', severity: 4, status: 'open', title: 'Page "P": possible AWS Access Key', source_type: 'confluence_page', source_id: '77', age_hours: 30, redacted_preview: 'AKIA****MPLE', detail: { pageTitle: 'P' } };

test('a restricted finding shows no title, link or preview', () => {
  const r = presentForAdvisor(finding, new Map([['page:77', 'no']]), 'https://x.atlassian.net', 'TRAC');
  assert.equal(r.restricted, true);
  assert.equal(r.source, undefined);
  assert.equal(r.redactedPreview, undefined);
  assert.doesNotMatch(r.title, /AWS/);
  assert.equal(r.severity, 'Critical');
});

test('an unchecked source counts as restricted (fails closed)', () => {
  assert.equal(presentForAdvisor(finding, new Map(), null, 'TRAC').restricted, true);
});

test('an allowed finding shows title, link and redacted preview only', () => {
  const r = presentForAdvisor(finding, new Map([['page:77', 'ok']]), 'https://x.atlassian.net', 'TRAC');
  assert.equal(r.restricted, false);
  assert.match(r.source, /pageId=77/);
  assert.equal(r.redactedPreview, 'AKIA****MPLE');
  assert.equal(r.age, '30 hours');
});

test('confidence: verdict words, top 8 rows and a note for the rest', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: 'f' + i, points: 10 - i, severity: 3, type: 'gate', title: 't' + i, reason: 'confirmed', restricted: i === 1, link: { kind: 'issue', key: 'T-' + i } }));
  const r = shapeConfidence({ projectKey: 'TRAC', releaseName: 'v2.4', cur: { score: 40, band: 'blocked', blocked_reason: 'Critical secret found', open_findings: 10, computed_at: 'now' }, rows, base: 'https://x.atlassian.net' });
  assert.equal(r.verdict, 'Blocked');
  assert.equal(r.scope, 'version v2.4');
  assert.equal(r.topDeductions.length, 8);
  assert.equal(r.topDeductions[1].source, null);
  assert.match(r.note, /2 smaller/);
  assert.equal(r.asOf, 'now');
});

test('explain deduction follows the engine numbers', () => {
  const sure = explainDeduction({ type: 'secret', severity: 4, evidence_confidence: 90, status: 'open' }, 25);
  assert.equal(sure.pointsBeforeCap, 25);
  assert.ok(sure.lines.some((l) => /forces the verdict to Blocked/.test(l)));
  assert.ok(sure.lines.some((l) => /took off 25/.test(l)));
  const unclear = explainDeduction({ type: 'decision_conflict', severity: 3, evidence_confidence: 60, status: 'open' });
  assert.equal(unclear.pointsBeforeCap, 2.5);
  assert.equal(explainDeduction({ type: 'gate', severity: 3, evidence_confidence: 10, status: 'open' }).pointsBeforeCap, 0);
  assert.ok(explainDeduction({ type: 'gate', severity: 2, evidence_confidence: 100, status: 'resolved' }).lines.some((l) => /no longer counts/.test(l)));
});

test('conflicts: masked when the decision page is closed to the viewer', () => {
  const findings = [{ id: 'a', detail: JSON.stringify({ decisionId: 'd1', shared: ['mongodb'], score: 5 }) }, { id: 'b', detail: JSON.stringify({ decisionId: 'd2', score: 9 }) }, { id: 'c', detail: '{bad' }];
  const decisions = [
    { id: 'd1', page_id: 1, page_title: 'Stack', decision_text: 'We will use MySQL', rationale: 'Team knows it' },
    { id: 'd2', page_id: 2, page_title: 'Secret plan', decision_text: 'hidden' },
  ];
  const out = shapeConflicts(findings, decisions, new Map([['page:1', 'ok'], ['page:2', 'no']]), 'https://x.atlassian.net');
  assert.equal(out.length, 2);
  const open = out.find((x) => x.findingId === 'a');
  assert.equal(open.rationale, 'Team knows it');
  assert.match(open.status, /not yet confirmed/);
  const hidden = out.find((x) => x.findingId === 'b');
  assert.equal(hidden.restricted, true);
  assert.equal(hidden.decision, undefined);
});

// The advisor must not be able to change anything.
test('advisor code is read-only: no writes, no rescoring, no Jira changes', () => {
  for (const f of readdirSync('src/advisor')) {
    const src = readFileSync('src/advisor/' + f, 'utf8');
    assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP)\b\s/i, f);
    assert.doesNotMatch(src, /jiraWrite|assessRelease|syncFindings|performSecretAction|performDecisionAction|asUser\(\)\.requestJira\([^)]*method/, f);
  }
});

test('every action in the manifest is a read (GET)', () => {
  const m = readFileSync('manifest.yml', 'utf8');
  const verbs = [...m.matchAll(/actionVerb:\s*(\w+)/g)].map((x) => x[1]);
  assert.ok(verbs.length >= 4);
  assert.ok(verbs.every((v) => v === 'GET'));
});
