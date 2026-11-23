// Forge glue: can the person looking at the page open these pages and work items themselves?
// Calls Jira and Confluence as the VIEWER (asUser), so the answer follows their real permissions.
// Anything that is not a clear "yes" counts as no: restricted, missing, not yet authorised, or an error.
import { route } from '@forge/api';
import { confluenceGet, jiraGet } from '../api';
import { sourceKey } from './rows';

const MAX_CHECKS = 30;

async function canOpen(s) {
  try {
    const res = s.kind === 'page'
      ? await confluenceGet(route`/wiki/api/v2/pages/${s.id}`, { asApp: false })
      : await jiraGet(route`/rest/api/3/issue/${s.key}?fields=summary`, { asApp: false });
    return res.status === 200 ? 'ok' : 'no';
  } catch (e) {
    return 'no';
  }
}

// sources: [{ kind: 'page'|'issue', id|key }] -> Map(sourceKey -> 'ok' | 'no')
export async function checkAccess(sources) {
  const unique = new Map(sources.map((s) => [sourceKey(s), s]));
  const entries = [...unique.entries()];
  const result = new Map();
  await Promise.all(
    entries.slice(0, MAX_CHECKS).map(async ([key, s]) => result.set(key, await canOpen(s)))
  );
  for (const [key] of entries.slice(MAX_CHECKS)) result.set(key, 'no'); // too many to check: hide
  return result;
}
