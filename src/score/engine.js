// Release score calculator. Pure function: no database, no Jira, no Forge.
// Input: a list of findings. Output: score, band, and why.

// Severity numbers stored in findings.severity
// 1 = low, 2 = medium, 3 = high, 4 = critical
export const DEFAULT_CONFIG = {
  // points taken off per finding, by severity
  points: { 1: 2, 2: 5, 3: 10, 4: 25 },
  // a type can never take off more than this in total
  caps: { secret: 60, decision_conflict: 30, gate: 40, default: 30 },
  // evidence_confidence (0-100) decides how much a finding counts
  confirmedAt: 80, // >= 80: full points
  unclearAt: 40,   // 40-79: only 25% of points; below 40: zero
  unclearShare: 0.25,
  // When true, an open confirmed critical (Highest/Blocker) gate finding forces Blocked.
  // Off by default; the Release Gate turns it on from the project policy.
  forceBlockGate: false,
  // score bands
  readyAt: 80,   // 80-100 = ready
  atRiskAt: 50,  // 50-79 = at_risk, below = blocked
};

export function computeScore(findings, config = DEFAULT_CONFIG) {
  const rows = [];      // one row per finding that took points off
  const perType = {};   // running total taken off per type
  let forcedBlock = null;

  for (const f of findings) {
    if (f.status !== 'open') continue; // resolved or dismissed: ignore

    // 1. How sure are we this finding is real?
    let share = 0;
    if (f.evidence_confidence >= config.confirmedAt) share = 1;
    else if (f.evidence_confidence >= config.unclearAt) share = config.unclearShare;

    // 2. A confirmed critical secret blocks the release, no matter the score.
    if (f.type === 'secret' && f.severity >= 4 && share === 1) {
      forcedBlock = 'Critical secret found';
    }

    if (f.type === 'gate' && f.severity >= 4 && share === 1 && config.forceBlockGate) {
      forcedBlock = forcedBlock || 'Critical work item still open';
    }

    // 3. Points for this finding, limited by the cap for its type.
    const want = (config.points[f.severity] || 0) * share;
    const cap = config.caps[f.type] ?? config.caps.default;
    const used = perType[f.type] || 0;
    const taken = Math.max(0, Math.min(want, cap - used));
    perType[f.type] = used + taken;

    if (taken > 0) {
      rows.push({
        finding_id: f.id,
        title: f.title,
        type: f.type,
        severity: f.severity,
        points: taken,
        reason: share === 1 ? 'confirmed' : 'unclear evidence, reduced',
      });
    }
  }

  const total = rows.reduce((sum, r) => sum + r.points, 0);
  const score = Math.max(0, Math.round(100 - total));

  let band = score >= config.readyAt ? 'ready'
           : score >= config.atRiskAt ? 'at_risk'
           : 'blocked';
  if (forcedBlock) band = 'blocked';

  return { score, band, blockedReason: forcedBlock, breakdown: rows };
}