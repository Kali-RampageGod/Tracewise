
// Turns a raw Forge product event into a small, stable "job" description.
// Jobs carry only ids and a key, never page or issue bodies: the consumer
// always reads the current state of the source itself.
const JIRA_TYPES = ['avi:jira:created:issue', 'avi:jira:updated:issue'];
const CONFLUENCE_TYPES = ['avi:confluence:created:page', 'avi:confluence:updated:page'];

export function normalizeEvent(event) {
  if (!event || !event.eventType) return null;
  const type = event.eventType;

  if (JIRA_TYPES.includes(type)) {
    if (event.selfGenerated) return null; // our own change: ignore
    const issue = event.issue || {};
    if (!issue.id) return null;
    const ts = event.timestamp != null ? String(event.timestamp) : '';
    let eventKey;
    if (type === 'avi:jira:created:issue') {
      eventKey = `jira:${issue.id}:created`;
    } else if (event.changelog && event.changelog.id) {
      eventKey = `jira:${issue.id}:cl:${event.changelog.id}`;
    } else {
      eventKey = `jira:${issue.id}:ts:${ts}`;
    }
    const fields = issue.fields || {};
    return {
      sourceType: 'jira_issue',
      sourceId: String(issue.id),
      sourceRef: issue.key || null,
      projectKey: fields.project && fields.project.key ? fields.project.key : null,
      eventType: type,
      eventKey,
      occurredAt: Number(ts) || null,
    };
  }

  if (CONFLUENCE_TYPES.includes(type)) {
    if (event.selfGenerated) return null;
    const c = event.content || {};
    const version = c.version ? c.version.number : null;
    if (!c.id || c.type !== 'page' || version == null) return null;
    if (c.status && c.status !== 'current') return null; // ignore drafts
    return {
      sourceType: 'confluence_page',
      sourceId: String(c.id),
      sourceRef: c.title || null,
      projectKey: null, // mapped from the space to a Jira space later
      spaceKey: c.space && c.space.key ? c.space.key : null,
      eventType: type,
      // Same key the reconciliation scan builds, so both paths dedupe each other.
      eventKey: `confluence:${c.id}:v${version}`,
      occurredAt: Date.parse((c.version && c.version.when) || event.eventCreatedDate) || null,
    };
  }

  return null;
}
// ---- Reconciliation scan helpers (source = API listing, not an event) ----

// A Confluence page row from GET /wiki/api/v2/pages. The key is page id + version
// number, which is stable and comes from the API itself.
export function jobFromConfluencePage(page) {
  if (!page || !page.id || !page.version || page.version.number == null) return null;
  return {
    sourceType: 'confluence_page',
    sourceId: String(page.id),
    sourceRef: page.title || null,
    projectKey: null, // mapped from space to Jira space later
    eventType: 'reconcile:confluence:page',
    eventKey: `confluence:${page.id}:v${page.version.number}`,
    occurredAt: page.version.createdAt ? Date.parse(page.version.createdAt) || null : null,
  };
}

// A Jira issue row from the search API (fields: updated, project).
export function jobFromJiraIssue(issue) {
  if (!issue || !issue.id) return null;
  const f = issue.fields || {};
  const updatedMs = f.updated ? Date.parse(f.updated) : NaN;
  if (Number.isNaN(updatedMs)) return null;
  return {
    sourceType: 'jira_issue',
    sourceId: String(issue.id),
    sourceRef: issue.key || null,
    projectKey: f.project && f.project.key ? f.project.key : null,
    eventType: 'reconcile:jira:issue',
    eventKey: `jira:${issue.id}:upd:${updatedMs}`,
    occurredAt: updatedMs,
  };
}

// Extracts the paging cursor from a v2 "next" link, or null.
export function nextCursor(links) {
  if (!links || !links.next) return null;
  try {
    return new URL(links.next, 'https://example.invalid').searchParams.get('cursor');
  } catch (e) {
    return null;
  }
}

export const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};