import sql from '@forge/sql';
import { InvocationError, InvocationErrorCode } from '@forge/events';
import { handleJob, isRetriable, retryDelaySeconds } from './ingest/handler';
import { processors } from './ingest/processors';

const deps = {
  isProcessed: async (key) => {
    const r = await sql.prepare('SELECT 1 AS x FROM processed_events WHERE event_key = ?').bindParams(key).execute();
    return r.rows.length > 0;
  },
  markProcessed: async (job) => {
    await sql
      .prepare(
        `INSERT INTO processed_events (event_key, event_type) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE processed_at = CURRENT_TIMESTAMP`
      )
      .bindParams(job.eventKey, job.eventType)
      .execute();
  },
  process: async (job) => {
    const p = processors[job.sourceType];
    if (!p) throw new Error('No processor for ' + job.sourceType);
    await p(job);
  },
};

export async function handler(event) {
  const job = event.body;
  try {
    const r = await handleJob(job, deps);
    console.log('TW_JOB', job.eventKey, r.status);
  } catch (e) {
    const retryCount = event.retryContext ? event.retryContext.retryCount : 0;
    if (isRetriable(e) && retryCount < 6) {
      console.log('TW_JOB_RETRY', job.eventKey, retryCount, e.message);
      return new InvocationError({
        retryAfter: retryDelaySeconds(retryCount),
        retryReason: e.status === 429
          ? InvocationErrorCode.FUNCTION_UPSTREAM_RATE_LIMITED
          : InvocationErrorCode.FUNCTION_RETRY_REQUEST,
      });
    }
    console.log('TW_JOB_FAILED', job.eventKey, e.message);
    throw e;
  }
}