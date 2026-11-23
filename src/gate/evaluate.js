// Release Gate rules. Pure: takes data read from Jira, returns checks and findings.
//
// version:  { id, name, released, releaseDate }          (releaseDate is 'YYYY-MM-DD' or null)
// issues:   Jira issues with fields summary, status, priority, issuetype, issuelinks
// notes:    { links: [{ title, url, pageId|null }], pageState: { [pageId]: 'ok'|'missing'|'unverified' } }
// truncated: true when more work items exist than were read
const PRIORITY_SEVERITY = {
  blocker: 4, critical: 4, highest: 4,
  major: 3, high: 3,
  medium: 2,
  minor: 1, low: 1, lowest: 1, trivial: 1,
};

// Unknown or missing priority counts as medium.
export const severityFromPriority = (name) => PRIORITY_SEVERITY[String(name || '').toLowerCase()] ?? 2;

// Done means the Done status category, unless the policy lists the statuses that count.
export const isDone = (issue, required = []) => {
  const st = issue && issue.fields && issue.fields.status;
  if (!st) return false;
  if (required.length) return required.some((r) => r.toLowerCase() === String(st.name || '').toLowerCase());
  return !!(st.statusCategory && st.statusCategory.key === 'done');
};

// Release notes are related-work links with the category "Release notes".
export function findNotesLinks(relatedWork) {
  const list = Array.isArray(relatedWork) ? relatedWork : (relatedWork && relatedWork.values) || [];
  return list
    .filter((w) => w && /release\s*notes/i.test(String(w.category || '')))
    .map((w) => ({ title: w.title || w.url || 'Release notes', url: w.url || '', pageId: confluencePageId(w.url) }));
}

export function confluencePageId(url) {
  const m = /\/pages\/(\d+)/.exec(String(url || '')) || /[?&]pageId=(\d+)/.exec(String(url || ''));
  return m ? m[1] : null;
}

const daysBetween = (isoDate, now) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  const due = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - due) / 86400000);
};

const clip = (s, n = 200) => String(s || '').slice(0, n);
// Whoever is working on the item, else whoever raised it.
const ownerId = (issue) => {
  const f = (issue && issue.fields) || {};
  return (f.assignee && f.assignee.accountId) || (f.reporter && f.reporter.accountId) || null;
};

