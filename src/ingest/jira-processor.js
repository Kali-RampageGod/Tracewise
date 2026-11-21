// Handles a "jira_issue" job: scan the issue, re-score the project, then record ingest.
// Dependencies are injected so this can be tested without Forge.
//
// Error rules (the consumer decides retries from the error it receives):
//  - 404: the issue was deleted. Nothing to scan or re-score, treat as done.
//  - 403 / 5xx / 429 / timeouts: rethrown. 5xx/429/timeouts are retried by the consumer.
//  - missing issue key in the job: a bug in the job, fail loudly (not retried).
// Order matters: scan -> gate -> assess -> record. A failure at any step leaves the job
// unrecorded, so the retry repeats it. Scan and assess are both idempotent.
export function makeJiraProcessor({ scanIssue, assess, gate, recordIngest }) {
  return async function processJiraIssue(job) {
    if (!job || !job.sourceRef) {
      throw new Error('jira_issue job has no issue key (sourceRef)');
    }
    try {
      const scanned = await scanIssue(job.projectKey || null, job.sourceRef);
      const projectKey = (scanned && scanned.projectKey) || job.projectKey;
      // Re-check the releases this work item belongs to (status or priority may have changed).
      const versionIds = (scanned && scanned.fixVersionIds) || [];
      if (projectKey && gate && versionIds.length) await gate(projectKey, versionIds);
      if (projectKey) await assess(projectKey);
    } catch (e) {
      if (!(e && e.status === 404)) throw e;
      console.log('TW_SKIP_DELETED', job.sourceRef);
    }
    await recordIngest(job, 'ingest_jira');
  };
}
