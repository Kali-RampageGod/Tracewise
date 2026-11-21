// Handles a "confluence_page" job: read the page as it is now, sync its decisions, record ingest.
// Dependencies are injected so this can be tested without Forge.
//
// Also scans the page text for secrets. If decisions or secrets changed, the scores are refreshed.
// It always reads the CURRENT page, never the version named in the job. So late, repeated or
// out-of-order jobs all lead to the same result.
//
// fetchPage(pageId) -> { title, version, decidedAt, storage } or null when the page is gone,
//                      trashed or a draft. Errors (403, 5xx, 429) are rethrown for the consumer.
import { extractDecisions, pageText } from '../decisions/extract.js';
import { planSync, planRemoval } from '../decisions/sync.js';

export function makeConfluenceProcessor({ fetchPage, loadExisting, apply, scanSecrets, rescore, recordIngest }) {
  return async function processConfluencePage(job) {
    if (!job || !job.sourceId) throw new Error('confluence_page job has no page id (sourceId)');
    const pageId = String(job.sourceId);
    const existing = await loadExisting(pageId);
    const page = await fetchPage(pageId);

    let changed = false;
    if (!page) {
      // A deleted page leaves its decisions inactive. Secret findings stay: the secret was exposed.
      const plan = planRemoval(existing);
      await apply(plan, { pageId });
      changed = plan.supersedeIds.length > 0;
    } else {
      const plan = planSync(existing, { version: page.version, decisions: extractDecisions(page.storage) });
      if (!plan.stale) {
        await apply(plan, { pageId, title: page.title, version: page.version, decidedAt: page.decidedAt });
        changed = plan.supersedeIds.length > 0;
        if (scanSecrets) {
          const r = await scanSecrets({ pageId, title: page.title, version: page.version, text: pageText(page.storage) });
          changed = changed || r.changed;
        }
      }
    }
    if (changed && rescore) await rescore();
    await recordIngest(job, 'ingest_confluence');
  };
}
