// Shapes what the Rovo Release Advisor tools return. Pure: no Forge, no database.
// The advisor only READS. It never writes a finding, a score or a decision.
import { DEFAULT_CONFIG } from '../score/engine.js';
import { primaryLink, sourcesOf, sourceKey, isRestricted, formatAge } from '../overview/rows.js';

export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,31}$/;
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{1,31}-\d{1,9}$/;
export const SEVERITY = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' };
export const BAND = { ready: 'Ready', at_risk: 'At risk', blocked: 'Blocked' };
export const TYPE = { secret: 'secret', decision_conflict: 'decision conflict', gate: 'release gate' };
const FINDING_ID = /^[0-9a-f-]{36}$/i;
export const isFindingId = (s) => FINDING_ID.test(String(s || ''));

// The project comes from where the agent was opened when Jira tells us. The model's own input
// is only a fallback, because a model can make up a key.
export function pickProjectKey(context, input) {
  const fromContext = context && context.jira && context.jira.projectKey;
  const raw = String(fromContext || input || '').trim().toUpperCase();
  return PROJECT_KEY.test(raw) ? raw : null;
}

export function pickIssueKey(context, input) {
  const fromContext = context && context.jira && context.jira.issueKey;
  const raw = String(fromContext || input || '').trim().toUpperCase();
  return ISSUE_KEY.test(raw) ? raw : null;
}

export function clampLimit(n, fallback = 10, max = 15) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 1 ? Math.min(v, max) : fallback;
}

// A version by name: exact (ignoring case) first, then a single "contains" match.
export function findVersion(versions, name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return { none: true };
  const exact = versions.filter((v) => v.name.toLowerCase() === q);
  if (exact.length === 1) return { version: exact[0] };
  if (exact.length > 1) return { ambiguous: exact.map((v) => v.name) };
  const part = versions.filter((v) => v.name.toLowerCase().includes(q));
  if (part.length === 1) return { version: part[0] };
  if (part.length > 1) return { ambiguous: part.map((v) => v.name) };
  return { missing: true };
}

// Absolute link to a source, or null when the site address is unknown.
export function linkUrl(base, link, projectKey) {
  if (!base || !link) return null;
  const b = String(base).replace(/\/+$/, '');
  if (link.kind === 'issue') return `${b}/browse/${link.key}`;
  if (link.kind === 'page') return `${b}/wiki/pages/viewpage.action?pageId=${link.id}`;
  if (link.kind === 'version' && projectKey) return `${b}/projects/${projectKey}/versions/${link.id}`;
  return null;
}

// One finding as the advisor shows it. A source the asking person cannot open is masked.
export function presentForAdvisor(f, access, base, projectKey) {
  const restricted = isRestricted(f, access);
  const out = {
    findingId: f.id, type: TYPE[f.type] || f.type, severity: SEVERITY[f.severity] || String(f.severity),
    age: formatAge(f.age_hours), restricted,
  };
  if (restricted) return { ...out, title: 'Restricted item (you cannot open its source)' };
  return { ...out, title: f.title, source: linkUrl(base, primaryLink(f), projectKey), redactedPreview: f.redacted_preview || null };
}

// Release confidence for a project or a version, from a SAVED assessment and its ranked rows.
// rows: output of buildDeductionRows (already masked for the viewer).
export function shapeConfidence({ projectKey, releaseName, cur, rows, base }) {
  const out = {
    project: projectKey,
    scope: releaseName ? `version ${releaseName}` : 'whole project',
    score: Number(cur.score),
    verdict: BAND[cur.band] || cur.band,
    blockedBecause: cur.blocked_reason || null,
    openFindings: Number(cur.open_findings),
    asOf: cur.computed_at,
    calculation: 'worked out just now from the findings that are open, with the same rules as the score; nothing was saved',
    topDeductions: rows.slice(0, 8).map((r, i) => ({
      rank: i + 1, pointsLost: r.points, severity: SEVERITY[r.severity] || String(r.severity),
      type: TYPE[r.type] || r.type, title: r.title, why: r.reason, restricted: !!r.restricted,
      source: r.restricted ? null : linkUrl(base, r.link, projectKey),
      findingId: r.id,
    })),
  };
  const more = rows.length - out.topDeductions.length;
  if (more > 0) out.note = `${more} smaller deduction${more > 1 ? 's' : ''} not listed.`;
  return out;
}

// Why a finding costs what it costs, from the same numbers the score engine uses.
export function explainDeduction(f, savedPoints = null, config = DEFAULT_CONFIG) {
  const sev = Number(f.severity);
  const conf = Number(f.evidence_confidence);
  const base = config.points[sev] || 0;
  let share = 0;
  let confText;
  if (conf >= config.confirmedAt) { share = 1; confText = `evidence confidence ${conf} is ${config.confirmedAt} or more, so it counts fully`; }
  else if (conf >= config.unclearAt) { share = config.unclearShare; confText = `evidence confidence ${conf} is unclear (${config.unclearAt} to ${config.confirmedAt - 1}), so it counts ${Math.round(config.unclearShare * 100)}%`; }
  else confText = `evidence confidence ${conf} is below ${config.unclearAt}, so it counts for nothing`;
  const cap = config.caps[f.type] ?? config.caps.default;
  const lines = [
    `${SEVERITY[sev] || sev} severity is worth ${base} points.`,
    `Tracewise ${confText}.`,
    `Before the cap this finding is worth ${base * share} points.`,
    `All findings of the type "${TYPE[f.type] || f.type}" together can take off at most ${cap} points.`,
  ];
  if (f.type === 'secret' && sev >= 4 && share === 1) lines.push('A confirmed critical secret forces the verdict to Blocked, whatever the score.');
  if (savedPoints != null) lines.push(`In the latest saved score it took off ${savedPoints} points.`);
  if (f.status !== 'open') lines.push(`It is ${f.status}, so it no longer counts.`);
  return { pointsBeforeCap: base * share, lines };
}

// Decision conflicts of one work item, ready for the advisor. decisions: rows of the decisions table.
export function shapeConflicts(findings, decisions, access, base) {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const out = [];
  for (const f of findings) {
    let detail = null;
    try { detail = f.detail ? JSON.parse(f.detail) : null; } catch (e) { continue; }
    if (!detail || !detail.decisionId) continue;
    const d = byId.get(detail.decisionId);
    if (!d || access.get(sourceKey({ kind: 'page', id: String(d.page_id) })) !== 'ok') {
      out.push({ findingId: f.id, restricted: true, note: 'A decision applies but you cannot open its page.' });
      continue;
    }
    out.push({
      findingId: f.id, restricted: false,
      decision: d.decision_text, title: d.title || d.page_title, scope: d.scope || null,
      rationale: d.rationale || 'none recorded on the decision page', decidedAt: d.decided_at || null,
      page: d.page_title, source: linkUrl(base, { kind: 'page', id: String(d.page_id) }),
      matchedKeywords: Array.isArray(detail.shared) ? detail.shared : [], // why it matched, NOT a rationale
      matchScore: Number(detail.score) || 0,
      status: 'possible conflict, not yet confirmed by a person',
    });
  }
  return out.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
}
export { sourcesOf };
