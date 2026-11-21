import sql from '@forge/sql';
import { route } from '@forge/api';
import { createHash } from 'crypto';
import { jiraGet, json } from '../api';
import { newId } from '../id';
import { findMatches } from './match';
import { findSecrets } from '../secrets/sentinel';

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
    const res = await jiraGet(route`/rest/api/3/issue/${issueKey}?fields=summary,description,comment`, { asApp: true });
    const issue = await json(res);
    const text = (issue.fields.summary || '') + ' ' + adfToText(issue.fields.description);
    const commentText = ((issue.fields.comment && issue.fields.comment.comments) || [])
        .map((c) => adfToText(c.body))
        .join(' ');

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

    // 4. Secret Sentinel: save one finding per secret. Real secret is never saved.
    const secrets = findSecrets(text + ' ' + commentText);
    for (const s of secrets) {
        await sql
            .prepare(
                `INSERT INTO findings
           (id, project_key, release_id, type, severity, source_type, source_id,
            fingerprint, title, detail, redacted_preview, evidence_confidence)
         VALUES (?, ?, NULL, 'secret', ?, 'jira_issue', ?, ?, ?, ?, ?, ?)
                  ON DUPLICATE KEY UPDATE resolved_at = IF(status = 'resolved', NULL, resolved_at), status = IF(status = 'resolved', 'open', status), last_seen_at = CURRENT_TIMESTAMP`
            )
            .bindParams(
                newId(), projectKey, s.severity, String(issue.id), s.fingerprint,
                `${issueKey}: possible ${s.name}`.slice(0, 255),
                JSON.stringify({ issueKey, detector: s.name }),
                s.preview,
                s.severity >= 4 ? 90 : 60
            )
            .execute();
    }

    // 5. Secret removed from the issue? Close its old finding.
    const current = new Set(secrets.map((s) => s.fingerprint));
    const open = await sql
        .prepare(
            `SELECT id, fingerprint FROM findings
              WHERE project_key = ? AND type = 'secret' AND source_id = ? AND status = 'open'`
        )
        .bindParams(projectKey, String(issue.id))
        .execute();
    for (const row of open.rows) {
        if (current.has(row.fingerprint)) continue;
        await sql
            .prepare(`UPDATE findings SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .bindParams(row.id)
            .execute();
    }

    return {
        issueKey,
        decisionsChecked: d.rows.length,
        secretsFound: secrets.map((s) => ({ name: s.name, preview: s.preview })),
        matches: matches.map((m) => ({ decision: m.decision.page_title, shared: m.shared })),
    };
}