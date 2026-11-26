// Decides what to write to the decisions table when a page version is ingested.
// Pure function: existing rows in, a plan out. The caller applies the plan.
//
// existing: rows of this page: { id, block_id, content_hash, status, page_version }
// current:  { version, decisions: [{ blockId, text, hash }] }
//
// Result:
//  keep:         unchanged decisions. Keep the row, move it to the new version, make it active.
//  upserts:      new or edited decisions. An edit links back to the row it replaces.
//  supersedeIds: active rows that are no longer in the page (edited away, removed, or no
//                longer worded as a decision). They stop matching issues.
//  stale:        the stored data is already from a newer version. Do nothing.
export function planSync(existing, current) {
  const version = Number(current.version);
  if (existing.some((r) => Number(r.page_version) > version)) {
    return { stale: true, keep: [], upserts: [], supersedeIds: [] };
  }

  const byBlock = new Map();
  for (const r of existing) {
    if (!byBlock.has(r.block_id)) byBlock.set(r.block_id, []);
    byBlock.get(r.block_id).push(r);
  }
  for (const rows of byBlock.values()) rows.sort((a, b) => Number(b.page_version) - Number(a.page_version));

  const keep = [];
  const upserts = [];
  const protectedIds = new Set(); // rows that must not be superseded
  for (const d of current.decisions) {
    const latest = (byBlock.get(d.blockId) || [])[0];
    if (latest && latest.content_hash === d.hash) {
      protectedIds.add(latest.id);
      // A person superseded this decision in Tracewise. An unchanged page must not bring it back.
      if (!(latest.status === 'superseded' && Number(latest.manual) > 0)) keep.push({ id: latest.id });
    } else {
      upserts.push({ ...d, supersedesId: latest ? latest.id : null });
      // A row of this same version is rewritten in place by the upsert (same unique key).
      if (latest && Number(latest.page_version) === version) protectedIds.add(latest.id);
    }
  }

  const supersedeIds = existing
    .filter((r) => r.status === 'active' && !protectedIds.has(r.id))
    .map((r) => r.id);
  return { stale: false, keep, upserts, supersedeIds };
}

// A deleted, trashed or draft page: nothing stays active.
export const planRemoval = (existing) => ({
  stale: false,
  keep: [],
  upserts: [],
  supersedeIds: existing.filter((r) => r.status === 'active').map((r) => r.id),
});