export function evaluateGate({ version, issues, truncated = false, notes, policy, now = new Date(), rules = [], criticalOpen = null }) {
  const required = policy.requiredStatuses || [];
  // Remediation issues made by Tracewise (label "tracewise") are the to-do for a finding that
  // already costs points. Counting them again would penalize one problem twice.
  issues = issues.filter((i) => !(((i.fields && i.fields.labels) || []).includes('tracewise')));
  const total = issues.length;
  const unfinished = issues.filter((i) => !isDone(i, required));
  const stats = { total, done: total - unfinished.length, unfinished: unfinished.length, truncated };

  if (version.released) {
    return {
      released: true, stats, findings: [],
      checks: [{ key: 'released', label: 'Version is already released', status: 'info', detail: 'No gate checks apply to a released version.' }],
    };
  }

  const findings = [];
  const checks = [];
  const base = { type: 'gate', confidence: 100, sourceType: 'jira_issue' };
  const vInfo = { versionId: version.id, versionName: version.name };

  const doneLabel = required.length ? `All work items are in a required state (${required.join(', ')})` : 'All work items are done';

  // 1. Unfinished work items.
  for (const i of unfinished) {
    const f = i.fields || {};
    findings.push({
      ...base, key: `unfinished:${i.key}`, sourceId: String(i.id),
      severity: severityFromPriority(f.priority && f.priority.name),
      title: clip(required.length
        ? `${i.key} is "${(f.status && f.status.name) || 'unknown'}", not in a required state: ${f.summary || ''}`
        : `${i.key} is not done: ${f.summary || ''}`, 255),
      detail: { kind: 'unfinished', issueKey: i.key, status: f.status && f.status.name,
        priority: f.priority && f.priority.name, issueType: f.issuetype && f.issuetype.name,
        ownerAccountId: ownerId(i), ...vInfo },
    });
  }
  checks.push(unfinished.length === 0 && total > 0
    ? { key: 'unfinished', label: doneLabel, status: 'pass', detail: `${total} of ${total} ready` }
    : total === 0
      ? { key: 'unfinished', label: 'Work items are done', status: 'skipped', detail: 'No work items in this version' }
      : { key: 'unfinished', label: doneLabel, status: 'fail', detail: `${unfinished.length} of ${total} not ready` });

  // 2. Blocked by another unfinished item.
  if (policy.flagBlockedLinks) {
    let n = 0;
    for (const i of unfinished) {
      for (const link of (i.fields && i.fields.issuelinks) || []) {
        const other = link.inwardIssue;
        if (!other || !/blocked by/i.test((link.type && link.type.inward) || '')) continue;
        if (isDone(other)) continue;
        n++;
        findings.push({
          ...base, key: `blocked:${i.key}:${other.key}`, sourceId: String(i.id), severity: 3,
          title: clip(`${i.key} is blocked by ${other.key}`, 255),
          detail: { kind: 'blocked', issueKey: i.key, blockedBy: other.key,
            blockedByStatus: other.fields && other.fields.status && other.fields.status.name,
            ownerAccountId: ownerId(i), ...vInfo },
        });
      }
    }
    checks.push(n === 0
      ? { key: 'blocked', label: 'No open blocking links', status: 'pass', detail: 'No unfinished item is blocked by another unfinished item' }
      : { key: 'blocked', label: 'No open blocking links', status: 'fail', detail: `${n} blocking link${n > 1 ? 's' : ''} still open` });
  } else {
    checks.push({ key: 'blocked', label: 'Blocking links', status: 'skipped', detail: 'Turned off in policy' });
  }

  // 3. Release notes.
  if (policy.requireReleaseNotes) {
    const vBase = { ...base, sourceType: 'jira_version', sourceId: String(version.id) };
    if (notes.links.length === 0) {
      findings.push({
        ...vBase, key: 'notes:missing', severity: 3,
        title: 'No release notes linked to this version',
        detail: { kind: 'notes_missing', ...vInfo },
      });
      checks.push({ key: 'notes', label: 'Release notes are linked', status: 'fail', detail: 'Add a "Release notes" link under the version\'s related work' });
    } else {
      let status = 'pass';
      let detail = notes.links.map((l) => l.title).join(', ');
      for (const l of notes.links) {
        const st = l.pageId ? (notes.pageState || {})[l.pageId] : 'ok';
        if (st === 'missing') {
          status = 'fail';
          detail = `Linked page "${l.title}" was not found or is not published`;
          findings.push({
            ...vBase, key: `notes:page-missing:${l.pageId}`, severity: 3, confidence: 90,
            title: clip(`Release notes page "${l.title}" was not found`, 255),
            detail: { kind: 'notes_page_missing', pageId: l.pageId, url: l.url, ...vInfo },
          });
        } else if (st === 'unverified' && status === 'pass') {
          status = 'warn';
          detail = `Linked, but the app cannot open "${l.title}" to confirm it exists`;
        }
      }
      checks.push({ key: 'notes', label: 'Release notes are linked', status, detail });
    }
  } else {
    checks.push({ key: 'notes', label: 'Release notes', status: 'skipped', detail: 'Turned off in policy' });
  }

  // 4. Overdue.
  if (policy.flagOverdue) {
    const late = version.releaseDate ? daysBetween(version.releaseDate, now) : 0;
    if (version.releaseDate && late > 0) {
      findings.push({
        ...base, key: 'overdue', sourceType: 'jira_version', sourceId: String(version.id),
        severity: late > 14 ? 3 : 2,
        title: `Release date passed ${late} day${late > 1 ? 's' : ''} ago`,
        detail: { kind: 'overdue', releaseDate: version.releaseDate, daysLate: late, ...vInfo },
      });
      checks.push({ key: 'overdue', label: 'Release date not passed', status: 'fail', detail: `${late} day${late > 1 ? 's' : ''} overdue (${version.releaseDate})` });
    } else {
      checks.push({ key: 'overdue', label: 'Release date not passed', status: version.releaseDate ? 'pass' : 'skipped', detail: version.releaseDate ? `Due ${version.releaseDate}` : 'No release date set' });
    }
  } else {
    checks.push({ key: 'overdue', label: 'Release date', status: 'skipped', detail: 'Turned off in policy' });
  }

  // 5. Empty version.
  if (policy.flagEmptyRelease) {
    if (total === 0) {
      findings.push({
        ...base, key: 'empty', sourceType: 'jira_version', sourceId: String(version.id), severity: 2,
        title: 'This version has no work items',
        detail: { kind: 'empty', ...vInfo },
      });
      checks.push({ key: 'empty', label: 'Version has work items', status: 'fail', detail: 'Nothing is assigned to this version' });
    } else {
      checks.push({ key: 'empty', label: 'Version has work items', status: 'pass', detail: `${total} work item${total > 1 ? 's' : ''}` });
    }
  }

  // 6. Custom rules: a work item that matches the rule's JQL is a problem.
  for (const r of rules) {
    const rule = r.rule;
    if (r.error) {
      checks.push({ key: `rule:${rule.id}`, label: rule.name, status: 'warn', detail: `This rule could not run: ${r.error}` });
      continue;
    }
    for (const i of r.issues) {
      const f = i.fields || {};
      findings.push({
        ...base, key: `rule:${rule.id}:${i.key}`, sourceId: String(i.id), severity: rule.severity,
        title: clip(`${i.key}: ${rule.name}`, 255),
        detail: { kind: 'rule', ruleId: rule.id, ruleName: rule.name, issueKey: i.key, status: f.status && f.status.name,
          priority: f.priority && f.priority.name, ownerAccountId: ownerId(i), ...vInfo },
      });
    }
    const n = r.issues.length;
    checks.push(n === 0
      ? { key: `rule:${rule.id}`, label: rule.name, status: 'pass', detail: 'No work item matches this rule' }
      : { key: `rule:${rule.id}`, label: rule.name, status: 'fail', detail: `${n}${r.truncated ? '+' : ''} work item${n > 1 ? 's' : ''} match` });
  }

  // 7. Open critical findings elsewhere (a leaked secret, say). They already count in the score;
  //    this row makes them visible in the gate. It adds no finding of its own.
  if (policy.requireNoCriticalFindings && criticalOpen != null) {
    checks.push(criticalOpen === 0
      ? { key: 'critical', label: 'No open critical findings', status: 'pass', detail: 'Nothing critical is open' }
      : { key: 'critical', label: 'No open critical findings', status: 'fail', detail: `${criticalOpen} open critical finding${criticalOpen > 1 ? 's' : ''}. See the Findings tab.` });
  }

  if (truncated) {
    checks.push({ key: 'truncated', label: 'All work items were read', status: 'warn', detail: `Only the first ${total} work items were checked` });
  }
  return { released: false, stats, findings, checks };
}
