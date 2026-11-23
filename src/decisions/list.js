// Shapes database rows into what the Decisions tab shows. Pure: no Forge, no database.
export const PAGE_SIZE = 25;

export function parseStatus(s) {
  return s === 'superseded' || s === 'all' ? s : 'active';
}

// Open decision_conflict findings -> Map(decisionId -> [{ issueKey, title }])
export function groupConflicts(findings) {
  const map = new Map();
  for (const f of findings) {
    let d = null;
    try { d = f.detail ? JSON.parse(f.detail) : null; } catch (e) { continue; }
    if (!d || !d.decisionId) continue;
    if (!map.has(d.decisionId)) map.set(d.decisionId, []);
    map.get(d.decisionId).push({ issueKey: d.issueKey || null, title: f.title });
  }
  return map;
}

// rows: decisions fetched with LIMIT PAGE_SIZE + 1. replacements: rows whose supersedes_id points at a row.
export function shapeDecisions(rows, replacements, findings) {
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const conflicts = groupConflicts(findings);
  const replacedBy = new Map(replacements.map((r) => [r.supersedes_id, r]));
  return {
    hasMore,
    rows: page.map((r) => {
      const next = replacedBy.get(r.id);
      return {
        id: r.id,
        text: r.decision_text,
        status: r.status,
        pageId: r.page_id,
        pageTitle: r.page_title,
        pageVersion: r.page_version,
        decidedAt: r.decided_at || null,
        replacedBy: next ? { id: next.id, text: next.decision_text, pageVersion: next.page_version } : null,
        conflicts: conflicts.get(r.id) || [],
      };
    }),
  };
}

// Hides decisions from pages the viewer cannot open. access: Map('page:<id>' -> 'ok' | 'no').
export function maskDecisions(rows, access) {
  return rows.map((r) =>
    access.get('page:' + r.pageId) === 'ok'
      ? { ...r, restricted: false }
      : { id: r.id, status: r.status, restricted: true, text: 'Restricted decision', pageId: null, pageTitle: null,
          pageVersion: null, decidedAt: null, replacedBy: null, conflicts: [] }
  );
}
