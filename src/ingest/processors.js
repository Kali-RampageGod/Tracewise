import sql from '@forge/sql';
import { newId } from '../id';
import { scanIssue } from '../decisions/scan';
import { makeJiraProcessor } from './jira-processor';
import { makeConfluenceProcessor } from './confluence-processor';
import { fetchPage, loadExisting, apply } from './confluence-store';
import { assessRelease } from '../score/store';
import { gate } from '../gate';
import { makeSecretScanner } from '../secrets/page-sync';
import { loadExistingSecrets, applySecrets } from '../secrets/page-store';

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

const scanSecrets = makeSecretScanner({ load: loadExistingSecrets, apply: applySecrets });

// Page changes affect every project (decisions and page secrets are site-wide), so re-score the known ones.
async function rescoreKnownProjects() {
  const r = await sql
    .prepare("SELECT DISTINCT project_key FROM release_assessments WHERE release_id = 'current' LIMIT 20")
    .execute();
  for (const row of r.rows) await assessRelease(row.project_key, 'current');
}

export const processors = {
  jira_issue: makeJiraProcessor({
    scanIssue,
    assess: (projectKey) => assessRelease(projectKey, 'current'),
    gate: (projectKey, versionIds) => gate.refreshVersions(projectKey, versionIds),
    recordIngest,
  }),
  confluence_page: makeConfluenceProcessor({ fetchPage, loadExisting, apply, scanSecrets, rescore: rescoreKnownProjects, recordIngest }),
};