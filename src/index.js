import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { runMigration, sqlPoc } from './sql-poc';
import { runMigration as runAllMigrations, listMigrations } from './migrations';
import { reconcile } from './ingest/reconcile';
import { assessRelease, getHistory } from './score/store';
import { newId } from './id';
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

export const handler = resolver.getDefinitions();