// Per-project Release Gate policy. Pure: no Forge, no database.
export const DEFAULT_POLICY = {
  requireReleaseNotes: true,   // the version must link release notes, and the page must exist
  flagBlockedLinks: true,      // an unfinished item blocked by another unfinished item is a problem
  flagOverdue: true,           // the release date has passed and the version is not released
  flagEmptyRelease: true,      // a version with no work items is suspicious
  blockOnCriticalIssue: true,  // an unfinished Highest/Blocker item forces the verdict to Blocked
};

export const POLICY_KEYS = Object.keys(DEFAULT_POLICY);

// Accepts anything (JSON text, object, null). Unknown keys are dropped, non-booleans use the default.
export function normalizePolicy(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
  }
  const out = {};
  for (const k of POLICY_KEYS) {
    out[k] = obj && typeof obj[k] === 'boolean' ? obj[k] : DEFAULT_POLICY[k];
  }
  return out;
}
