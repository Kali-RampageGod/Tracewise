// Rovo Release Advisor tools. Every tool is read-only: it reads what Tracewise already stored,
// and shows only what the person asking could open themselves. It never changes a score,
// a finding or a decision.
import sql from '@forge/sql';
import { route } from '@forge/api';
import { jiraGet, json } from '../api';
import { hasPermission, listVersions } from '../gate/jira';
import { checkAccess } from '../overview/access';
import { computeScore, DEFAULT_CONFIG } from '../score/engine';
import { loadPolicy } from '../gate/store';
import { sourcesOf, buildDeductionRows } from '../overview/rows';
import {
  pickProjectKey, pickIssueKey, clampLimit, findVersion, shapeConfidence, presentForAdvisor,
  explainDeduction, shapeConflicts, isFindingId, SEVERITY,
} from './shape';

const AGE_SQL = 'TIMESTAMPDIFF(HOUR, first_seen_at, CURRENT_TIMESTAMP) AS age_hours';
const NEED_PROJECT = 'Tell me which Jira project key to look at, for example TRAC.';

// Never throws: a tool error is returned as text the agent can pass on.
const safe = (fn) => async (payload = {}) => {
  try {
    return await fn(payload, payload.context || {});
  } catch (e) {
    console.log('TW_ADVISOR_ERROR', e && e.message);
    return { error: 'Tracewise could not read that right now. Try again in a minute.' };
  }
};

async function siteBase() {
  try {
    const info = await json(await jiraGet(route`/rest/api/3/serverInfo`, { asApp: true }));
    return info.baseUrl || null;
  } catch (e) {
    return null;
  }
}

// The asking person must be able to browse the project. If that cannot be checked, say no.
async function canBrowse(projectKey) {
  try {
    return await hasPermission(projectKey, 'BROWSE_PROJECTS');
  } catch (e) {
    return false;
  }
}
const NO_ACCESS = { error: 'I could not confirm that you can browse that project, so I will not show its release data.' };

const parse = (f) => {
  let detail = null;
  try { detail = f.detail ? JSON.parse(f.detail) : null; } catch (e) { /* keep null */ }
  return { ...f, detail };
};

// Is v2.4 safe to ship? What blocks it?
export const releaseConfidence = safe(async (p, ctx) => {
  const projectKey = pickProjectKey(ctx, p.projectKey);
  if (!projectKey) return { error: NEED_PROJECT };
  if (!(await canBrowse(projectKey))) return NO_ACCESS;

  let releaseId = 'current';
  let releaseName = null;
  if (String(p.releaseName || '').trim()) {
    const found = findVersion(await listVersions(projectKey), p.releaseName);
    if (found.ambiguous) return { error: `Several versions match: ${found.ambiguous.join(', ')}. Which one?` };
    if (!found.version) return { error: `I could not find a version called "${p.releaseName}" in ${projectKey}.` };
    releaseId = found.version.id;
    releaseName = found.version.name;
  }

  const cur = (await sql
    .prepare(
      `SELECT score, band, blocked_reason, open_findings, breakdown, computed_at
         FROM release_assessments WHERE project_key = ? AND release_id = ?
        ORDER BY computed_at DESC LIMIT 1`
    )
    .bindParams(projectKey, releaseId)
    .execute()).rows[0];
  if (!cur) {
    return {
      project: projectKey, scope: releaseName ? `version ${releaseName}` : 'whole project',
      error: releaseName
        ? `Tracewise has not scored ${releaseName} yet. Open it once in the Release gate tab, then ask again.`
        : 'Tracewise has not scored this project yet.',
    };
  }

  // The saved score can be hours old. Work the score out again from the findings that are open
  // now, with the same rules, in memory only. Nothing is saved.
  const live = (await sql
    .prepare(
      `SELECT id, title, type, severity, status, evidence_confidence
         FROM findings
        WHERE project_key IN (?, '_site') AND status = 'open'
          AND (release_id = ? OR release_id IS NULL)`
    )
    .bindParams(projectKey, releaseId)
    .execute()).rows;
  let config = DEFAULT_CONFIG;
  if (releaseName) config = { ...DEFAULT_CONFIG, forceBlockGate: (await loadPolicy(projectKey)).blockOnCriticalIssue };
  const result = computeScore(live, config);
  const breakdown = result.breakdown;
  let findings = [];
  if (breakdown.length) {
    const ids = breakdown.map((b) => b.finding_id);
    const r = await sql
      .prepare(
        `SELECT id, type, severity, status, title, detail, redacted_preview, source_type, source_id, ${AGE_SQL}
           FROM findings WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'open'`
      )
      .bindParams(...ids)
      .execute();
    findings = r.rows.map(parse);
  }
  const access = await checkAccess(findings.flatMap(sourcesOf));
  const rows = buildDeductionRows({ breakdown, findings, access, names: new Map() });
  const fresh = {
    score: result.score, band: result.band, blocked_reason: result.blockedReason,
    open_findings: live.length, computed_at: new Date().toISOString(), last_saved_at: cur.computed_at,
  };
  return shapeConfidence({ projectKey, releaseName, cur: fresh, rows, base: await siteBase() });
});

