import sql from '@forge/sql';
import { newId } from '../id';
import { scanIssue } from '../decisions/scan';
import { makeJiraProcessor } from './jira-processor';

export async function recordIngest(job, scanType) {
  await sql
    .prepare(
      `INSERT INTO scan_state (id, project_key, scan_type, cursor_value, status, last_finished_at)
       VALUES (?, ?, ?, ?, 'idle', CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
         cursor_value = IF(CAST(cursor_value AS UNSIGNED) < CAST(VALUES(cursor_value) AS UNSIGNED),
                           VALUES(cursor_value), cursor_value),
         last_finished_at = CURRENT_TIMESTAMP`
    )
    .bindParams(newId(), job.projectKey || '_unknown', scanType, String(job.occurredAt || 0))
    .execute();
}

export const processors = {
  jira_issue: makeJiraProcessor({ scanIssue, recordIngest }),
  confluence_page: (job) => recordIngest(job, 'ingest_confluence'),
};