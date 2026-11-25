# Score

How the release score is calculated (`src/score/engine.js`):

1. Start at 100. Each open finding takes points off.
2. Bigger problems take more points (low 2, medium 5, high 10, critical 25).
3. Unsure findings take less: evidence confidence 80 or more counts fully, 40 to 79 counts 25%, below 40 counts nothing.
4. One type of problem can't take off too much (secret 60, decision conflict 30, gate 40, other 30).
5. Bands: 80 or more is Ready, 50 to 79 is At risk, below 50 is Blocked.
6. A confirmed critical secret means Blocked, whatever the score.

All numbers live in `DEFAULT_CONFIG` in `engine.js`. Change them there.

Tests: `tests/score.test.js`

# Decision Memory: records and matching

Goal: warn people when a Jira work item may contradict a decision the team already made.

The big idea: the score is always calculated by plain rules, never by AI guessing. TraceWise only suggests possible conflicts, and a person confirms them.

## 1. Decisions are stored (Confluence to the `decisions` table)

1. The team writes decisions in a Confluence page, using a two-column template table: Decision, Status, Scope, Rationale, Date.
2. `src/decisions/extract.js` reads the page. It also accepts plain sentences that look like decisions (15 to 1000 characters, max 100 per page).
3. A template whose Status is not active raises nothing.
4. `src/decisions/sync.js` decides what to save. It is pure, so it is tested without a database.
5. Each decision is a row in `decisions` (migration v002, plus v012 for `title`, `scope`, `rationale`). The row keeps the page id, page title, page version, block id and a content hash.

How edits are handled (`sync.js`, tested in `tests/decisions.test.js`):
- First read of a page saves the decisions.
- Reading the same page version again changes nothing (idempotent).
- An unchanged decision on a new page version is kept, not duplicated.
- An edited decision becomes a new row and the old row becomes `superseded`.
- A decision block removed from the page is marked `superseded`.
- A stale job (stored data is newer than the job) does nothing.
- Going back to an older wording makes it active again.
- Changing only the rationale changes the hash, so it counts as an edit.

## 2. A work item is matched (`src/decisions/match.js`)

Pure function: no database, no Jira.

1. The issue text is turned into keywords. Small words (the, to, from...) and words shorter than 3 letters are ignored.
2. Each active decision is searched by its text, page title, title, scope and rationale. Superseded decisions never match.
3. The score is BM25, a search-engine score:
   - Rarer shared words count more ("forge sql" counts more than "storage").
   - Repeated words stop adding score after a while (k1 = 1.2).
   - Long decisions are penalised a little (b = 0.75).
4. Boosts multiply the score:
   - Same project: x1.3
   - Same scope (a word of the scope appears in the issue): x1.25
   - Recent decision: up to +20%, fading to nothing after 365 days
5. A decision must share at least 2 keywords with the issue (`minOverlap`) and reach `minScore` (default 0).
6. The best 3 matches are returned, each with its score and the shared words.

Tune `BM25`, `BOOSTS`, `minOverlap` and `minScore` in `match.js`.

Tests: `tests/match.test.js`

## 3. A match becomes a finding (`src/decisions/scan.js`)

1. Each match is saved as a finding of type `decision_conflict` (severity 3, confidence 60 = unclear).
2. The fingerprint is a hash of decision id + issue id, so the same pair never makes a duplicate.
3. The finding keeps in `detail`: issue key, decision id, page id, page title, shared words, score and owner.
4. Scanning again only updates `last_seen_at` and `detail`. It never changes `status`, so a dismissed finding stays dismissed.

## 4. Where people see it

- Findings tab: the finding with a link to the original Confluence decision.
- Decisions tab: the list of decisions (`src/decisions/list.js`), with conflicts attached and pagination (25 per page).
- Jira issue panel (`src/decisions/issue-flags.js`): one card per conflict with the decision, its rationale, scope, date, shared words and a link to the Confluence page.
- Permissions: if the viewer cannot open the Confluence page, the card says only that a restricted decision may conflict. Its text is hidden.

Limits:
- It finds related decisions only. It does not judge whether the issue really contradicts the decision. The person does that with the buttons below.
- Scans happen when a work item or page changes, and Detection can take a few minutes.

# Decision Memory: actions

Goal: let a person say what is really true about a possible conflict.

How it works:
1. The issue panel shows 4 buttons under each conflict card: Confirm conflict, Dismiss, Amend, Supersede.
2. `src/decisions/actions.js` (`planAction`) holds the rules. It is pure, with no Forge and no database.
3. `src/decisions/actions-glue.js` applies the plan to the database. The `decisionAction` resolver in `src/index.js` calls it, after checking the user has the Jira permission EDIT_ISSUES in the project.
4. The glue loads the open finding (it must belong to the project), runs `planAction`, then:
   - saves a row in `decision_feedback` (decision, finding, who, verdict, comment) for the issue and decision pair
   - updates the finding (confidence and/or status)
   - updates the decision if needed (superseded, or new text)
   - logs a row in `finding_events`
   - re-scores the project (`assessRelease(projectKey, 'current')`)
5. In the UI (`static/hello-world/src/App.js`), `DecisionActions` shows the buttons and asks for a reason or new text when needed. `IssuePanel` reloads after every action.

What each button does:
- Confirm: finding stays open and confidence becomes 100, so it deducts full points.
- Dismiss: needs a reason (at least 3 characters, cut to 500). The finding closes (status dismissed) and deducts nothing.
- Amend: needs new text. The decision text is updated and the finding closes.
- Supersede: the old decision becomes `superseded`, so it never matches again, and the finding closes.

Scoring link:
- Matcher findings start at confidence 60 (unclear), which counts 25%.
- Only a Confirm makes the conflict count fully (100 is above the 80 "counts fully" line).
- Dismiss, Amend and Supersede close the finding, so they deduct nothing.

Rescan behavior:
- Scanning the same issue again does not reopen a dismissed finding. The upsert only updates `last_seen_at` and `detail`, never `status`.
- If a decision is amended or replaced, it can get a new id and flag again.

Checked live in Jira (TRAC-8): buttons show, Confirm changed the finding from unclear to confirmed (100), Dismiss removed the card and the finding left the Open list.

Limits:
- Amend changes only the stored text. The Confluence page stays the source of truth, so a later page edit can overwrite it.
- After Confirm, the card stays open with the buttons still visible.
- The optional AI check is skipped (Forge LLM cost).
- Dismissals are stored, but they do not yet change how matching ranks.

Tests: `tests/actions.test.js`

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

# Run and deploy (Windows, PowerShell)

- Tests: `node --test tests/*.test.js`
- Build the UI and deploy: `cd static\hello-world; npm run build; cd ..\..` then `forge deploy -e development`
- Run `forge install --upgrade` only when `manifest.yml` changes.