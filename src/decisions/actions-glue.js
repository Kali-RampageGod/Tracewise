// Forge glue: applies a decision action to the database. Rules live in actions.js.
import sql from '@forge/sql';
import { newId } from '../id';
import { planAction } from './actions';
import { logEvent } from '../secrets/store';
import { assessRelease } from '../score/store';

// Returns { ok: true, status } or { error }.
export async function performDecisionAction({ projectKey, findingId, action, comment, newText, actor }) {
    // 1. Load the open conflict finding (must belong to this project).
    const r = await sql
        .prepare("SELECT id, status, detail FROM findings WHERE id = ? AND project_key = ? AND type = 'decision_conflict'")
        .bindParams(findingId, projectKey)
        .execute();
    const f = r.rows[0];
    if (!f) return { error: 'Finding not found' };
    if (f.status !== 'open') return { error: 'This finding is already closed' };

    let decisionId = null;
    try { decisionId = JSON.parse(f.detail).decisionId; } catch (e) { /* handled below */ }
    if (!decisionId) return { error: 'Finding has no decision' };

    // 2. Ask the pure rules what to do.
    const plan = planAction(action, { comment, newText });
    if (plan.error) return { error: plan.error };

    // 3. Save the person's verdict (feedback for this issue/decision pair).
    await sql
        .prepare('INSERT INTO decision_feedback (id, decision_id, finding_id, account_id, verdict, comment) VALUES (?, ?, ?, ?, ?, ?)')
        .bindParams(newId(), decisionId, f.id, actor || 'unknown', plan.verdict, plan.comment)
        .execute();

    // 4. Update the finding.
    if (plan.confidence !== null) {
        await sql.prepare('UPDATE findings SET evidence_confidence = ? WHERE id = ?').bindParams(plan.confidence, f.id).execute();
    }
    if (plan.findingStatus !== 'open') {
        await sql
            .prepare("UPDATE findings SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bindParams(plan.findingStatus, f.id)
            .execute();
    }

    // 5. Update the decision (supersede, or amend its text).
    if (plan.decisionStatus) {
        await sql
            .prepare('UPDATE decisions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .bindParams(plan.decisionStatus, decisionId)
            .execute();
    }
    if (plan.newText) {
        await sql
            .prepare('UPDATE decisions SET decision_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .bindParams(plan.newText, decisionId)
            .execute();
    }

    // 6. Audit trail, then refresh the score.
    await logEvent(f.id, 'decision_' + plan.verdict, plan.comment, actor, f.status, plan.findingStatus);
    await assessRelease(projectKey, 'current');
    return { ok: true, status: plan.findingStatus };
}