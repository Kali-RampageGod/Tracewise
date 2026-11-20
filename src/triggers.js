import { Queue } from '@forge/events';
import { normalizeEvent } from './ingest/normalize';

const queue = new Queue({ key: 'tracewise-ingest' });

export async function onSourceEvent(event) {
  const job = normalizeEvent(event);
  if (!job) {
    console.log('TW_SKIP', event.eventType);
    return;
  }
  // One worker per source at a time, so two updates to the same page or issue never race.
  await queue.push({
    body: job,
    concurrency: { key: `${job.sourceType}:${job.sourceId}`, limit: 1 },
  });
  console.log('TW_QUEUED', job.eventKey);
}