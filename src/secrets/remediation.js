// Creates exactly one remediation issue per open secret finding, even when the job is retried.
// Order: claim -> (look for an existing issue if the claim is old) -> create -> save the key.
// A crash between "create" and "save the key" is healed on retry: the old claim sends us to a
// search by label before anything new is created. Dependencies are injected for tests.
import { buildRemediationIssue, claimState } from './lifecycle.js';

export function makeRemediation({ getConfig, loadFinding, claim, findByLabel, createIssue, saveKey, logEvent, now = () => Date.now() }) {
  return async function remediate(findingId) {
    const cfg = await getConfig();
    if (!cfg || !cfg.enabled || !cfg.projectKey) return { skipped: 'remediation is not configured' };

    const f = await loadFinding(findingId);
    if (!f) return { skipped: 'finding not found' };
    if (f.status !== 'open') return { skipped: 'finding is ' + f.status };

    const state = claimState({
      issueKey: f.remediation_issue_key,
      claimedAtMs: f.claimed_at != null ? Number(f.claimed_at) * 1000 : null,
      nowMs: now(),
    });
    if (state === 'done') return { issueKey: f.remediation_issue_key, existing: true };
    if (state === 'wait') {
      const e = new Error('Remediation already in progress, retry timeout');
      e.status = 503; // retriable: the consumer retries with backoff
      throw e;
    }

    let detail = {};
    try { detail = f.detail ? JSON.parse(f.detail) : {}; } catch (e) { detail = {}; }
    const issue = buildRemediationIssue({ finding: { id: f.id, preview: f.redacted_preview, detail }, baseUrl: cfg.baseUrl });

    if (state === 'search') {
      const found = await findByLabel(issue.label);
      if (found) {
        await saveKey(f.id, found);
        await logEvent(f.id, 'remediation_linked', 'Found existing issue ' + found);
        return { issueKey: found, existing: true };
      }
    }
    await claim(f.id);
    const key = await createIssue({ cfg, issue, assigneeAccountId: detail.ownerAccountId || null });
    await saveKey(f.id, key);
    await logEvent(f.id, 'remediation_created', 'Created ' + key);
    return { issueKey: key, created: true };
  };
}
