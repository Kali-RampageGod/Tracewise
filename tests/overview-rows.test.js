import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sourcesOf, sourceKey, primaryLink, ownerOf, isRestricted, formatAge, shapeRow, rankRows,
  buildDeductionRows, ownerIdsOf, latestPerRelease,
} from '../src/overview/rows.js';

const secretPage = { id: 's1', type: 'secret', severity: 4, status: 'open', title: 'Page "Runbook": possible AWS Access Key', source_type: 'confluence_page', source_id: '42', detail: { pageId: '42', pageTitle: 'Runbook', ownerAccountId: 'acc-1' }, redacted_preview: 'AKIA****MPLE', age_hours: 80 };
const conflict = { id: 'c1', type: 'decision_conflict', severity: 3, status: 'open', title: 'TRAC-3 may contradict: Stack', source_type: 'jira_issue', source_id: '9', detail: { issueKey: 'TRAC-3', pageId: '7', pageTitle: 'Stack' }, age_hours: 5 };
const blocked = { id: 'g1', type: 'gate', severity: 3, status: 'open', title: 'TRAC-1 is blocked by TRAC-2', source_type: 'jira_issue', source_id: '1', detail: { kind: 'blocked', issueKey: 'TRAC-1', blockedBy: 'TRAC-2', versionId: '10001' }, age_hours: 1 };
const versionLevel = { id: 'v1', type: 'gate', severity: 3, status: 'open', title: 'No release notes linked to this version', source_type: 'jira_version', source_id: '10001', detail: { kind: 'notes_missing', versionId: '10001', versionName: 'v1.0' }, age_hours: 0 };
const ok = (...keys) => new Map(keys.map((k) => [k, 'ok']));

test('sourcesOf: every item a finding mentions must be viewable', () => {
  assert.deepEqual(sourcesOf(secretPage).map(sourceKey), ['page:42']);
  assert.deepEqual(sourcesOf(conflict).map(sourceKey), ['issue:TRAC-3', 'page:7']);
  assert.deepEqual(sourcesOf(blocked).map(sourceKey), ['issue:TRAC-1', 'issue:TRAC-2']);
  assert.deepEqual(sourcesOf(versionLevel), []);
  assert.deepEqual(sourcesOf({ detail: null }), []);
});

test('primaryLink: page, issue, version, none', () => {
  assert.deepEqual(primaryLink(secretPage), { kind: 'page', id: '42', label: 'Runbook' });
  assert.deepEqual(primaryLink(conflict), { kind: 'issue', key: 'TRAC-3', label: 'TRAC-3' });
  assert.deepEqual(primaryLink(versionLevel), { kind: 'version', id: '10001', label: 'v1.0' });
  assert.equal(primaryLink({ detail: {} }), null);
});

test('isRestricted: needs every source confirmed ok; unknown fails closed', () => {
  assert.equal(isRestricted(conflict, ok('issue:TRAC-3', 'page:7')), false);
  assert.equal(isRestricted(conflict, ok('issue:TRAC-3')), true);
  assert.equal(isRestricted(conflict, new Map([['issue:TRAC-3', 'ok'], ['page:7', 'no']])), true);
  assert.equal(isRestricted(conflict, new Map()), true);
  assert.equal(isRestricted(versionLevel, new Map()), false);
});

test('formatAge', () => {
  assert.equal(formatAge(0), 'less than 1 hour');
  assert.equal(formatAge(1), '1 hour');
  assert.equal(formatAge(47), '47 hours');
  assert.equal(formatAge(80), '3 days');
  assert.equal(formatAge(null), '');
  assert.equal(formatAge('x'), '');
});

test('shapeRow: restricted rows keep severity and points but nothing identifying', () => {
  const r = shapeRow({ finding: secretPage, points: 25, reason: 'confirmed', restricted: true, ownerName: 'Ann' });
  assert.deepEqual(r, { id: 's1', type: 'secret', severity: 4, status: 'open', points: 25, reason: 'confirmed', ageText: '3 days', restricted: true, title: 'Restricted item', owner: null, link: null, preview: null });
  const json = JSON.stringify(r);
  assert.ok(!json.includes('Runbook') && !json.includes('AKIA') && !json.includes('Ann'));
});

test('shapeRow: normal rows carry title, owner, age, link, preview', () => {
  const r = shapeRow({ finding: secretPage, points: 25, reason: 'confirmed', restricted: false, ownerName: 'Ann' });
  assert.equal(r.title, secretPage.title);
  assert.equal(r.owner, 'Ann');
  assert.equal(r.ageText, '3 days');
  assert.equal(r.link.kind, 'page');
  assert.equal(r.preview, 'AKIA****MPLE');
  assert.equal(ownerOf(secretPage), 'acc-1');
  assert.equal(ownerOf(conflict), null);
});

