// Pure job handling with injected dependencies, so it can be tested without Forge.
// Contract: a job is marked processed only AFTER its processor succeeded.
// A crash halfway leaves it unmarked, so the retry runs it again.
// Processors must be idempotent (upserts keyed by their own unique keys).
export async function handleJob(job, deps) {
  if (await deps.isProcessed(job.eventKey)) return { status: 'duplicate' };
  await deps.process(job);
  await deps.markProcessed(job);
  return { status: 'processed' };
}

export const isRetriable = (e) =>
  !!e && (e.status === 429 || e.status >= 500 || /timeout|timed out|ECONN|ETIMEDOUT|fetch failed/i.test(String(e.message)));

export const retryDelaySeconds = (retryCount) => Math.min(900, 30 * 2 ** (retryCount || 0));