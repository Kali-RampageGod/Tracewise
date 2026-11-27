import Resolver from '@forge/resolver';
import { route } from '@forge/api';
import { runMigration as runAllMigrations } from './migrations';
import { loadHealth } from './health';
import { reconcile } from './ingest/reconcile';
import { assessRelease } from './score/store';
import { newId } from './id';
import sql from '@forge/sql';
import { gate, refreshTrackedGates } from './gate';
import { listVersions, hasPermission, validateRules } from './gate/jira';
import { normalizePolicy } from './gate/policy';
import { loadPolicy, savePolicy } from './gate/store';
import { performSecretAction } from './secrets/actions';
import { backfillRemediation } from './secrets/rescan';
import { getConfig as getRemediationConfig } from './secrets/remediation-glue';
import { jiraGet, json } from './api';
import { checkAccess } from './overview/access';
import { displayNames } from './overview/people';
import { sourcesOf, ownerIdsOf, buildDeductionRows, latestPerRelease, presentFinding } from './overview/rows';
import { maskDecisions } from './decisions/list';
import { PAGE_SIZE, parseStatus, shapeDecisions } from './decisions/list';
import { shapeIssueFlags } from './decisions/issue-flags';
import { performDecisionAction } from './decisions/actions-glue';

const resolver = new Resolver();

const describe = (e) =>
  JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 1500);

// Dashboard: latest saved score for a project (any release).
const AGE_SQL = 'TIMESTAMPDIFF(HOUR, first_seen_at, CURRENT_TIMESTAMP) AS age_hours';
const parseDetail = (f) => {
  let detail = null;
  try { detail = f.detail ? JSON.parse(f.detail) : null; } catch (e) { /* keep null */ }
  return { ...f, detail };
};

// The project's current score, what holds it down (ranked), and the latest score of each release.
resolver.define('getOverview', async ({ payload }) => {
  try {
    const denied = await guard(payload.projectKey, 'BROWSE_PROJECTS');
    if (denied) return { error: denied };
    const projectKey = payload.projectKey;

    await assessRelease(projectKey, 'current'); // refresh first; saves only if something changed
    const cur = (await sql
      .prepare(
        `SELECT score, band, blocked_reason, open_findings, breakdown, computed_at
           FROM release_assessments WHERE project_key = ? AND release_id = 'current'
          ORDER BY computed_at DESC LIMIT 1`
      )
      .bindParams(projectKey)
      .execute()).rows[0];
    if (!cur) return { empty: true };

    const breakdown = JSON.parse(cur.breakdown);
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
      findings = r.rows.map(parseDetail);
    }
    const access = await checkAccess(findings.flatMap(sourcesOf));
    const names = await displayNames(ownerIdsOf(findings, access));
    const rows = buildDeductionRows({ breakdown, findings, access, names });

    const history = await sql
      .prepare(
        `SELECT release_id, score, band, blocked_reason, computed_at FROM release_assessments
          WHERE project_key = ? AND release_id REGEXP '^[0-9]+$' ORDER BY computed_at DESC LIMIT 60`
      )
      .bindParams(projectKey)
      .execute();
    const versions = new Map((await listVersions(projectKey)).map((v) => [String(v.id), v.name]));

    return {
      empty: false,
      current: {
        score: Number(cur.score), band: cur.band, blockedReason: cur.blocked_reason,
        openFindings: Number(cur.open_findings), computedAt: cur.computed_at,
      },
      rows,
      releases: latestPerRelease(history.rows, versions),
    };
  } catch (e) {
    return { error: describe(e) };
  }
});

// Findings tab: open findings of a project, worst first.
resolver.define('getDecisions', async ({ payload }) => {
  try {
    const denied = await guard(payload.projectKey, 'BROWSE_PROJECTS');
    if (denied) return { error: denied };
    const status = parseStatus(payload.status);
    const offset = Math.max(0, Number(payload.offset) || 0);
    const where = status === 'all' ? '' : 'AND status = ?';
    const params = [payload.projectKey];
    if (status !== 'all') params.push(status);
    const r = await sql
      .prepare(
        `SELECT id, page_id, page_title, page_version, decision_text, status, decided_at
           FROM decisions
          WHERE project_key IN (?, '_site') ${where}
          ORDER BY updated_at DESC, id LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`
      )
      .bindParams(...params)
      .execute();
    const ids = r.rows.slice(0, PAGE_SIZE).map((d) => d.id);
    let replacements = [];
    if (ids.length) {
      const q = await sql
        .prepare(`SELECT id, supersedes_id, decision_text, page_version FROM decisions WHERE supersedes_id IN (${ids.map(() => '?').join(',')})`)
        .bindParams(...ids)
        .execute();
      replacements = q.rows;
    }
    const f = await sql
      .prepare("SELECT title, detail FROM findings WHERE project_key = ? AND type = 'decision_conflict' AND status = 'open' LIMIT 500")
      .bindParams(payload.projectKey)
      .execute();
    const shaped = shapeDecisions(r.rows, replacements, f.rows);
    const access = await checkAccess(shaped.rows.map((d) => ({ kind: 'page', id: String(d.pageId) })));
    return { ...shaped, rows: maskDecisions(shaped.rows, access) };
  } catch (e) {
    return { error: describe(e) };
  }
});

