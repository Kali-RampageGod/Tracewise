import { route } from '@forge/api';
import { Queue } from '@forge/events';
import sql from '@forge/sql';
import { confluenceGet, jiraGet, json } from '../api';
import { newId } from '../id';
import { jobFromConfluencePage, jobFromJiraIssue, nextCursor, chunk } from './normalize';
import { isStale } from './freshness';

const queue = new Queue({ key: 'tracewise-ingest' });
const OVERLAP_MS = 15 * 60 * 1000;      // re-read the last 15 minutes: duplicates are harmless
const FIRST_RUN_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES = 8;                     // at most 400 items per source per run

async function getCursor(scanType) {
  const r = await sql
    .prepare("SELECT cursor_value FROM scan_state WHERE project_key = '_site' AND scan_type = ?")
    .bindParams(scanType)
    .execute();
  const v = r.rows.length ? Number(r.rows[0].cursor_value) : 0;
  return v > 0 ? v - OVERLAP_MS : Date.now() - FIRST_RUN_MS;
}

// Advances the cursor. Called only after a clean run.
async function saveCursor(scanType, startedMs) {
  await sql
    .prepare(
      `INSERT INTO scan_state (id, project_key, scan_type, cursor_value, status, last_started_at, last_finished_at, error_text)
       VALUES (?, '_site', ?, ?, 'idle', FROM_UNIXTIME(?), CURRENT_TIMESTAMP, NULL)
       ON DUPLICATE KEY UPDATE cursor_value = VALUES(cursor_value), status = 'idle',
         last_started_at = VALUES(last_started_at), last_finished_at = CURRENT_TIMESTAMP,
         error_text = NULL`
    )
    .bindParams(newId(), scanType, String(startedMs), Math.floor(startedMs / 1000))
    .execute();
}

// Records a failure without touching the cursor, so the next run re-reads the same window.
async function markError(scanType, message) {
  await sql
    .prepare(
      `INSERT INTO scan_state (id, project_key, scan_type, status, last_finished_at, error_text)
       VALUES (?, '_site', ?, 'error', CURRENT_TIMESTAMP, ?)
       ON DUPLICATE KEY UPDATE status = 'error', last_finished_at = CURRENT_TIMESTAMP,
         error_text = VALUES(error_text)`
    )
    .bindParams(newId(), scanType, String(message).slice(0, 500))
    .execute();
}

async function enqueue(jobs) {
  let n = 0;
  for (const part of chunk(jobs, 50)) {
    await queue.push(
      part.map((job) => ({
        body: job,
        concurrency: { key: `${job.sourceType}:${job.sourceId}`, limit: 1 },
      }))
    );
    n += part.length;
  }
  return n;
}

async function scanConfluence(sinceMs) {
  const jobs = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const path = cursor
      ? route`/wiki/api/v2/pages?sort=-modified-date&limit=${PAGE_SIZE}&cursor=${cursor}`
      : route`/wiki/api/v2/pages?sort=-modified-date&limit=${PAGE_SIZE}`;
    const data = await json(await confluenceGet(path, { asApp: true }));
    let reachedOld = false;
    for (const p of data.results || []) {
      const job = jobFromConfluencePage(p);
      if (!job) continue;
      if (job.occurredAt && job.occurredAt < sinceMs) {
        reachedOld = true;
        break;
      }
      jobs.push(job);
    }
    cursor = nextCursor(data._links);
    if (reachedOld || !cursor) break;
  }
  return enqueue(jobs);
}

async function scanJira(sinceMs) {
  const minutes = Math.max(5, Math.ceil((Date.now() - sinceMs) / 60000));
  const jql = `updated >= -${minutes}m ORDER BY updated DESC`;
  const jobs = [];
  let token = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const path = token
      ? route`/rest/api/3/search/jql?jql=${jql}&fields=updated,project&maxResults=${PAGE_SIZE}&nextPageToken=${token}`
      : route`/rest/api/3/search/jql?jql=${jql}&fields=updated,project&maxResults=${PAGE_SIZE}`;
    const data = await json(await jiraGet(path, { asApp: true }));
    for (const issue of data.issues || []) {
      const job = jobFromJiraIssue(issue);
      if (job) jobs.push(job);
    }
    token = data.nextPageToken || null;
    if (!token) break;
  }
  return enqueue(jobs);
}

export async function reconcile() {
  const report = {};
  for (const [name, scan] of [
    ['reconcile_confluence', scanConfluence],
    ['reconcile_jira', scanJira],
  ]) {
    const started = Date.now();
    try {
      const since = await getCursor(name);
      report[name] = { queued: await scan(since) };
      await saveCursor(name, started); // advance only after a clean run
    } catch (e) {
      report[name] = { error: e.message };
      await markError(name, e.message);
    }
  }
  console.log('TW_RECONCILE', JSON.stringify(report));
  return report;
}

// Called by the Release Gate and the advisor before they answer, so decisions
// are never made on data older than maxAgeSeconds.
// Stale if either scan is missing, failed, or too old.
export async function refreshIfStale(maxAgeSeconds = 120) {
  const r = await sql
    .prepare(
      `SELECT MIN(UNIX_TIMESTAMP(last_finished_at)) AS finished, COUNT(*) AS n
         FROM scan_state
        WHERE project_key = '_site' AND scan_type IN ('reconcile_confluence', 'reconcile_jira')
          AND status = 'idle'`
    )
    .execute();
  const row = r.rows[0] || {};
  const complete = Number(row.n) === 2;
  const finished = complete && row.finished != null ? Number(row.finished) * 1000 : null;
  if (!isStale(finished, Date.now(), maxAgeSeconds * 1000)) return { refreshed: false };
  return { refreshed: true, report: await reconcile() };
}