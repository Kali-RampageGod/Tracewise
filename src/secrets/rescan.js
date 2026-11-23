// Hourly rescan: queues a fresh look at every page or work item that still has an open secret finding.
// It catches secrets that were removed without an event, and applies new allowlist entries.
import sql from '@forge/sql';
import { queueRescan, enqueueRemediation } from './queue';
import { makeBackfill } from './backfill';
import { getConfig } from './remediation-glue';

export async function rescanOpenSecrets(limit = 20) {
  const n = Math.min(50, Math.max(1, Math.floor(limit)));
  const r = await sql
    .prepare(
      `SELECT source_type, source_id, MIN(project_key) AS project_key
         FROM findings WHERE type = 'secret' AND status = 'open' AND source_type IN ('confluence_page', 'jira_issue')
        GROUP BY source_type, source_id ORDER BY MIN(last_seen_at) ASC LIMIT ${n}`
    )
    .execute();
  const hour = Math.floor(Date.now() / 3600000);
  const jobs = r.rows.map((x) => ({
    sourceType: x.source_type,
    sourceId: String(x.source_id),
    sourceRef: x.source_type === 'jira_issue' ? String(x.source_id) : null, // the issue API accepts the id too
    projectKey: x.source_type === 'jira_issue' && x.project_key !== '_site' ? x.project_key : null,
    eventType: 'rescan:secrets',
    eventKey: `rescan:${x.source_type}:${x.source_id}:${hour}`,
    occurredAt: Date.now(),
  }));
  await queueRescan(jobs);
  const remediation = await backfillRemediation();
  return { queued: jobs.length, remediationQueued: remediation.queued };
}

// Open secret findings without a remediation issue, oldest first.
async function listWithoutIssue(limit) {
  const n = Math.min(50, Math.max(1, Math.floor(limit)));
  const r = await sql
    .prepare(
      `SELECT id FROM findings
        WHERE type = 'secret' AND status = 'open' AND remediation_issue_key IS NULL
        ORDER BY first_seen_at ASC LIMIT ${n}`
    )
    .execute();
  return r.rows.map((x) => x.id);
}

export const backfillRemediation = makeBackfill({ getConfig, listWithoutIssue, enqueue: enqueueRemediation });
