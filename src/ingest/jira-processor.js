// Handles a "jira_issue" job: scan the issue, then record that we ingested it.
// Dependencies are injected so this can be tested without Forge.
//
// Error rules (the consumer decides retries from the error it receives):
//  - 404: the issue was deleted. Nothing to scan, treat as done.
//  - 403 / 5xx / 429 / timeouts: rethrown. 5xx/429/timeouts are retried by the consumer.
//  - missing issue key in the job: a bug in the job, fail loudly (not retried).
export function makeJiraProcessor({ scanIssue, recordIngest }) {
  return async function processJiraIssue(job) {
    if (!job || !job.sourceRef) {
      throw new Error('jira_issue job has no issue key (sourceRef)');
    }
    try {
      await scanIssue(job.projectKey || null, job.sourceRef);
    } catch (e) {
      if (!(e && e.status === 404)) throw e;
      console.log('TW_SKIP_DELETED', job.sourceRef);
    }
    // Only after a successful scan (or a deleted issue): advance the ingest cursor.
    await recordIngest(job, 'ingest_jira');
  };
}