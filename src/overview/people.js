// Forge glue: display names for Atlassian account ids, cached for ten minutes.
import { route } from '@forge/api';
import { jiraGet, json } from '../api';

const cache = new Map(); // accountId -> { name, at }
const TTL_MS = 10 * 60 * 1000;

async function lookup(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.name;
  let name = null;
  try {
    const res = await jiraGet(route`/rest/api/3/user?accountId=${id}`, { asApp: true });
    if (res.status === 200) name = (await json(res)).displayName || null;
    else console.log('TW_USER_LOOKUP_STATUS', res.status);
  } catch (e) { /* a missing name is fine */ }
  cache.set(id, { name, at: Date.now() });
  return name;
}

export async function displayNames(ids) {
  const out = new Map();
  await Promise.all(ids.slice(0, 20).map(async (id) => { out.set(id, await lookup(id)); }));
  return out;
}
