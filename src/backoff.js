// Retry with backoff for API calls. Pure apart from the timer, which tests replace.
export const RETRY_STATUS = new Set([429, 502, 503, 504]);

// call() returns a fetch-style response. Retries only retryable statuses, honours Retry-After,
// stops at maxAttempts or when waiting again would pass the time budget. Returns the last response.
export async function withBackoff(call, {
  maxAttempts = 5, baseMs = 400, maxMs = 6000, budgetMs = 20000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(), random = Math.random,
} = {}) {
  const started = now();
  for (let attempt = 1; ; attempt++) {
    const res = await call();
    if (!RETRY_STATUS.has(res.status) || attempt >= maxAttempts) return res;
    const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    const wait = retryAfter > 0
      ? retryAfter * 1000
      : Math.min(maxMs, baseMs * 2 ** (attempt - 1)) * (0.5 + random() / 2);
    if (now() - started + wait > budgetMs) return res;
    await sleep(wait);
  }
}
