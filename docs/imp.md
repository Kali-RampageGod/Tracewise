# Score

How the release score is calculated (`src/score/engine.js`):

1. Start at 100. Each open finding takes points off.
2. Bigger problems take more points (low 2, medium 5, high 10, critical 25).
3. Unsure findings take less: evidence confidence 80 or more counts fully, 40 to 79 counts 25%, below 40 counts nothing.
4. One type of problem can't take off too much (secret 60, decision conflict 30, gate 40, other 30).
5. Bands: 80 or more is Ready, 50 to 79 is At risk, below 50 is Blocked.
6. A confirmed critical secret means Blocked, whatever the score.

All numbers live in `DEFAULT_CONFIG` in `engine.js`. Change them there.

# Decision Memory (thin slice)

Goal: prove the main feature works before building the other modules.

How it works:
1. A team decision is stored as a row in the `decisions` table (page id, text, status).
2. A Jira issue is turned into keywords, and ignored little words (`src/decisions/match.js`).
3. If the issue and an active decision share 2 or more keywords, the decision is returned as a related match.
4. A match becomes a finding (type `decision_conflict`, confidence 60 = unclear), shown on the Findings tab with a link to the original Confluence decision.

Limits:
- It finds related decisions only. It does not yet judge whether the issue contradicts the decision (the AI step comes later).
- Superseded decisions never match.
- The minimum overlap (default 2) can be tuned.

Tests: `tests/match.test.js`


# Secret Sentinel

Goal: find leaked secrets in Jira issues without ever storing the secret.

How it works:
1. `src/secrets/detectors.js` is a list of secret shapes (AWS, GitHub, Google, Slack, Stripe keys, private keys, generic `api_key=...`). Each has a name, a regex and a severity.
2. `src/secrets/sentinel.js` runs the text through every detector. For each match it keeps only a fingerprint (sha256 hash) and a redacted preview (`AKIA****MPLE`). The real secret is thrown away.
3. The same secret twice in one text counts as one finding.
4. `src/decisions/scan.js` scans the issue summary, description and comments. Each secret is saved as a `secret` finding.
5. The Findings tab shows the redacted preview.

Scoring:
- Specific keys (severity 4) get confidence 90, so the score engine marks the release Blocked.
- The generic `api_key=...` pattern (severity 3) gets confidence 60, so it only counts 25%.

Cleanup behavior:
- Scanning the same secret again makes no duplicate (unique key on project, type, source, fingerprint).
- If the secret is removed from the issue or comment, the next scan closes its finding.
- If the same secret comes back, the finding reopens.
- The "Clear scanned secrets" button on the settings page deletes all scanned secret findings.

Limits:
- Scans happen only when you run a scan. There is no automatic trigger yet.
- Removing a secret from Jira does not make it safe. Jira keeps issue history, so a real key must still be rotated.
- Regex can miss unusual secrets and can flag lookalikes.

Tests: `tests/sentinel.test.js`