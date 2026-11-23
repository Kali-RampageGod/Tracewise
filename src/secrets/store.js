// Forge glue: secret findings, allowlist and history markers in Forge SQL.
import sql from '@forge/sql';
import { newId } from '../id';

async function event(findingId, type, note, actor = null, from = null, to = null) {
  await sql
    .prepare('INSERT INTO finding_events (id, finding_id, event_type, from_status, to_status, actor_account_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bindParams(newId(), findingId, type, from, to, actor, note ? String(note).slice(0, 500) : null)
    .execute();
}
export const logEvent = event;

export async function loadExistingSecrets(sourceType, sourceId) {
  const r = await sql
    .prepare('SELECT id, fingerprint, status, detail FROM findings WHERE type = \'secret\' AND source_type = ? AND source_id = ?')
    .bindParams(sourceType, String(sourceId))
    .execute();
  return r.rows;
}

const INSERT = `INSERT INTO findings
    (id, project_key, release_id, type, severity, status, source_type, source_id,
     fingerprint, title, detail, redacted_preview, evidence_confidence)
  VALUES (?, ?, NULL, 'secret', ?, 'open', ?, ?, ?, ?, ?, ?, ?)`;

// Applies a plan from planSecretSync. Safe to run twice. Returns the ids of findings that just opened.
// The order of the SET parts matters: later parts see the values set by earlier ones.
export async function applySecrets(plan, ctx) {
  const opened = [];
  for (const s of plan.upserts) {
    const id = s.existingId || newId();
    const detail = JSON.stringify({ ...ctx.detailBase, detector: s.name, inCurrentVersion: true });
    await sql
      .prepare(
        `${INSERT}
         ON DUPLICATE KEY UPDATE detail = VALUES(detail), title = VALUES(title),
           resolved_at = IF(status = 'resolved', NULL, resolved_at),
           remediation_issue_key = IF(status = 'resolved', NULL, remediation_issue_key),
           remediation_claimed_at = IF(status = 'resolved', NULL, remediation_claimed_at),
           status = IF(status = 'resolved', 'open', status),
           last_seen_at = CURRENT_TIMESTAMP`
      )
      .bindParams(id, ctx.projectKey, s.severity, ctx.sourceType, String(ctx.sourceId), s.fingerprint,
        ctx.titleFor(s).slice(0, 255), detail, s.preview, s.severity >= 4 ? 90 : 60)
      .execute();
    if (s.isNew) {
      opened.push(id);
      await event(id, s.reopen ? 'reopened' : 'opened', null, null, s.reopen ? 'resolved' : null, 'open');
    }
  }
  for (const g of plan.markGone) {
    await sql
      .prepare('UPDATE findings SET detail = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bindParams(JSON.stringify({ ...g.detail, inCurrentVersion: false }), g.id)
      .execute();
  }
  return { opened };
}

// Secrets found only in an old page version. Never touches a finding that already exists.
export async function applyHistory(fresh, { pageId, title, version, ownerAccountId }) {
  const opened = [];
  for (const s of fresh) {
    const id = newId();
    const detail = JSON.stringify({
      pageId, pageTitle: title, foundInVersion: version, detector: s.name,
      inCurrentVersion: false, historyOnly: true, ownerAccountId: ownerAccountId || null,
    });
    await sql
      .prepare(`${INSERT} ON DUPLICATE KEY UPDATE id = id`)
      .bindParams(id, '_site', s.severity, 'confluence_page', String(pageId), s.fingerprint,
        `Page "${title}": possible ${s.name} (old version ${version})`.slice(0, 255), detail, s.preview, s.severity >= 4 ? 90 : 60)
      .execute();
    opened.push(id);
    await event(id, 'opened', `Found in page version ${version}`, null, null, 'open');
  }
  return { opened };
}

// Fingerprints that must be ignored: allowlisted values, or everything from an allowlisted source.
export async function loadAllowed(fingerprints, { sourceType, sourceId }) {
  const marks = fingerprints.map(() => '?').join(',');
  const r = await sql
    .prepare(
      `SELECT scope, value FROM secret_allowlist
        WHERE (scope = 'source' AND value = ?) ${fingerprints.length ? `OR (scope = 'fingerprint' AND value IN (${marks}))` : ''}`
    )
    .bindParams(`${sourceType}:${sourceId}`, ...fingerprints)
    .execute();
  if (r.rows.some((x) => x.scope === 'source')) return new Set(fingerprints);
  return new Set(r.rows.map((x) => x.value));
}

export async function isHistoryScanned(pageId, n) {
  const r = await sql.prepare('SELECT 1 AS x FROM processed_events WHERE event_key = ?').bindParams(`history:${pageId}:scanned:v${n}`).execute();
  return r.rows.length > 0;
}
export async function markHistoryScanned(pageId, n) {
  await sql
    .prepare("INSERT INTO processed_events (event_key, event_type) VALUES (?, 'history_version') ON DUPLICATE KEY UPDATE processed_at = CURRENT_TIMESTAMP")
    .bindParams(`history:${pageId}:scanned:v${n}`)
    .execute();
}
