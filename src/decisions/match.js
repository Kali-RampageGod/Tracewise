// Keyword matcher: "does this issue talk about the same things as a decision?"
// Pure function: no database, no Jira. It finds related decisions only.
// It does NOT judge yet whether the issue contradicts the decision.

// Small words that carry no meaning. They are ignored.
const STOP = new Set(('a an the and or but if of to in on at by for with from as is are was were be been it its this that these those ' +
    'we will would should can could not no do does did use using used up into onto over under about our their his her you your i ' +
    'set make add create new get let have has had than then so also all any more most some such only own same too very').split(' '));

// Turns text into a set of lowercase keywords.
export function tokenize(text) {
    const words = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9_.+-]*/g) || [];
    const out = new Set();
    for (const w of words) {
        const t = w.replace(/[.+-]+$/, ''); // cut trailing "." or "-"
        if (t.length >= 3 && !STOP.has(t)) out.add(t);
    }
    return out;
}

// Returns the best (up to 3) active decisions that share at least
// `minOverlap` keywords with the issue text.
export function findMatches(issueText, decisions, minOverlap = 2) {
    const issueWords = tokenize(issueText);
    const hits = [];
    for (const d of decisions) {
        if (d.status !== 'active') continue; // superseded decisions raise nothing
        const shared = [...tokenize(d.decision_text + ' ' + (d.page_title || ''))]
            .filter((w) => issueWords.has(w));
        if (shared.length >= minOverlap) hits.push({ decision: d, score: shared.length, shared });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 3);
}