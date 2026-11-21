// Forge glue: secret findings for Confluence pages in Forge SQL.
// Page secrets are site-wide (project_key '_site') until spaces are mapped to projects.
import sql from '@forge/sql';
import { newId } from '../id';
import { SITE_KEY } from '../ingest/confluence-store';

export async function loadExistingSecrets(pageId) {
  const r = await sql
    .prepare("SELECT id, fingerprint, status, detail FROM findings WHERE type = 'secret' AND source_type = 'confluence_page' AND source_id = ?")
    .bindParams(String(pageId))
    .execute();
  return r.rows;
}

export async function applySecrets(plan, { pageId, title, version }) {
  for (const s of plan.upserts) {
    const detail = JSON.stringify({ pageId, pageTitle: title, pageVersion: version, detector: s.name, inCurrentVersion: true });
    await sql
      .prepare(
        `INSERT INTO findings
           (id, project_key, release_id, type, severity, status, source_type, source_id,
            fingerprint, title, detail, redacted_preview, evidence_confidence)
         VALUES (?, ?, NULL, 'secret', ?, 'open', 'confluence_page', ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE detail = VALUES(detail), title = VALUES(title),
           status = IF(status = 'resolved', 'open', status),
           resolved_at = IF(status = 'resolved', NULL, resolved_at), last_seen_at = CURRENT_TIMESTAMP`
      )
      .bindParams(newId(), SITE_KEY, s.severity, String(pageId), s.fingerprint,
        `Page "${title}": possible ${s.name}`.slice(0, 255), detail, s.preview, s.severity >= 4 ? 90 : 60)
      .execute();
  }
  for (const g of plan.markGone) {
    await sql
      .prepare('UPDATE findings SET detail = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bindParams(JSON.stringify({ ...g.detail, inCurrentVersion: false, pageVersion: version }), g.id)
      .execute();
  }
}
