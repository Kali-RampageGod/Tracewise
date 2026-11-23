// Turns findings into rows for the project page. Pure: no Forge, no database.
//
// Privacy rule: Tracewise reads Jira and Confluence as the app, which can see more than the person
// looking at the page. A row whose source the VIEWER cannot open is masked: no title, owner,
// preview or link. Only its severity and points stay, so the score can still be explained.

const asObj = (d) => (d && typeof d === 'object' ? d : {});

// Everything a finding mentions that a viewer must be allowed to open before seeing the finding.
export function sourcesOf(f) {
  const d = asObj(f.detail);
  const out = [];
  const add = (s) => { if (!out.some((x) => sourceKey(x) === sourceKey(s))) out.push(s); };
  if (f.source_type === 'jira_issue' && d.issueKey) add({ kind: 'issue', key: String(d.issueKey) });
  if (f.source_type === 'confluence_page' && f.source_id) add({ kind: 'page', id: String(f.source_id) });
  if (d.pageId) add({ kind: 'page', id: String(d.pageId) });
  if (d.blockedBy) add({ kind: 'issue', key: String(d.blockedBy) });
  return out;
}

export const sourceKey = (s) => (s.kind === 'issue' ? 'issue:' + s.key : 'page:' + s.id);

// The one place a row links to.
export function primaryLink(f) {
  const d = asObj(f.detail);
  if (f.source_type === 'jira_issue' && d.issueKey) return { kind: 'issue', key: String(d.issueKey), label: String(d.issueKey) };
  if (f.source_type === 'confluence_page' && f.source_id) return { kind: 'page', id: String(f.source_id), label: d.pageTitle || 'page' };
  if (f.source_type === 'jira_version') return { kind: 'version', id: String(d.versionId || f.source_id), label: d.versionName || 'version' };
  if (d.pageId) return { kind: 'page', id: String(d.pageId), label: d.pageTitle || 'page' };
  return null;
}

export const ownerOf = (f) => asObj(f.detail).ownerAccountId || null;

// access: Map(sourceKey -> 'ok' | 'no'). Anything not confirmed 'ok' counts as restricted.
export function isRestricted(f, access) {
  return sourcesOf(f).some((s) => access.get(sourceKey(s)) !== 'ok');
}

export function formatAge(hours) {
  if (hours == null || isNaN(Number(hours))) return '';
  const h = Math.max(0, Math.floor(Number(hours)));
  if (h < 1) return 'less than 1 hour';
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${Math.floor(h / 24)} days`;
}

// One row of "where the points went" (or of the Findings list).
export function shapeRow({ finding, points = null, reason = null, ownerName = null, restricted }) {
  const base = {
    id: finding.id, type: finding.type, severity: Number(finding.severity), status: finding.status,
    points, reason, ageText: formatAge(finding.age_hours),
  };
  if (restricted) {
    return { ...base, restricted: true, title: 'Restricted item', owner: null, link: null, preview: null };
  }
  return {
    ...base, restricted: false, title: finding.title, owner: ownerName, link: primaryLink(finding),
    preview: finding.redacted_preview || null,
  };
}

// Biggest deduction first, then severity, then the oldest.
export function rankRows(rows) {
  return [...rows].sort(
    (a, b) => (b.points || 0) - (a.points || 0) || b.severity - a.severity || (parseAge(b) - parseAge(a))
  );
}
const parseAge = (r) => r._ageHours || 0;

// Joins the saved score breakdown with the current findings. A finding that closed since the
// score was saved is dropped: the caller refreshes the score first, so this is rare.
export function buildDeductionRows({ breakdown, findings, access, names }) {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const rows = [];
  for (const b of breakdown) {
    const f = byId.get(b.finding_id);
    if (!f) continue;
    const restricted = isRestricted(f, access);
    const row = shapeRow({
      finding: f, points: b.points, reason: b.reason, restricted,
      ownerName: restricted ? null : names.get(ownerOf(f)) || null,
    });
    row._ageHours = Number(f.age_hours) || 0;
    rows.push(row);
  }
  return rankRows(rows).map(({ _ageHours, ...r }) => r);
}

export const ownerIdsOf = (findings, access) =>
  [...new Set(findings.filter((f) => !isRestricted(f, access)).map(ownerOf).filter(Boolean))];

// Latest saved score per released-or-planned version; names come from Jira.
export function latestPerRelease(rows, versionNames, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(String(r.release_id))) continue;
    seen.add(String(r.release_id));
    const name = versionNames.get(String(r.release_id));
    if (!name) continue; // version was deleted
    out.push({ id: String(r.release_id), name, score: Number(r.score), band: r.band, blockedReason: r.blocked_reason || null, computedAt: r.computed_at });
    if (out.length >= limit) break;
  }
  return out;
}

// A finding for the Findings tab. Restricted ones keep only what explains severity and age.
export function presentFinding(f, access, names) {
  const ageText = formatAge(f.age_hours);
  if (isRestricted(f, access)) {
    return { id: f.id, type: f.type, severity: Number(f.severity), status: f.status, restricted: true, title: 'Restricted item', ageText };
  }
  return { ...f, restricted: false, ownerName: names.get(ownerOf(f)) || null, ageText, link: primaryLink(f) };
}
