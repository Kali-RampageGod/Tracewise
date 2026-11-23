// Forge glue: scans one page or work item for secrets, saves findings, queues remediation issues.
import { makeSecretScanner } from './sync';
import { loadExistingSecrets, applySecrets, loadAllowed } from './store';
import { enqueueRemediation } from './queue';

const scanner = makeSecretScanner({ load: loadExistingSecrets, loadAllowed, apply: applySecrets });

async function run(ctx) {
  const r = await scanner(ctx);
  if (r.opened.length) await enqueueRemediation(r.opened);
  return r;
}

// Page secrets are site-wide until spaces are mapped to projects.
export const scanPage = ({ pageId, title, version, ownerId, text }) =>
  run({
    sourceType: 'confluence_page', sourceId: String(pageId), projectKey: '_site', text,
    titleFor: (s) => `Page "${title}": possible ${s.name}`,
    detailBase: { pageId: String(pageId), pageTitle: title, pageVersion: version, ownerAccountId: ownerId || null },
  });

export const scanWorkItem = ({ issueId, issueKey, projectKey, reporterId, text }) =>
  run({
    sourceType: 'jira_issue', sourceId: String(issueId), projectKey, text,
    titleFor: (s) => `${issueKey}: possible ${s.name}`,
    detailBase: { issueKey, ownerAccountId: reporterId || null },
  });
