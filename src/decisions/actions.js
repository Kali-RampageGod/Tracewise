// Pure rules for decision actions. No Forge, no database.
export const ACTIONS = ['confirm', 'amend', 'supersede', 'dismiss'];

// What each action does to the finding and the decision.
// confirm   -> real conflict: finding stays open
// dismiss   -> not a conflict: finding closes, saved as feedback
// amend     -> decision text changed: finding closes, rescan later
// supersede -> old decision replaced: old status 'superseded'
export function planAction(action, input = {}) {
    if (!ACTIONS.includes(action)) return { error: 'Unknown action' };
    if (action === 'dismiss') {
        const reason = String(input.comment || '').trim();
        if (reason.length < 3) return { error: 'Add a short reason' };
        return { verdict: 'dismiss', comment: reason.slice(0, 500), findingStatus: 'dismissed', decisionStatus: null, confidence: null };
    }
    if (action === 'confirm') {
        // Confirmed = full points. 100 is above the engine's 80 "counts fully" line.
        return { verdict: 'confirm', comment: null, findingStatus: 'open', decisionStatus: null, confidence: 100 };
    }
    if (action === 'amend') {
        const text = String(input.newText || '').trim();
        if (!text) return { error: 'New decision text needed' };
        return { verdict: 'amend', comment: null, findingStatus: 'resolved', decisionStatus: null, newText: text, confidence: null };
    }
    return { verdict: 'supersede', comment: null, findingStatus: 'resolved', decisionStatus: 'superseded', confidence: null };
}