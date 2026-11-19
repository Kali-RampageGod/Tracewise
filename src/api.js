import api from '@forge/api';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = new Set([429, 502, 503, 504]);

export class ApiError extends Error {
  constructor(status, body) {
    super(`API ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
  }
}

async function withBackoff(call, { maxAttempts = 5, baseMs = 400, maxMs = 6000, budgetMs = 20000 } = {}) {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    const res = await call();
    if (!RETRY_STATUS.has(res.status) || attempt >= maxAttempts) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = retryAfter > 0
      ? retryAfter * 1000
      : Math.min(maxMs, baseMs * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
    if (Date.now() - started + wait > budgetMs) return res;
    await sleep(wait);
  }
}

const who = (asApp) => (asApp ? api.asApp() : api.asUser());

// `path` must be a route`...` template from @forge/api, as Forge requires.
export const confluenceGet = (path, { asApp = false, ...opts } = {}) =>
  withBackoff(() => who(asApp).requestConfluence(path, { headers: { Accept: 'application/json' } }), opts);

export const jiraGet = (path, { asApp = false, ...opts } = {}) =>
  withBackoff(() => who(asApp).requestJira(path, { headers: { Accept: 'application/json' } }), opts);

// Returns parsed JSON or throws ApiError.
export async function json(res) {
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}