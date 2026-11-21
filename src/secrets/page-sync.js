// Decides what to do with secret findings when a Confluence page is scanned. Pure.
//
// A secret that was once on a page stays exposed in the page history, so it does not close
// when it disappears from the current text. It stays open, marked "no longer in the current
// version", until it is handled (rotation confirmation comes with the lifecycle work).
//
// existing: rows { id, fingerprint, status, detail } (detail is JSON text or null)
// current:  [{ name, severity, fingerprint, preview }]
export function planPageSecrets(existing, current) {
  const byPrint = new Map(existing.map((r) => [r.fingerprint, r]));
  const present = new Set(current.map((s) => s.fingerprint));
  const upserts = [];
  const markGone = [];
  let changed = false;

  for (const s of current) {
    const row = byPrint.get(s.fingerprint);
    if (row && row.status === 'dismissed') continue; // someone decided; do not reopen
    const wasGone = row ? parse(row.detail).inCurrentVersion === false : false;
    const reopen = !!row && row.status === 'resolved';
    if (!row || reopen || wasGone) changed = true;
    upserts.push({ ...s, existingId: row ? row.id : null, reopen });
  }
  for (const row of existing) {
    if (present.has(row.fingerprint) || row.status !== 'open') continue;
    if (parse(row.detail).inCurrentVersion === false) continue; // already marked
    markGone.push({ id: row.id, detail: parse(row.detail) });
    changed = true;
  }
  return { upserts, markGone, changed };
}

function parse(text) {
  try { return text ? JSON.parse(text) || {} : {}; } catch (e) { return {}; }
}

// Builds the function the page processor calls. Dependencies are injected for tests.
import { findSecrets } from './sentinel.js';
export function makeSecretScanner({ load, apply, find = findSecrets }) {
  return async function scanPageSecrets({ pageId, title, version, text }) {
    const plan = planPageSecrets(await load(pageId), find(text));
    await apply(plan, { pageId, title, version });
    return { changed: plan.changed, found: plan.upserts.length };
  };
}
