# Decision Memory: retrieval measurement

Date: 2026-11-25
Method: `node eval/run.js` on 10 decisions and 40 labeled issues
(25 related to a decision, 15 unrelated). Metrics are per issue and decision pair.
Raw tables: `results_overlap2.csv`, `results_overlap1.csv`.

| Config | Precision | Recall | F1 |
|---|---|---|---|
| minOverlap 2, minScore 0 (old default) | 0.938 | 0.600 | 0.73 |
| minOverlap 1, minScore 0 | 0.676 | 1.000 | 0.81 |
| minOverlap 1, minScore 3.0 (best F1) | 0.857 | 0.960 | 0.91 |
| minOverlap 1, minScore 3.5 (chosen) | 0.852 | 0.920 | 0.89 |

Chosen: minOverlap 1 and minScore 3.5, set in `src/decisions/scan.js`.
It sits in the middle of the stable plateau (3.0 to 4.0). Recall falls
sharply at 4.5, so the threshold stays away from that cliff.

Verified live: scanning TRAC-9 ("Set up MongoDB for the orders database")
found the MySQL decision.

AI verification: not built, so not measured. Forge's LLM API has no free
quota and adding it needs admin approval, so it was left out. The 4 remaining
false alarms in the best config are where it would help later.

## Limits
- The data is synthetic and I wrote the labels. No real Jira history was used.
- BM25 scores grow with the number of decisions, so 3.5 is tuned for about
  10 decisions. Re-measure for bigger sets.
- Decisions without phrases like "We will" or "will not" are not extracted
  from Confluence pages, so they never reach the matcher.