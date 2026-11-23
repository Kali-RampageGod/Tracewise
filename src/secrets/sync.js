import { findSecrets } from './sentinel.js';

// Decides what to do with secret findings when a page or work item is scanned. Pure.
//
// A secret that was once on a page stays exposed in the page history, so it does not close
// when it disappears from the current text. It stays open, marked "no longer in the current
// version", until it is handled (rotation confirmation comes with the lifecycle work).
//
// existing: rows { id, fingerprint, status, detail } (detail is JSON text or null)
// current:  [{ name, severity, fingerprint, preview }]
export function planSecretSync(existing, current) {
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
    upserts.push({ ...s, existingId: row ? row.id : null, reopen, isNew: !row || reopen });
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

// Secrets found only in OLD page versions. Anything already known (open, resolved, dismissed) is left alone.
export function planHistorySecrets(existing, found) {
  const known = new Set(existing.map((r) => r.fingerprint));
  const out = [];
  for (const s of found) {
    if (known.has(s.fingerprint)) continue;
    known.add(s.fingerprint);
    out.push(s);
  }
  return out;
}

// Builds the function that scans one source (a page or a work item) for secrets.
// Dependencies are injected for tests.
//  load(sourceType, sourceId) -> existing rows
//  loadAllowed(fingerprints, scopes) -> Set of allowlisted fingerprints (value or page scope)
//  apply(plan, ctx) -> { opened: [finding ids] }
export function makeSecretScanner({ load, loadAllowed, apply, find = findSecrets }) {
  return async function scanSecrets(ctx) {
    const { sourceType, sourceId, text } = ctx;
    let found = find(text);
    if (found.length && loadAllowed) {
      const allowed = await loadAllowed(found.map((s) => s.fingerprint), { sourceType, sourceId });
      found = found.filter((s) => !allowed.has(s.fingerprint));
    }
    const plan = planSecretSync(await load(sourceType, sourceId), found);
    const res = (await apply(plan, ctx)) || { opened: [] };
    return { changed: plan.changed, found: plan.upserts.length, opened: res.opened || [] };
  };
}
