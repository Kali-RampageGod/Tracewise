// Forge glue for Confluence decision ingestion: reads the page, loads/saves decision rows.
import sql from '@forge/sql';
import { route } from '@forge/api';
import { confluenceGet, json } from '../api';
import { newId } from '../id';

// Decisions are site-wide for now: any Jira project is checked against them.
// (A space -> project mapping can narrow this later.)
export const SITE_KEY = '_site';

// Returns { title, version, decidedAt, storage } or null if the page is gone, trashed or a draft.
export async function fetchPage(pageId) {
  const res = await confluenceGet(route`/wiki/api/v2/pages/${pageId}?body-format=storage`, { asApp: true });
  if (res.status === 404) return null;
  const p = await json(res);
  if (p.status && p.status !== 'current') return null;
  return {
    title: p.title || '(untitled)',
    ownerId: p.ownerId || null,
    version: p.version && p.version.number,
    decidedAt: p.version && p.version.createdAt ? new Date(p.version.createdAt) : null,
    storage: (p.body && p.body.storage && p.body.storage.value) || '',
  };
}

export async function loadExisting(pageId) {
  const r = await sql
    .prepare('SELECT id, page_version, block_id, content_hash, status FROM decisions WHERE page_id = ?')
    .bindParams(pageId)
    .execute();
  return r.rows;
}

const toSqlDate = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 19).replace('T', ' ') : null);

// Applies a plan. Every statement is safe to run twice (retries).
export async function apply(plan, { pageId, title, version, decidedAt }) {
  for (const d of plan.upserts) {
    // Template decisions carry their own date; otherwise use the page version date.
    const decided = d.decidedOn ? new Date(d.decidedOn + 'T00:00:00Z') : decidedAt;
    await sql
      .prepare(
        `INSERT INTO decisions
           (id, project_key, page_id, page_title, page_version, block_id, decision_text,
            content_hash, status, supersedes_id, decided_at, title, scope, rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE decision_text = VALUES(decision_text), content_hash = VALUES(content_hash),
           page_title = VALUES(page_title), title = VALUES(title), scope = VALUES(scope),
           rationale = VALUES(rationale), decided_at = VALUES(decided_at),
           status = 'active', updated_at = CURRENT_TIMESTAMP`
      )
      .bindParams(newId(), SITE_KEY, pageId, title.slice(0, 255), version, d.blockId.slice(0, 64),
        d.text, d.hash, d.supersedesId, toSqlDate(decided), d.title || null, d.scope || null, d.rationale || null)
      .execute();
  }
  for (const k of plan.keep) {
    await sql
      .prepare(`UPDATE decisions SET page_version = ?, page_title = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bindParams(version, title.slice(0, 255), k.id)
      .execute();
  }
  for (const id of plan.supersedeIds) {
    await sql.prepare(`UPDATE decisions SET status = 'superseded', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bindParams(id).execute();
    // A superseded decision can no longer be contradicted: close its open findings.
    await sql
      .prepare(`UPDATE findings SET status = 'resolved' WHERE type = 'decision_conflict' AND status = 'open' AND detail LIKE ?`)
      .bindParams(`%"decisionId":"${id}"%`)
      .execute();
  }
}
