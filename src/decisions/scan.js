import sql from '@forge/sql';
import { route } from '@forge/api';
import { createHash } from 'crypto';
import { jiraGet, json } from '../api';
import { newId } from '../id';
import { findMatches } from './match';

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
    const res = await jiraGet(route`/rest/api/3/issue/${issueKey}?fields=summary,description`, { asApp: true });
    const issue = await json(res);
    const text = (issue.fields.summary || '') + ' ' + adfToText(issue.fields.description);

    // 2. Read the active decisions of this project.
    const d = await sql
        .prepare(
            `SELECT id, page_id, page_title, decision_text, status
         FROM decisions WHERE project_key = ? AND status = 'active'`
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
        });
        await sql
            .prepare(
                `INSERT INTO findings
           (id, project_key, release_id, type, severity, source_type, source_id,
            fingerprint, title, detail, evidence_confidence)
         VALUES (?, ?, NULL, 'decision_conflict', 3, 'jira_issue', ?, ?, ?, ?, 60)
         ON DUPLICATE KEY UPDATE last_seen_at = CURRENT_TIMESTAMP`
            )
            .bindParams(
                newId(), projectKey, String(issue.id), fingerprint,
                `${issueKey} may contradict: ${dec.page_title}`.slice(0, 255), detail
            )
            .execute();
    }

    return {
        issueKey,
        textRead: text.slice(0, 120),
        decisionsChecked: d.rows.length,
        matches: matches.map((m) => ({ decision: m.decision.page_title, shared: m.shared })),
    };
}