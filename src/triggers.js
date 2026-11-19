import { Queue } from '@forge/events';
import { normalizeEvent } from './ingest/normalize';

const queue = new Queue({ key: 'tracewise-ingest' });

export async function onSourceEvent(event, context) {
  const job = normalizeEvent(event);
  if (!job) {
    console.log('TW_SKIP', event.eventType);
    if (String(event.eventType).startsWith('avi:confluence')) {
      console.log('TW_KEYS', Object.keys(event).join(','));
      for (const k of ['page', 'content']) {
        if (event[k]) console.log('TW_' + k.toUpperCase(), JSON.stringify(event[k]).slice(0, 600));
      }
    }
    return;
  }
  // One worker per source at a time, so two updates to the same issue never race.
  await queue.push({
    body: job,
    concurrency: { key: `${job.sourceType}:${job.sourceId}`, limit: 1 },
  });
  console.log('TW_QUEUED', job.eventKey);
}