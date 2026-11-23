// Scans OLD versions of a Confluence page for secrets (a secret deleted last week is still exposed).
// Works through at most `perRun` unscanned versions, newest first, and asks for a follow-up job if
// more are left. Each version is marked scanned only after it was handled, so a retry never skips one.
// Dependencies are injected for tests.
import { findSecrets } from './sentinel.js';
import { planHistorySecrets } from './sync.js';

export const MAX_VERSIONS = 100; // newest versions considered per page
export const PER_RUN = 8;

export function makeHistoryProcessor({
  fetchMeta, listVersionNumbers, fetchVersionText, isScanned, markScanned,
  loadExisting, loadAllowed, applyHistory, followUp, find = findSecrets, perRun = PER_RUN,
}) {
  return async function processHistory(job) {
    if (!job || !job.sourceId) throw new Error('confluence_history job has no page id (sourceId)');
    const pageId = String(job.sourceId);
    const meta = await fetchMeta(pageId);
    if (!meta) return { skipped: 'page is gone' };

    const numbers = (await listVersionNumbers(pageId)).filter((n) => n < meta.version).sort((a, b) => b - a).slice(0, MAX_VERSIONS);
    const todo = [];
    for (const n of numbers) if (!(await isScanned(pageId, n))) todo.push(n);
    const batch = todo.slice(0, perRun);
    let opened = [];

    for (const n of batch) {
      const text = await fetchVersionText(pageId, n); // null = not readable (restricted or deleted version)
      if (text !== null) {
        let found = find(text);
        if (found.length && loadAllowed) {
          const allowed = await loadAllowed(found.map((s) => s.fingerprint), { sourceType: 'confluence_page', sourceId: pageId });
          found = found.filter((s) => !allowed.has(s.fingerprint));
        }
        const fresh = planHistorySecrets(await loadExisting(pageId), found);
        if (fresh.length) {
          const res = (await applyHistory(fresh, { pageId, title: meta.title, version: n, ownerAccountId: meta.ownerId })) || {};
          opened = opened.concat(res.opened || []);
        }
      }
      await markScanned(pageId, n);
    }
    if (todo.length > batch.length && followUp) await followUp(pageId, todo[batch.length]);
    return { scanned: batch.length, remaining: todo.length - batch.length, opened };
  };
}
