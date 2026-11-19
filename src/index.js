import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { runMigration, sqlPoc } from './sql-poc';

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

export const handler = resolver.getDefinitions();