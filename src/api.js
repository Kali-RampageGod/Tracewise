import api from '@forge/api';
import { withBackoff } from './backoff';

export class ApiError extends Error {
  constructor(status, body) {
    super(`API ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
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
// `path` must be a route`...` template from @forge/api, like every Forge request.
// Writes are never retried automatically: a retry after a lost response could create a duplicate.
export const jiraWrite = (path, { method = 'POST', body } = {}) =>
  api.asApp().requestJira(path, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