// What is open? Optionally only one type.
export const openFindings = safe(async (p, ctx) => {
  const projectKey = pickProjectKey(ctx, p.projectKey);
  if (!projectKey) return { error: NEED_PROJECT };
  if (!(await canBrowse(projectKey))) return NO_ACCESS;
  const type = ['secret', 'decision_conflict', 'gate'].includes(String(p.type)) ? String(p.type) : null;
  const limit = clampLimit(p.limit);

  const r = await sql
    .prepare(
      `SELECT id, type, severity, status, title, detail, redacted_preview, source_type, source_id, ${AGE_SQL}
         FROM findings
        WHERE project_key IN (?, '_site') AND status = 'open' ${type ? 'AND type = ?' : ''}
        ORDER BY severity DESC, first_seen_at ASC LIMIT ${limit}`
    )
    .bindParams(...(type ? [projectKey, type] : [projectKey]))
    .execute();
  const findings = r.rows.map(parse);
  const access = await checkAccess(findings.flatMap(sourcesOf));
  const base = await siteBase();
  return {
    project: projectKey,
    shown: findings.length,
    findings: findings.map((f) => presentForAdvisor(f, access, base, projectKey)),
    note: findings.length === limit ? 'There may be more. Ask for a specific type to narrow it down.' : undefined,
  };
});

// Why does this finding cost that many points?
export const explainDeductionTool = safe(async (p, ctx) => {
  const projectKey = pickProjectKey(ctx, p.projectKey);
  if (!projectKey) return { error: NEED_PROJECT };
  if (!isFindingId(p.findingId)) return { error: 'I need a finding id. Ask for the open findings first, then pick one.' };
  if (!(await canBrowse(projectKey))) return NO_ACCESS;

  const f = (await sql
    .prepare(
      `SELECT id, type, severity, status, title, detail, evidence_confidence, source_type, source_id, ${AGE_SQL}
         FROM findings WHERE id = ? AND project_key IN (?, '_site')`
    )
    .bindParams(String(p.findingId), projectKey)
    .execute()).rows[0];
  if (!f) return { error: 'That finding does not belong to this project.' };
  const finding = parse(f);

  const access = await checkAccess(sourcesOf(finding));
  const shown = presentForAdvisor(finding, access, await siteBase(), projectKey);

  const cur = (await sql
    .prepare(`SELECT breakdown FROM release_assessments WHERE project_key = ? AND release_id = 'current' ORDER BY computed_at DESC LIMIT 1`)
    .bindParams(projectKey)
    .execute()).rows[0];
  const saved = cur ? JSON.parse(cur.breakdown).find((b) => b.finding_id === finding.id) : null;

  const why = explainDeduction(finding, saved ? saved.points : null);
  return { finding: shown, explanation: why.lines, severity: SEVERITY[finding.severity] };
});

// Does this ticket conflict with a decision?
export const checkWorkItem = safe(async (p, ctx) => {
  const issueKey = pickIssueKey(ctx, p.issueKey);
  if (!issueKey) return { error: 'Tell me which work item to check, for example TRAC-9.' };
  const projectKey = issueKey.split('-')[0];
  if (!(await canBrowse(projectKey))) return NO_ACCESS;

  // The person must be able to open the work item itself.
  const opened = await checkAccess([{ kind: 'issue', key: issueKey }]);
  if (opened.get('issue:' + issueKey) !== 'ok') return { error: `You cannot open ${issueKey}, so I will not show what Tracewise found on it.` };

  const f = await sql
    .prepare(
      `SELECT id, title, detail FROM findings
        WHERE project_key = ? AND type = 'decision_conflict' AND status = 'open'
          AND source_type = 'jira_issue' AND detail LIKE ? LIMIT 20`
    )
    .bindParams(projectKey, `%"issueKey":"${issueKey}"%`)
    .execute();
  const ids = [...new Set(f.rows.map((r) => { try { return JSON.parse(r.detail).decisionId; } catch (e) { return null; } }).filter(Boolean))];
  let decisions = [];
  if (ids.length) {
    decisions = (await sql
      .prepare(`SELECT id, page_id, page_title, decision_text, title, scope, rationale, decided_at FROM decisions WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bindParams(...ids)
      .execute()).rows;
  }
  const access = await checkAccess(decisions.map((d) => ({ kind: 'page', id: String(d.page_id) })));
  const conflicts = shapeConflicts(f.rows, decisions, access, await siteBase());
  return {
    workItem: issueKey,
    conflicts,
    summary: conflicts.length
      ? `${conflicts.length} possible conflict${conflicts.length > 1 ? 's' : ''} with a team decision.`
      : 'Tracewise has no open decision conflict on this work item. A new or just-edited item can take a few minutes to be checked.',
  };
});

