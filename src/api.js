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