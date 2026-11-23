// Forge glue: creates the remediation issue in Jira.
import sql from '@forge/sql';
import { route } from '@forge/api';
import { jiraGet, jiraWrite, json, ApiError } from '../api';
import { makeRemediation } from './remediation';
import { logEvent } from './store';

export async function getConfig() {
  const r = await sql
    .prepare("SELECT enabled, config FROM project_rules WHERE project_key = '_site' AND rule_key = 'secret_remediation'")
    .execute();
  if (!r.rows.length) return null;
  let cfg = {};
  try { cfg = JSON.parse(r.rows[0].config || '{}'); } catch (e) { cfg = {}; }
  return { enabled: !!Number(r.rows[0].enabled), projectKey: cfg.projectKey || null };
}

let cachedBase = null;
async function baseUrl() {
  if (!cachedBase) cachedBase = (await json(await jiraGet(route`/rest/api/3/serverInfo`, { asApp: true }))).baseUrl;
  return cachedBase;
}

async function loadFinding(id) {
  const r = await sql
    .prepare(
      `SELECT id, status, redacted_preview, detail, remediation_issue_key, UNIX_TIMESTAMP(remediation_claimed_at) AS claimed_at
         FROM findings WHERE id = ? AND type = 'secret'`
    )
    .bindParams(id)
    .execute();
  return r.rows[0] || null;
}

const claim = (id) =>
  sql.prepare('UPDATE findings SET remediation_claimed_at = CURRENT_TIMESTAMP WHERE id = ?').bindParams(id).execute();
const saveKey = (id, key) =>
  sql.prepare('UPDATE findings SET remediation_issue_key = ? WHERE id = ?').bindParams(key, id).execute();

async function findByLabel(label) {
  const jql = `labels = "${label}"`;
  const data = await json(await jiraGet(route`/rest/api/3/search/jql?jql=${jql}&fields=key&maxResults=1`, { asApp: true }));
  return data.issues && data.issues[0] ? data.issues[0].key : null;
}

async function createIssue({ cfg, issue, assigneeAccountId }) {
  const meta = await json(await jiraGet(route`/rest/api/3/issue/createmeta/${cfg.projectKey}/issuetypes`, { asApp: true }));
  const types = meta.issueTypes || meta.values || [];
  const type = types.find((t) => t.name === 'Task' && !t.subtask) || types.find((t) => !t.subtask);
  if (!type) throw new Error('No usable issue type in project ' + cfg.projectKey);

  const fields = {
    project: { key: cfg.projectKey }, issuetype: { id: type.id }, summary: issue.summary,
    description: issue.description, labels: ['tracewise', issue.label],
  };
  let res = await jiraWrite(route`/rest/api/3/issue`, { body: { fields: assigneeAccountId ? { ...fields, assignee: { accountId: assigneeAccountId } } : fields } });
  if (res.status === 400 && assigneeAccountId) {
    const text = await res.text();
    if (/assignee/i.test(text)) {
      // The owner cannot be assigned here. The description still @mentions them.
      res = await jiraWrite(route`/rest/api/3/issue`, { body: { fields } });
    } else throw new ApiError(400, text);
  }
  if (res.status !== 201) throw new ApiError(res.status, await res.text());
  return (await res.json()).key;
}

export const remediate = makeRemediation({
  getConfig: async () => {
    const c = await getConfig();
    return c ? { ...c, baseUrl: await baseUrl() } : null;
  },
  loadFinding, claim, findByLabel, createIssue, saveKey, logEvent,
});
