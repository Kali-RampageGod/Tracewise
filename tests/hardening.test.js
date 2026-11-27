import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { shapeHealth } from '../src/health/shape.js';
import { planCleanup, productOf, runCleanup } from '../src/uninstall-plan.js';

// ---- every resolver checks who is asking
test('every resolver checks permission with guard()', () => {
  const src = readFileSync('src/index.js', 'utf8');
  const parts = src.split(/resolver\.define\(/).slice(1);
  assert.ok(parts.length >= 12);
  for (const p of parts) {
    const name = p.slice(0, 40).split("'")[1];
    const body = p.split(/\nresolver\.define\(|\nexport const handler/)[0];
    assert.match(body, /guard\(/, `resolver "${name}" has no guard()`);
  }
});

test('the admin resolvers need the project admin permission', () => {
  const src = readFileSync('src/index.js', 'utf8');
  for (const name of ['getHealth', 'adminAction', 'saveGatePolicy', 'saveRemediationConfig', 'secretAction']) {
    const body = src.split(`resolver.define('${name}'`)[1].split(/\nresolver\.define\(|\nexport const handler/)[0];
    assert.match(body, /ADMINISTER_PROJECTS|EDIT_ISSUES/, name);
  }
  const admin = src.split("resolver.define('adminAction'")[1].split('export const handler')[0];
  assert.match(admin, /ADMINISTER_PROJECTS/);
});

test('no demo, test or proof-of-concept code is left', () => {
  for (const dir of ['src', 'src/advisor', 'src/health']) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const text = readFileSync(`${dir}/${f}`, 'utf8');
      assert.doesNotMatch(text, /scoreDemo|decisionDemo|versionPoc|sqlPoc|rovo-poc|Hello, world/, `${dir}/${f}`);
    }
  }
  assert.equal(existsSync('src/sql-poc.js'), false);
  assert.equal(existsSync('src/rovo-poc.js'), false);
  const ui = readFileSync('static/hello-world/src/App.js', 'utf8');
  assert.doesNotMatch(ui, /scoreDemo|decisionDemo|Create demo|Clear demo|secretScanClear/);
});

// ---- migrations
test('migration names are unique, ordered, and the old v001 is kept', async () => {
  const { MIGRATION_NAMES, MIGRATION_LIST } = await import('../src/migrations.js').catch(() => ({}));
  if (!MIGRATION_NAMES) return; // the module needs the Forge runtime; the source check below covers it
  assert.equal(new Set(MIGRATION_NAMES).size, MIGRATION_NAMES.length);
  assert.equal(MIGRATION_NAMES[0], 'v001_create_poc_findings');
  assert.deepEqual([...MIGRATION_NAMES].sort(), MIGRATION_NAMES);
  assert.ok(MIGRATION_LIST.length >= 13);
});

test('migrations source: unique names in order, v013 drops the proof-of-concept table', () => {
  const src = readFileSync('src/migrations.js', 'utf8');
  const names = [...src.matchAll(/\['(v\d{3}_[a-z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 13);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual([...names].sort(), names);
  assert.match(src, /'v013_drop_poc_findings', 'DROP TABLE IF EXISTS poc_findings'/);
});

// ---- health
const base = { applied: ['a', 'b'], expected: ['a', 'b'], counts: { decisionsActive: 2, decisionsTotal: 3, openFindings: { secret: 1 } }, events: { last24h: 40, lastMinutesAgo: 5 } };

test('health: all good', () => {
  const h = shapeHealth({ ...base, scans: [{ scan_type: 'reconcile_jira', status: 'idle', minutes_ago: 20, items_scanned: 3 }, { scan_type: 'reconcile_confluence', status: 'idle', minutes_ago: 20 }] });  assert.equal(h.status, 'ok');
  assert.deepEqual(h.problems, []);
  assert.equal(h.scans[0].name, 'Jira work items');
  assert.equal(h.scans[1].name, 'Confluence pages');
  assert.equal(h.counts.decisionsActive, 2);
});

test('health: missing migration, failing scan, stale scan and no scan are all reported', () => {
  const h = shapeHealth({ ...base, applied: ['a'], scans: [
       { scan_type: 'reconcile_jira', status: 'error', minutes_ago: 10, error_text: 'Jira 503' },
    { scan_type: 'reconcile_confluence', status: 'idle', minutes_ago: 400 },
  ] });
  assert.equal(h.status, 'attention');
  assert.equal(h.migrations.missing.length, 1);
  assert.equal(h.problems.length, 3);
  assert.match(h.problems.join(' '), /Jira 503/);
  assert.equal(shapeHealth({ ...base, scans: [] }).problems.length, 1);
});

test('health returns counts only: no titles, previews or secrets', () => {
  const text = readFileSync('src/health/index.js', 'utf8');
  assert.doesNotMatch(text, /\btitle\b|redacted_preview|decision_text|detail/);
});

// ---- uninstall
test('uninstall: product is read from the install context', () => {
  assert.equal(productOf('ari:cloud:jira::site/abc'), 'jira');
  assert.equal(productOf('ari:cloud:confluence::site/abc'), 'confluence');
  assert.equal(productOf('something else'), null);
  assert.equal(productOf(undefined), null);
});

test('uninstall: Jira removal clears every table; Confluence removal keeps the Jira data', () => {
  const jira = planCleanup('ari:cloud:jira::site/abc').statements;
  assert.ok(jira.length >= 9 && jira.every((s) => /^DELETE FROM \w+$/.test(s)));
  const conf = planCleanup('ari:cloud:confluence::site/abc').statements.join(' | ');
  assert.doesNotMatch(conf, /release_assessments|project_rules|secret_allowlist|processed_events/);
  assert.match(conf, /decisions/);
  assert.match(conf, /scan_type = 'reconcile_confluence'/);
});

test('uninstall: an unknown product deletes nothing', async () => {
  assert.deepEqual(planCleanup('???').statements, []);
  const ran = [];
  const r = await runCleanup('???', async (t) => ran.push(t));
  assert.equal(ran.length, 0);
  assert.equal(r.done, 0);
});

test('uninstall: one failing statement does not stop the rest', async () => {
  const ran = [];
  const r = await runCleanup('ari:cloud:jira::site/abc', async (t) => { ran.push(t); if (ran.length === 2) throw new Error('boom'); });
  assert.equal(ran.length, r.planned);
  assert.equal(r.done, r.planned - 1);
});

test('manifest: preUninstall is wired to its function, with no custom timeout (Forge does not allow one)', () => {
  const m = readFileSync('manifest.yml', 'utf8');
  assert.match(m, /preUninstall:\s*\n\s*- key: tracewise-pre-uninstall\s*\n\s*function: pre-uninstall/);
  assert.match(m, /key: pre-uninstall\s*\n\s*handler: uninstall\.preUninstall/);
  assert.doesNotMatch(m, /key: pre-uninstall\s*\n\s*handler: uninstall\.preUninstall\s*\n\s*timeoutSeconds/);
});
