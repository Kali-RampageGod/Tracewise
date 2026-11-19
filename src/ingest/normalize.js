// Turns a raw Forge product event into a small, stable "job" description.
// Jobs carry only ids and a key, never page or issue bodies: the consumer
// always reads the current state of the source itself.
const JIRA_TYPES = ['avi:jira:created:issue', 'avi:jira:updated:issue'];

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

  return null; // Confluence is added once its payload shape is confirmed
}