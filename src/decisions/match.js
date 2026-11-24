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

// Same as tokenize, but keeps repeats (BM25 needs to count how often a word appears).
export function tokenizeList(text) {
    const words = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9_.+-]*/g) || [];
    const out = [];
    for (const w of words) {
        const t = w.replace(/[.+-]+$/, '');
        if (t.length >= 3 && !STOP.has(t)) out.push(t);
    }
    return out;
}

// BM25 constants. k1: how fast repeated words stop adding score. b: how much long texts are penalised.
export const BM25 = { k1: 1.2, b: 0.75 };

// What a decision is searched by: its text, page title, scope and rationale.
const docText = (d) =>
    [d.decision_text, d.page_title, d.title, d.scope, d.rationale].filter(Boolean).join(' ');

// Boosts multiply the BM25 score. Tune these (and minScore) after measuring on labelled pairs.
export const BOOSTS = { project: 1.3, scope: 1.25, recency: 0.2, recencyDays: 365 };
export const DEFAULT_MIN_SCORE = 0;

// Extra weight for decisions that are more likely to apply to this issue.
function boostFor(d, query, projectKey, now) {
    let m = 1;
    // Same project: the decision belongs to the project, or its text names the project key.
    if (projectKey) {
        const key = projectKey.toLowerCase();
        if ((d.project_key && d.project_key.toLowerCase() === key) || tokenize(docText(d)).has(key)) m *= BOOSTS.project;
    }
    // Same scope: a word of the decision's scope also appears in the issue.
    if (d.scope && [...tokenize(d.scope)].some((w) => query.has(w))) m *= BOOSTS.scope;
    // Recency: up to +20% for a decision made today, fading to nothing after a year.
    const t = d.decided_at ? new Date(d.decided_at).getTime() : NaN;
    if (!Number.isNaN(t)) {
        const ageDays = Math.max(0, (now - t) / 864e5);
        m *= 1 + BOOSTS.recency * Math.max(0, 1 - ageDays / BOOSTS.recencyDays);
    }
    return m;
}

// Returns the best (up to 3) active decisions ranked by BM25 score times boosts, that share at
// least `minOverlap` keywords with the issue text and reach `minScore`.
// Third argument: a number (minOverlap, as before) or { minOverlap, minScore, projectKey, now }.
// Result: [{ decision, score, shared }]
export function findMatches(issueText, decisions, opts = {}) {
    const o = typeof opts === 'number' ? { minOverlap: opts } : opts || {};
    const minOverlap = o.minOverlap ?? 2;
    const minScore = o.minScore ?? DEFAULT_MIN_SCORE;
    const now = o.now ?? Date.now();
    const active = decisions.filter((d) => d.status === 'active'); // superseded decisions raise nothing
    if (!active.length) return [];
    const query = tokenize(issueText);
    if (!query.size) return [];

    // Count words per decision, and in how many decisions each word appears.
    const docs = active.map((d) => {
        const words = tokenizeList(docText(d));
        const tf = new Map();
        for (const w of words) tf.set(w, (tf.get(w) || 0) + 1);
        return { decision: d, tf, len: words.length };
    });
    const df = new Map();
    for (const doc of docs) for (const w of doc.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    const avgLen = docs.reduce((n, d) => n + d.len, 0) / docs.length || 1;

    const hits = [];
    for (const doc of docs) {
        let score = 0;
        const shared = [];
        for (const w of query) {
            const f = doc.tf.get(w);
            if (!f) continue;
            shared.push(w);
            const n = df.get(w);
            const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)); // always above 0
            score += idf * ((f * (BM25.k1 + 1)) / (f + BM25.k1 * (1 - BM25.b + BM25.b * (doc.len / avgLen))));
        }
        if (shared.length < minOverlap) continue;
        score *= boostFor(doc.decision, query, o.projectKey, now);
        if (score >= minScore) hits.push({ decision: doc.decision, score, shared });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 3);
}