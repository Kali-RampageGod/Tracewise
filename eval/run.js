import fs from 'node:fs';
import { findMatches } from '../src/decisions/match.js';

const data = JSON.parse(fs.readFileSync(new URL('./data.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-12-10'); // fixed so recency boost is stable
const MIN_OVERLAP = Number(process.env.MIN_OVERLAP ?? 2);

const runs = data.issues.map((i) => ({
    gold: new Set(i.gold),
    hits: findMatches(i.text, data.decisions, { projectKey: i.project_key, minOverlap: MIN_OVERLAP, minScore: 0, now: NOW })
        .map((h) => ({ id: h.decision.id, score: h.score })),
}));

const rows = [['minScore', 'TP', 'FP', 'FN', 'precision', 'recall', 'f1']];
for (let t = 0; t <= 10; t += 0.5) {
    let tp = 0, fp = 0, fn = 0;
    for (const r of runs) {
        const pred = new Set(r.hits.filter((h) => h.score >= t).map((h) => h.id));
        for (const id of pred) r.gold.has(id) ? tp++ : fp++;
        for (const id of r.gold) if (!pred.has(id)) fn++;
    }
    const p = tp + fp ? tp / (tp + fp) : 1;
    const rc = tp + fn ? tp / (tp + fn) : 1;
    const f1 = p + rc ? (2 * p * rc) / (p + rc) : 0;
    rows.push([t, tp, fp, fn, p.toFixed(3), rc.toFixed(3), f1.toFixed(3)]);
}
fs.writeFileSync(new URL('./results_retrieval.csv', import.meta.url), rows.map((r) => r.join(',')).join('\n') + '\n');
console.table(rows.slice(1).map((r) => Object.fromEntries(rows[0].map((k, i) => [k, r[i]]))));