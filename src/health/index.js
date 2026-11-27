import sql from '@forge/sql';
import { listMigrations, MIGRATION_NAMES } from '../migrations';
import { shapeHealth } from './shape';

// Counts only: nothing here reads or returns any finding or decision content.
export async function loadHealth() {
  const applied = (await listMigrations()).map((m) => m.name);
  const scans = (await sql
    .prepare(
      `SELECT scan_type, status, items_scanned, error_text,
              TIMESTAMPDIFF(MINUTE, last_finished_at, CURRENT_TIMESTAMP) AS minutes_ago
         FROM scan_state WHERE project_key = '_site' ORDER BY scan_type`
    )
    .execute()).rows;
  const dec = (await sql.prepare('SELECT status, COUNT(*) AS n FROM decisions GROUP BY status').execute()).rows;
  const open = (await sql.prepare("SELECT type, COUNT(*) AS n FROM findings WHERE status = 'open' GROUP BY type").execute()).rows;
  const ev = (await sql
    .prepare(
      `SELECT COUNT(*) AS n, MIN(TIMESTAMPDIFF(MINUTE, processed_at, CURRENT_TIMESTAMP)) AS last_ago
         FROM processed_events WHERE TIMESTAMPDIFF(HOUR, processed_at, CURRENT_TIMESTAMP) < 24`
    )
    .execute()).rows[0];
  const total = dec.reduce((a, r) => a + Number(r.n), 0);
  const active = dec.filter((r) => r.status === 'active').reduce((a, r) => a + Number(r.n), 0);
  return shapeHealth({
    applied, expected: MIGRATION_NAMES, scans,
    counts: { decisionsActive: active, decisionsTotal: total, openFindings: Object.fromEntries(open.map((r) => [r.type, Number(r.n)])) },
    events: { last24h: ev ? ev.n : 0, lastMinutesAgo: ev ? ev.last_ago : null },
  });
}
