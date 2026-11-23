// Forge glue: what a person can do with a secret finding (confirm rotation, dismiss, allowlist).
import sql from '@forge/sql';
import { newId } from '../id';
import { validateAction, nextStatus } from './lifecycle';
import { logEvent } from './store';

// Returns { ok: true, status } or { error }.
export async function performSecretAction({ projectKey, findingId, action, reason, code, actor }) {
  const v = validateAction({ action, reason, code });
  if (!v.ok) return { error: v.error };

  const r = await sql
    .prepare("SELECT id, project_key, status, source_type, source_id, fingerprint FROM findings WHERE id = ? AND type = 'secret'")
    .bindParams(findingId)
    .execute();
  const f = r.rows[0];
  // Admins act only on findings of their own project or the site-wide ones.
  if (!f || (f.project_key !== projectKey && f.project_key !== '_site')) return { error: 'Finding not found' };
  const next = nextStatus(f.status, action);
  if (next.error) return { error: next.error };

  if (action === 'allow_value') await addAllow('fingerprint', f.fingerprint, v.reason, actor);
  if (action === 'allow_source') {
    await addAllow('source', `${f.source_type}:${f.source_id}`, v.reason, actor);
    // Everything else open from this source goes with it.
    const rest = await sql
      .prepare("SELECT id FROM findings WHERE type = 'secret' AND status = 'open' AND source_type = ? AND source_id = ? AND id <> ?")
      .bindParams(f.source_type, f.source_id, f.id)
      .execute();
    for (const o of rest.rows) await setStatus(o.id, 'dismissed', 'allowlisted', 'Source allowlisted: ' + v.reason, actor, 'open');
  }
  await setStatus(f.id, next.status, next.eventType, (v.code ? v.code + ': ' : '') + v.reason, actor, 'open');
  return { ok: true, status: next.status };
}

async function addAllow(scope, value, reason, actor) {
  await sql
    .prepare('INSERT INTO secret_allowlist (id, scope, value, reason, created_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)')
    .bindParams(newId(), scope, value, reason, actor || null)
    .execute();
}

async function setStatus(id, status, eventType, note, actor, from) {
  await sql
    .prepare("UPDATE findings SET status = ?, resolved_at = IF(? = 'resolved', CURRENT_TIMESTAMP, resolved_at) WHERE id = ?")
    .bindParams(status, status, id)
    .execute();
  await logEvent(id, eventType, note, actor, from, status);
}