// Jira issue panel: open decision conflicts of this work item, with each decision's rationale.
resolver.define('getIssueFlags', async ({ payload, context }) => {
  try {
    const ext = (context && context.extension) || {};
    const projectKey = (ext.project && ext.project.key) || payload.projectKey;
    const issueId = String((ext.issue && ext.issue.id) || payload.issueId || '');
    if (!/^[0-9]{1,20}$/.test(issueId)) return { error: 'Invalid work item' };
    const denied = await guard(projectKey, 'BROWSE_PROJECTS');
    if (denied) return { error: denied };
    const f = await sql
      .prepare(
        `SELECT id, title, detail FROM findings
          WHERE project_key = ? AND type = 'decision_conflict' AND status = 'open'
            AND source_type = 'jira_issue' AND source_id = ? LIMIT 20`
      )
      .bindParams(projectKey, issueId)
      .execute();
    const ids = [...new Set(f.rows.map((r) => { try { return JSON.parse(r.detail).decisionId; } catch (e) { return null; } }).filter(Boolean))];
    let decisions = [];
    if (ids.length) {
      const d = await sql
        .prepare(`SELECT id, page_id, page_title, decision_text, title, scope, rationale, decided_at FROM decisions WHERE id IN (${ids.map(() => '?').join(',')})`)
        .bindParams(...ids)
        .execute();
      decisions = d.rows;
    }
    const access = await checkAccess(decisions.map((d) => ({ kind: 'page', id: String(d.page_id) })));
    return { flags: shapeIssueFlags(f.rows, decisions, access) };
  } catch (e) {
    return { error: describe(e) };
  }
});

// Confirm, amend, supersede or dismiss a decision conflict.
resolver.define('decisionAction', async ({ payload, context }) => {
  try {
    const denied = await guard(payload.projectKey, 'EDIT_ISSUES');
    if (denied) return { error: denied };
    return await performDecisionAction({
      projectKey: payload.projectKey, findingId: payload.findingId, action: payload.action,
      comment: payload.comment, newText: payload.newText, actor: context && context.accountId,
    });
  } catch (e) {
    return { error: describe(e) };
  }
});

// ---- Release Gate ----
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,31}$/;
const guard = async (projectKey, permission) => {
  if (!PROJECT_KEY.test(String(projectKey || ''))) return 'Invalid project';
  if (!(await hasPermission(projectKey, permission))) return 'You do not have permission for this project';
  return null;
};

// Versions of the project for the picker: unreleased first, by release date.
resolver.define('getReleases', async ({ payload }) => {
  try {
    const denied = await guard(payload.projectKey, 'BROWSE_PROJECTS');
    if (denied) return { error: denied };
    const rows = (await listVersions(payload.projectKey)).filter((v) => !v.archived);
    rows.sort((a, b) =>
      Number(a.released) - Number(b.released) ||
      String(a.releaseDate || '9999').localeCompare(String(b.releaseDate || '9999')) ||
      a.name.localeCompare(b.name));
    return { rows };
  } catch (e) {
    return { error: describe(e) };
  }
});

// Reads Jira now, applies the policy, saves findings and the score, returns the full verdict.
resolver.define('runGate', async ({ payload }) => {
  try {
    const denied = await guard(payload.projectKey, 'BROWSE_PROJECTS');
    if (denied) return { error: denied };
    return await gate.runGate(payload.projectKey, payload.versionId);
  } catch (e) {
    return { error: describe(e) };
  }
});

resolver.define('getGatePolicy', async ({ payload }) => {
  try {
    const denied = await guard(payload.projectKey, 'BROWSE_PROJECTS');
    if (denied) return { error: denied };
    return {
      policy: await loadPolicy(payload.projectKey),
      canEdit: await hasPermission(payload.projectKey, 'ADMINISTER_PROJECTS'),
    };
  } catch (e) {
    return { error: describe(e) };
  }
});