test('rankRows: points, then severity, then oldest', () => {
  const rows = [
    { id: 'a', points: 10, severity: 3, _ageHours: 1 },
    { id: 'b', points: 25, severity: 4, _ageHours: 1 },
    { id: 'c', points: 10, severity: 3, _ageHours: 90 },
    { id: 'd', points: 10, severity: 4, _ageHours: 1 },
  ];
  assert.deepEqual(rankRows(rows).map((r) => r.id), ['b', 'd', 'c', 'a']);
});

test('buildDeductionRows: joins breakdown, ranks, masks, drops closed findings, no internal fields', () => {
  const breakdown = [
    { finding_id: 'c1', points: 10, reason: 'confirmed' },
    { finding_id: 's1', points: 25, reason: 'confirmed' },
    { finding_id: 'gone', points: 5, reason: 'confirmed' },
  ];
  const access = ok('page:42', 'issue:TRAC-3'); // page:7 is not viewable, so the conflict is masked
  const rows = buildDeductionRows({ breakdown, findings: [secretPage, conflict], access, names: new Map([['acc-1', 'Ann']]) });
  assert.deepEqual(rows.map((r) => r.id), ['s1', 'c1']);
  assert.equal(rows[0].owner, 'Ann');
  assert.equal(rows[1].restricted, true);
  assert.ok(!('_ageHours' in rows[0]));
});

test('ownerIdsOf skips restricted rows so their owners are never looked up', () => {
  const access = ok('page:42');
  assert.deepEqual(ownerIdsOf([secretPage, { ...conflict, detail: { ...conflict.detail, ownerAccountId: 'acc-9' } }], access), ['acc-1']);
});

test('latestPerRelease: newest first per version, deleted versions dropped, limit applied', () => {
  const rows = [
    { release_id: '2', score: 90, band: 'ready', computed_at: 't3' },
    { release_id: '1', score: 40, band: 'blocked', blocked_reason: 'x', computed_at: 't2' },
    { release_id: '2', score: 10, band: 'blocked', computed_at: 't1' },
    { release_id: '3', score: 70, band: 'at_risk', computed_at: 't0' },
  ];
  const names = new Map([['1', 'v1'], ['2', 'v2']]);
  const out = latestPerRelease(rows, names);
  assert.deepEqual(out.map((r) => [r.id, r.score]), [['2', 90], ['1', 40]]);
  assert.equal(out[1].blockedReason, 'x');
  assert.equal(latestPerRelease(rows, new Map([['1', 'a'], ['2', 'b'], ['3', 'c']]), 2).length, 2);
});

import { presentFinding } from '../src/overview/rows.js';
import { maskDecisions } from '../src/decisions/list.js';

test('presentFinding: restricted hides everything but severity and age; normal adds owner and link', () => {
  const hidden = presentFinding(secretPage, new Map(), new Map());
  assert.deepEqual(Object.keys(hidden).sort(), ['ageText', 'id', 'restricted', 'severity', 'status', 'title', 'type']);
  assert.ok(!JSON.stringify(hidden).includes('Runbook'));
  const shown = presentFinding(secretPage, ok('page:42'), new Map([['acc-1', 'Ann']]));
  assert.equal(shown.ownerName, 'Ann');
  assert.equal(shown.link.kind, 'page');
  assert.equal(shown.redacted_preview, 'AKIA****MPLE');
});

test('maskDecisions: only decisions from viewable pages keep their text', () => {
  const rows = [
    { id: 'a', status: 'active', text: 'We will use X', pageId: '1', pageTitle: 'Secret plan', replacedBy: { text: 'Y' }, conflicts: [{ issueKey: 'T-1' }] },
    { id: 'b', status: 'active', text: 'We will use Z', pageId: '2', pageTitle: 'Open page', replacedBy: null, conflicts: [] },
  ];
  const out = maskDecisions(rows, new Map([['page:2', 'ok']]));
  assert.equal(out[0].restricted, true);
  assert.equal(out[0].text, 'Restricted decision');
  assert.ok(!JSON.stringify(out[0]).includes('Secret plan') && !JSON.stringify(out[0]).includes('T-1'));
  assert.equal(out[1].text, 'We will use Z');
  assert.equal(maskDecisions(rows, new Map())[1].restricted, true);
});
