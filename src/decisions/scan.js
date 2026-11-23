import sql from '@forge/sql';
import { route } from '@forge/api';
import { createHash } from 'crypto';
import { jiraGet, json } from '../api';
import { newId } from '../id';
import { findMatches } from './match';
import { scanWorkItem } from '../secrets/source';

// Jira descriptions come as ADF (a tree of nodes). This collects all the text.
export function adfToText(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node.type === 'text') return node.text || '';
    return (node.content || []).map(adfToText).join(' ');
}

// Reads one Jira issue, matches it against active decisions, saves findings.
export async function scanIssue(projectKey, issueKey) {
    // 1. Read the issue from Jira.
    const res = await jiraGet(
        route`/rest/api/3/issue/${issueKey}?fields=summary,description,comment,project,fixVersions,reporter,assignee`,
        { asApp: true }
    );
    const issue = await json(res);
    issueKey = issue.key || issueKey; // the job may carry the issue id instead of its key
    projectKey = projectKey || (issue.fields.project && issue.fields.project.key);
    const text = (issue.fields.summary || '') + ' ' + adfToText(issue.fields.description);
    const commentText = ((issue.fields.comment && issue.fields.comment.comments) || [])
        .map((c) => adfToText(c.body))
        .join(' ');

    // 2. Read the active decisions of this project.
    const d = await sql
        .prepare(
            `SELECT id, page_id, page_title, decision_text, status
         FROM decisions WHERE project_key IN (?, '_site') AND status = 'active'`
        )
        .bindParams(projectKey)
        .execute();

    // 3. Keyword match, then save one finding per matched decision.
    const matches = findMatches(text, d.rows);
    for (const m of matches) {
        const dec = m.decision;
        // Same issue + same decision = same fingerprint, so clicking twice makes no duplicate.
        const fingerprint = createHash('sha256').update(dec.id + ':' + issue.id).digest('hex');
        const detail = JSON.stringify({
            issueKey,
            decisionId: dec.id,
            pageId: dec.page_id,
            pageTitle: dec.page_title,
            shared: m.shared,
            ownerAccountId: ((issue.fields.assignee || issue.fields.reporter) || {}).accountId || null,
        });
        await sql
            .prepare(
                `INSERT INTO findings
           (id, project_key, release_id, type, severity, source_type, source_id,
            fingerprint, title, detail, evidence_confidence)
         VALUES (?, ?, NULL, 'decision_conflict', 3, 'jira_issue', ?, ?, ?, ?, 60)
         ON DUPLICATE KEY UPDATE last_seen_at = CURRENT_TIMESTAMP, detail = VALUES(detail)`
            )
            .bindParams(
                newId(), projectKey, String(issue.id), fingerprint,
                `${issueKey} may contradict: ${dec.page_title}`.slice(0, 255), detail
            )
            .execute();
    }

    // 4. Secret Sentinel: save findings for secrets in this work item (the real secret is never saved).
    //    A finding stays open after the secret is removed: it is still in the work item history,
    //    so it closes only when someone confirms the rotation.
    const secretScan = await scanWorkItem({
        issueId: issue.id,
        issueKey,
        projectKey,
        reporterId: issue.fields.reporter && issue.fields.reporter.accountId,
        text: text + ' ' + commentText,
    });

    return {
        issueKey,
        projectKey,
        fixVersionIds: ((issue.fields.fixVersions) || []).map((v) => String(v.id)),
        decisionsChecked: d.rows.length,
        secretsFound: secretScan.found,
        matches: matches.map((m) => ({ decision: m.decision.page_title, shared: m.shared })),
    };
}