// Per-project Release Gate policy. Pure: no Forge, no database.
import { createHash } from 'crypto';

export const MAX_RULES = 5;
export const MAX_STATUSES = 10;

export const DEFAULT_POLICY = {
  requireReleaseNotes: true,        // the version must link release notes, and the page must exist
  flagBlockedLinks: true,           // an unfinished item blocked by another unfinished item is a problem
  flagOverdue: true,                // the release date has passed and the version is not released
  flagEmptyRelease: true,           // a version with no work items is suspicious
  blockOnCriticalIssue: true,       // an unfinished Highest/Blocker item forces the verdict to Blocked
  requireNoCriticalFindings: true,  // open critical findings (for example a secret) fail the gate
  requiredStatuses: [],             // empty: "done" means the Done status category. Else only these statuses pass.
  customRules: [],                  // each: { name, jql, severity }. A work item that matches is a problem.
};

const BOOLS = ['requireReleaseNotes', 'flagBlockedLinks', 'flagOverdue', 'flagEmptyRelease', 'blockOnCriticalIssue', 'requireNoCriticalFindings'];
export const POLICY_KEYS = Object.keys(DEFAULT_POLICY);

// The id comes from the JQL, so editing a rule closes the findings of the old version of it.
export const ruleId = (jql) => 'r' + createHash('sha256').update(String(jql).trim()).digest('hex').slice(0, 10);

export function normalizeStatuses(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const out = [];
  for (const x of list) {
    const s = String(x || '').trim().slice(0, 60);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= MAX_STATUSES) break;
  }
  return out;
}

export function normalizeRules(raw) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const name = String((r && r.name) || '').trim().slice(0, 80);
    const jql = String((r && r.jql) || '').trim().slice(0, 500);
    if (!name || !jql) continue;
    const sev = Math.round(Number(r.severity));
    out.push({ id: ruleId(jql), name, jql, severity: sev >= 1 && sev <= 4 ? sev : 3 });
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

// Accepts anything (JSON text, object, null). Unknown keys are dropped, bad values use the default.
export function normalizePolicy(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
  }
  const out = {};
  for (const k of BOOLS) out[k] = obj && typeof obj[k] === 'boolean' ? obj[k] : DEFAULT_POLICY[k];
  out.requiredStatuses = normalizeStatuses(obj && obj.requiredStatuses);
  out.customRules = normalizeRules(obj && obj.customRules);
  return out;
}