resolver.define('saveGatePolicy', async ({ payload, context }) => {
  try {
    const denied = await guard(payload.projectKey, 'ADMINISTER_PROJECTS');
    if (denied) return { error: denied };
    // Check the rules' JQL with Jira's parser before saving, so a typo is caught here.
    const clean = normalizePolicy(payload.policy);
    const problems = await validateRules(clean.customRules);
    if (problems.length) return { error: problems.join(' ') };
    const saved = await savePolicy(payload.projectKey, clean, context && context.accountId);
    // Release verdicts follow the new rules without waiting for the next hourly scan.
    refreshTrackedGates(15000).catch((e) => console.log('TW_GATE_REFRESH_ERROR', e.message));
    return { policy: saved };
  } catch (e) {
    return { error: describe(e) };
  }
});

resolver.define('getFindings', async ({ payload }) => {
  try {
    const denied = await guard(payload.projectKey, 'BROWSE_PROJECTS');
    if (denied) return { error: denied };
    // 'open' (default) or 'closed' (resolved or dismissed) for the audit view.
    const closed = payload.status === 'closed';
    const r = await sql
      .prepare(
        `SELECT id, type, severity, status, title, detail, redacted_preview, evidence_confidence,
                first_seen_at, resolved_at, remediation_issue_key, source_type, source_id, ${AGE_SQL}
           FROM findings
          WHERE project_key IN (?, '_site') AND status ${closed ? "IN ('resolved', 'dismissed')" : "= 'open'"}
          ORDER BY severity DESC, first_seen_at DESC LIMIT 50`
      )
      .bindParams(payload.projectKey)
      .execute();
    const found = r.rows.map(parseDetail);
    const access = await checkAccess(found.flatMap(sourcesOf));
    const names = await displayNames(ownerIdsOf(found, access));
    return { rows: found.map((f) => presentFinding(f, access, names)) };
  } catch (e) {
    return { error: describe(e) };
  }
});

// Confirm rotation, dismiss with a reason, or allowlist a value or a whole source.
resolver.define('secretAction', async ({ payload, context }) => {
  try {
    const denied = await guard(payload.projectKey, 'ADMINISTER_PROJECTS');
    if (denied) return { error: denied };
    return await performSecretAction({
      projectKey: payload.projectKey, findingId: payload.findingId, action: payload.action,
      reason: payload.reason, code: payload.code, actor: context && context.accountId,
    });
  } catch (e) {
    return { error: describe(e) };
  }
});

// Where remediation issues are created (one project for the whole site).
resolver.define('getRemediationConfig', async ({ payload }) => {
  try {
    const denied = await guard(payload.projectKey, 'BROWSE_PROJECTS');
    if (denied) return { error: denied };
    return {
      config: (await getRemediationConfig()) || { enabled: false, projectKey: payload.projectKey },
      canEdit: await hasPermission(payload.projectKey, 'ADMINISTER_PROJECTS'),
    };
  } catch (e) {
    return { error: describe(e) };
  }
});

resolver.define('saveRemediationConfig', async ({ payload, context }) => {
  try {
    const target = String(payload.targetProject || '').trim().toUpperCase();
    // The person must administer both the project they are in and the project that will receive issues.
    for (const key of new Set([payload.projectKey, target])) {
      const denied = await guard(key, 'ADMINISTER_PROJECTS');
      if (denied) return { error: `${key}: ${denied}` };
    }
    const check = await jiraGet(route`/rest/api/3/project/${target}`, { asApp: true });
    if (check.status === 404) return { error: `Project ${target} was not found, or the app cannot see it` };
    await json(check);
    await sql
      .prepare(
        `INSERT INTO project_rules (id, project_key, rule_key, enabled, config, updated_by)
         VALUES (?, '_site', 'secret_remediation', ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), config = VALUES(config),
           updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP`
      )
      .bindParams(newId(), payload.enabled ? 1 : 0, JSON.stringify({ projectKey: target }), (context && context.accountId) || null)
      .execute();
    // Findings that opened before this was switched on get their issues now.
    const filled = payload.enabled ? await backfillRemediation() : { queued: 0 };
    return { config: { enabled: !!payload.enabled, projectKey: target }, queued: filled.queued };
  } catch (e) {
    return { error: describe(e) };
  }
});

// Admin panel: is Tracewise working? Counts only, no titles or previews.
resolver.define('getHealth', async ({ payload }) => {
  try {
    const denied = await guard(payload.projectKey, 'ADMINISTER_PROJECTS');
    if (denied) return { error: denied };
    return await loadHealth();
  } catch (e) {
    return { error: describe(e) };
  }
});

// The two maintenance actions an admin may start by hand.
resolver.define('adminAction', async ({ payload }) => {
  try {
    const denied = await guard(payload.projectKey, 'ADMINISTER_PROJECTS');
    if (denied) return { error: denied };
    if (payload.action === 'migrate') return { ok: true, applied: await runAllMigrations() };
    if (payload.action === 'scan') return { ok: true, scan: await reconcile() };
    return { error: 'Unknown action' };
  } catch (e) {
    return { error: describe(e) };
  }
});

export const handler = resolver.getDefinitions();