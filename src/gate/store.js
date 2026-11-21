// Forge glue: policy and gate findings in Forge SQL.
import sql from '@forge/sql';
import { createHash } from 'crypto';
import { newId } from '../id';
import { normalizePolicy } from './policy';

export async function loadPolicy(projectKey) {
  const r = await sql
    .prepare("SELECT config FROM project_rules WHERE project_key = ? AND rule_key = 'release_gate'")
    .bindParams(projectKey)
    .execute();
  return normalizePolicy(r.rows.length ? r.rows[0].config : null);
}

export async function savePolicy(projectKey, policy, accountId) {
  const clean = normalizePolicy(policy);
  await sql
    .prepare(
      `INSERT INTO project_rules (id, project_key, rule_key, enabled, config, updated_by)
       VALUES (?, ?, 'release_gate', 1, ?, ?)
       ON DUPLICATE KEY UPDATE config = VALUES(config), updated_by = VALUES(updated_by),
         updated_at = CURRENT_TIMESTAMP`
    )
    .bindParams(newId(), projectKey, JSON.stringify(clean), accountId || null)
    .execute();
  return clean;
}

const fp = (releaseId, key) => createHash('sha256').update(`${releaseId}:${key}`).digest('hex');

async function event(findingId, type, from, to) {
  await sql
    .prepare('INSERT INTO finding_events (id, finding_id, event_type, from_status, to_status) VALUES (?, ?, ?, ?, ?)')
    .bindParams(newId(), findingId, type, from, to)
    .execute();
}

// Makes the stored gate findings of one release equal to `findings`.
// New or reopened ones are opened, ones no longer present are resolved. Safe to run twice.
export async function syncFindings(projectKey, releaseId, findings) {
  const rel = String(releaseId);
  const existing = await sql
    .prepare("SELECT id, fingerprint, status FROM findings WHERE project_key = ? AND type = 'gate' AND release_id = ?")
    .bindParams(projectKey, rel)
    .execute();
  const byFp = new Map(existing.rows.map((r) => [r.fingerprint, r]));
  const seen = new Set();
  let opened = 0;
  let resolved = 0;

  for (const f of findings) {
    const print = fp(rel, f.key);
    seen.add(print);
    const prev = byFp.get(print);
    const id = prev ? prev.id : newId();
    await sql
      .prepare(
        `INSERT INTO findings
           (id, project_key, release_id, type, severity, status, source_type, source_id,
            fingerprint, title, detail, evidence_confidence)
         VALUES (?, ?, ?, 'gate', ?, 'open', ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE severity = VALUES(severity), title = VALUES(title),
           detail = VALUES(detail), evidence_confidence = VALUES(evidence_confidence),
           status = 'open', resolved_at = NULL, last_seen_at = CURRENT_TIMESTAMP`
      )
      .bindParams(id, projectKey, rel, f.severity, f.sourceType, f.sourceId, print,
        f.title.slice(0, 255), JSON.stringify(f.detail), f.confidence)
      .execute();
    if (!prev || prev.status !== 'open') {
      opened++;
      await event(id, prev ? 'reopened' : 'opened', prev ? prev.status : null, 'open');
    }
  }

  for (const row of existing.rows) {
    if (seen.has(row.fingerprint) || row.status !== 'open') continue;
    await sql
      .prepare("UPDATE findings SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bindParams(row.id)
      .execute();
    await event(row.id, 'resolved', 'open', 'resolved');
    resolved++;
  }
  return { opened, resolved };
}

// Versions someone has already looked at (or an issue event touched). The hourly refresh re-checks these.
export async function trackedReleases(limit = 10) {
  const n = Math.min(50, Math.max(1, Math.floor(limit)));
  const r = await sql
    .prepare(
      `SELECT project_key, release_id, MAX(computed_at) AS last_at
         FROM release_assessments
        WHERE release_id REGEXP '^[0-9]+$' AND computed_at > DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 30 DAY)
        GROUP BY project_key, release_id
        ORDER BY last_at DESC LIMIT ${n}`
    )
    .execute();
  return r.rows;
}
