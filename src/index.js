import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { runMigration, sqlPoc } from './sql-poc';
import { runMigration as runAllMigrations, listMigrations } from './migrations';
import { reconcile } from './ingest/reconcile';
import { assessRelease, getHistory } from './score/store';
import { newId } from './id';
import { createHash } from 'crypto';
import { scanIssue } from './decisions/scan';
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
const resolver = new Resolver();

const describe = (e) =>
  JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 1500);

resolver.define('getText', () => 'Hello, world!');

resolver.define('runMigration', async () => {
  try {
    const applied = await runMigration();
    return 'Migration OK: ' + JSON.stringify(applied);
  } catch (e) {
    return 'Migration ERROR: ' + describe(e);
  }
});

resolver.define('migrate', async () => {
  try {
    const applied = await runAllMigrations();
    return 'OK applied: ' + JSON.stringify(applied);
  } catch (e) {
    return 'ERROR: ' + describe(e);
  }
});

resolver.define('migrationStatus', async () => {
  try {
    return 'OK ' + JSON.stringify(await listMigrations());
  } catch (e) {
    return 'ERROR: ' + describe(e);
  }
});

resolver.define('sqlPoc', async () => {
  try {
    const result = await sqlPoc();
    return 'SQL test OK: ' + JSON.stringify(result);
  } catch (e) {
    return 'SQL test ERROR: ' + describe(e);
  }
});

resolver.define('versionPoc', async ({ payload }) => {
  try {
    const id = payload.pageId;
    const vRes = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${id}/versions`);
    if (!vRes.ok) return `ERROR versions ${vRes.status}: ${await vRes.text()}`;
    const versions = (await vRes.json()).results.map(v => v.number);
    const first = Math.min(...versions);
    const out = { versions };
    for (const n of [first, Math.max(...versions)]) {
      const r = await api.asUser().requestConfluence(
        route`/wiki/api/v2/pages/${id}?version=${n}&body-format=storage`
      );
      if (!r.ok) { out['v' + n] = `ERROR ${r.status}: ${await r.text()}`; continue; }
      const j = await r.json();
      out['v' + n] = j.body && j.body.storage ? j.body.storage.value : 'NO BODY';
    }
    return 'Version test OK: ' + JSON.stringify(out);
  } catch (e) {
    return 'ERROR: ' + e.message;
  }
});

resolver.define('reconcileNow', async () => {
  try {
    return 'OK ' + JSON.stringify(await reconcile());
  } catch (e) {
    return 'ERROR: ' + e.message;
  }
});


resolver.define('processedEvents', async () => {
  try {
    const r = await sql
      .prepare('SELECT event_key, event_type, processed_at FROM processed_events ORDER BY processed_at DESC LIMIT 15')
      .execute();
    return 'OK ' + JSON.stringify(r.rows, null, 1);
  } catch (e) {
    return 'ERROR: ' + e.message;
  }
});
// Test helper: adds one fake finding to the fake release "demo", then scores it.
resolver.define('scoreDemo', async ({ payload }) => {
  try {
    const { projectKey, type, severity } = payload;
    await sql
      .prepare(
        `INSERT INTO findings
           (id, project_key, release_id, type, severity, source_type, source_id, fingerprint, title)
         VALUES (?, ?, 'demo', ?, ?, 'demo', ?, ?, ?)`
      )
      .bindParams(newId(), projectKey, type, severity, newId(), newId(), `Demo ${type} (sev ${severity})`)
      .execute();
    const result = await assessRelease(projectKey, 'demo');
    const history = await getHistory(projectKey, 'demo');
    return 'OK ' + JSON.stringify({ result, history }, null, 1);
  } catch (e) {
    return 'ERROR: ' + describe(e);
  }
});

// Removes all demo data again.
resolver.define('scoreDemoClear', async ({ payload }) => {
  try {
    await sql.prepare("DELETE FROM findings WHERE project_key = ? AND release_id = 'demo'").bindParams(payload.projectKey).execute();
    await sql.prepare("DELETE FROM release_assessments WHERE project_key = ? AND release_id = 'demo'").bindParams(payload.projectKey).execute();
    return 'OK demo data cleared';
  } catch (e) {
    return 'ERROR: ' + describe(e);
  }
});

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

// Thin slice: stores one hand-made decision that points at a real Confluence page.
resolver.define('decisionDemoCreate', async ({ payload }) => {
  try {
    const { projectKey, pageId } = payload;
    if (!/^\d+$/.test(pageId || '')) return 'ERROR: page id must be digits only';
    const text = 'We will use MySQL as the database. We will not use MongoDB.';
    const hash = createHash('sha256').update(text).digest('hex');
    await sql
      .prepare(
        `INSERT INTO decisions
           (id, project_key, page_id, page_title, page_version, block_id,
            decision_text, content_hash, status, decided_at)
         VALUES (?, ?, ?, ?, 1, 'demo', ?, ?, 'active', CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE decision_text = VALUES(decision_text)`
      )
      .bindParams(newId(), projectKey, pageId, 'Decision: Use MySQL, not MongoDB', text, hash)
      .execute();
    const r = await sql
      .prepare('SELECT page_id, page_title, decision_text, status FROM decisions WHERE project_key = ?')
      .bindParams(projectKey)
      .execute();
    return 'OK ' + JSON.stringify(r.rows, null, 1);
  } catch (e) {
    return 'ERROR: ' + describe(e);
  }
});

resolver.define('decisionDemoClear', async ({ payload }) => {
  try {
    await sql.prepare("DELETE FROM decisions WHERE project_key = ? AND block_id = 'demo'").bindParams(payload.projectKey).execute();
    await sql.prepare("DELETE FROM findings WHERE project_key = ? AND type = 'decision_conflict'").bindParams(payload.projectKey).execute();
    return 'OK demo decision cleared';
  } catch (e) {
    return 'ERROR: ' + describe(e);
  }
});

resolver.define('decisionDemoScan', async ({ payload }) => {
  try {
    const r = await scanIssue(payload.projectKey, payload.issueKey);
    return 'OK ' + JSON.stringify(r, null, 1);
  } catch (e) {
    return 'ERROR: ' + describe(e);
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

resolver.define('secretScanClear', async ({ payload }) => {
  try {
    await sql.prepare("DELETE FROM findings WHERE project_key = ? AND type = 'secret' AND source_type = 'jira_issue'").bindParams(payload.projectKey).execute();
    return 'OK scanned secret findings cleared';
  } catch (e) {
    return 'ERROR: ' + describe(e);
  }
});

export const handler = resolver.getDefinitions();