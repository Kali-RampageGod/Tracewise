// Forge glue: reads page versions from Confluence for the history scan.
import { route } from '@forge/api';
import { confluenceGet, json } from '../api';
import { pageText } from '../decisions/extract';
import { makeHistoryProcessor } from './history';
import { applyHistory, loadExistingSecrets, loadAllowed, isHistoryScanned, markHistoryScanned } from './store';
import { queueHistoryMore, enqueueRemediation } from './queue';

async function fetchMeta(pageId) {
  const res = await confluenceGet(route`/wiki/api/v2/pages/${pageId}`, { asApp: true });
  if (res.status === 404) return null;
  const p = await json(res);
  if (p.status && p.status !== 'current') return null;
  return { title: p.title || '(untitled)', version: p.version && p.version.number, ownerId: p.ownerId || null };
}

async function listVersionNumbers(pageId) {
  const res = await confluenceGet(route`/wiki/api/v2/pages/${pageId}/versions?limit=250`, { asApp: true });
  if (res.status === 403 || res.status === 404) return [];
  return ((await json(res)).results || []).map((v) => Number(v.number));
}

// null = this version cannot be read (restricted or removed): skipped, not an error.
async function fetchVersionText(pageId, n) {
  const res = await confluenceGet(route`/wiki/api/v2/pages/${pageId}?version=${n}&body-format=storage`, { asApp: true });
  if (res.status === 403 || res.status === 404) return null;
  const p = await json(res);
  return pageText(p.body && p.body.storage ? p.body.storage.value : '');
}

export const processHistory = makeHistoryProcessor({
  fetchMeta, listVersionNumbers, fetchVersionText,
  isScanned: isHistoryScanned, markScanned: markHistoryScanned,
  loadExisting: (pageId) => loadExistingSecrets('confluence_page', pageId),
  loadAllowed, applyHistory: async (fresh, ctx) => {
    const r = await applyHistory(fresh, ctx);
    if (r.opened.length) await enqueueRemediation(r.opened);
    return r;
  },
  followUp: queueHistoryMore,
});
