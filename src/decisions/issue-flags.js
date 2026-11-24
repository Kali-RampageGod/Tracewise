// Shapes what the Jira issue panel shows: the open decision conflicts of one work item,
// each with the decision's rationale. Pure: no Forge, no database.
// findings: open decision_conflict rows (title, detail JSON). decisions: rows of the decisions table.
// access: Map('page:<id>' -> 'ok' | 'no') for the viewer.
export function shapeIssueFlags(findings, decisions, access) {
    const byId = new Map(decisions.map((d) => [d.id, d]));
    const flags = [];
    for (const f of findings) {
        let detail = null;
        try { detail = f.detail ? JSON.parse(f.detail) : null; } catch (e) { continue; }
        if (!detail || !detail.decisionId) continue;
        const d = byId.get(detail.decisionId);
        if (!d || access.get('page:' + d.page_id) !== 'ok') {
            flags.push({ findingId: f.id, restricted: true, score: Number(detail.score) || 0 });
            continue;
        }
        flags.push({
            findingId: f.id,
            restricted: false,
            title: d.title || d.page_title,
            text: d.decision_text,
            rationale: d.rationale || null,
            scope: d.scope || null,
            decidedAt: d.decided_at || null,
            pageId: d.page_id,
            pageTitle: d.page_title,
            shared: Array.isArray(detail.shared) ? detail.shared : [],
            score: Number(detail.score) || 0,
        });
    }
    return flags.sort((a, b) => b.score - a.score);
}