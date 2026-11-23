// Forge glue: reads versions, work items and release notes links from Jira / Confluence.
import { route } from '@forge/api';
import { confluenceGet, jiraGet, jiraWrite, json, ApiError } from '../api';

export const MAX_ISSUES = 500;
const PAGE = 100;

export async function listVersions(projectKey) {
  const data = await json(await jiraGet(route`/rest/api/3/project/${projectKey}/versions`, { asApp: true }));
  return (Array.isArray(data) ? data : data.values || []).map((v) => ({
    id: String(v.id), name: v.name, released: !!v.released, archived: !!v.archived,
    releaseDate: v.releaseDate || null,
  }));
}

// All work items of a version (up to MAX_ISSUES). `truncated` says more exist.
export async function readIssues(versionId) {
  const jql = `fixVersion = ${Number(versionId)} ORDER BY key ASC`;
const fields = 'summary,status,priority,issuetype,issuelinks,assignee,reporter,labels';  const issues = [];
  let token = null;
  for (;;) {
    const path = token
      ? route`/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=${PAGE}&nextPageToken=${token}`
      : route`/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=${PAGE}`;
    const data = await json(await jiraGet(path, { asApp: true }));
    issues.push(...(data.issues || []));
    token = data.nextPageToken || null;
    if (!token) return { issues, truncated: false };
    if (issues.length >= MAX_ISSUES) return { issues: issues.slice(0, MAX_ISSUES), truncated: true };
  }
}

export async function readRelatedWork(versionId) {
  return json(await jiraGet(route`/rest/api/3/version/${versionId}/relatedwork`, { asApp: true }));
}

// 'ok' | 'missing' | 'unverified'. 403/401 means the app cannot see it: not proof it is missing.
export async function checkPage(pageId) {
  const res = await confluenceGet(route`/wiki/api/v2/pages/${pageId}`, { asApp: true });
  if (res.status === 404) return 'missing';
  if (res.status === 401 || res.status === 403) return 'unverified';
  const p = await json(res);
  return p.status === 'current' ? 'ok' : 'missing';
}

// Does the signed-in user hold this Jira permission in the project?
export async function hasPermission(projectKey, permission) {
  const data = await json(
    await jiraGet(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=${permission}`, { asApp: false })
  );
  return !!(data.permissions && data.permissions[permission] && data.permissions[permission].havePermission);
}

// Work items of a version that match a project-defined JQL rule (first 50).
// A 400 means the rule's JQL is invalid; the runner reports that on the rule's own row.
export async function readRuleIssues(versionId, jql) {
  const q = `fixVersion = ${Number(versionId)} AND (${jql}) ORDER BY key ASC`;
  const fields = 'summary,status,priority,issuetype,assignee,reporter';
  const data = await json(await jiraGet(route`/rest/api/3/search/jql?jql=${q}&fields=${fields}&maxResults=50`, { asApp: true }));
  return { issues: data.issues || [], truncated: !!data.nextPageToken };
}

// Checks every rule's JQL with Jira's own parser. Returns a list of problems (empty = all valid).
export async function validateRules(rules) {
  const problems = [];
  if (!rules.length) return problems;
  const res = await jiraWrite(route`/rest/api/3/jql/parse?validation=strict`, { body: { queries: rules.map((r) => r.jql) } });
  if (res.status !== 200) throw new ApiError(res.status, await res.text());
  const data = await res.json();
  (data.queries || []).forEach((q, i) => {
    if (q.errors && q.errors.length) problems.push(`Rule "${rules[i].name}": ${q.errors[0]}`);
  });
  return problems;
}
