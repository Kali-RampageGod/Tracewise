// Forge glue: pushes secret-related jobs onto the ingest queue (same queue, same consumer).
import { Queue } from '@forge/events';

const queue = new Queue({ key: 'tracewise-ingest' });
const base = (sourceType, sourceId, eventKey, eventType) => ({
  sourceType, sourceId: String(sourceId), sourceRef: null, projectKey: null, eventType, eventKey, occurredAt: Date.now(),
});

async function push(jobs, delayInSeconds) {
  if (!jobs.length) return;
  await queue.push(
    jobs.map((job) => ({ body: job, concurrency: { key: `${job.sourceType}:${job.sourceId}`, limit: 1 } })),
    delayInSeconds ? { delayInSeconds } : undefined
  );
}

// The minute bucket keeps a reopened finding from being skipped as a duplicate job.
// Double creation is prevented by the claim in the database, not by this key.
export const enqueueRemediation = (ids) =>
  push(ids.map((id) => base('secret_remediation', id, `remediation:${id}:${Math.floor(Date.now() / 60000)}`, 'secret:remediation')));

export const queueHistory = (pageId, version) =>
  push([base('confluence_history', pageId, `history:${pageId}:v${version}`, 'secret:history')]);

// More old versions are left: a new job with its own key, started a few seconds later.
export const queueHistoryMore = (pageId, nextVersion) =>
  push([base('confluence_history', pageId, `history:${pageId}:more:${nextVersion}`, 'secret:history')], 5);

export const queueRescan = (jobs) => push(jobs);
