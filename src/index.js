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
resolver.define('getOverview', async ({ payload }) => {
  try {
    const r = await sql
      .prepare(
        `SELECT release_id, score, band, blocked_reason, open_findings, breakdown, computed_at
           FROM release_assessments
          WHERE project_key = ?
          ORDER BY computed_at DESC LIMIT 1`
      )
      .bindParams(payload.projectKey)
      .execute();
    const row = r.rows[0];
    if (!row) return { empty: true };
    return { empty: false, ...row, breakdown: JSON.parse(row.breakdown) };
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
resolver.define('getFindings', async ({ payload }) => {
  try {
    const r = await sql
      .prepare(
        `SELECT id, type, severity, title, detail, evidence_confidence, first_seen_at
           FROM findings
          WHERE project_key = ? AND status = 'open'
          ORDER BY severity DESC, first_seen_at DESC LIMIT 50`
      )
      .bindParams(payload.projectKey)
      .execute();
    const rows = r.rows.map((f) => {
      let detail = null;
      try { detail = f.detail ? JSON.parse(f.detail) : null; } catch (e) { /* keep null */ }
      return { ...f, detail };
    });
    return { rows };
  } catch (e) {
    return { error: describe(e) };
  }
});

export const handler = resolver.getDefinitions();