import sql from '@forge/sql';
import { newId } from '../id';
import { computeScore, DEFAULT_CONFIG } from './engine';

// Reads open findings for a release, scores them, saves the result.
// Findings with release_id NULL count for every release of the project.
export async function assessRelease(projectKey, releaseId, overrides = {}) {
    // 1. Get the open findings.
    const found = await sql
        .prepare(
            `SELECT id, title, type, severity, status, evidence_confidence
         FROM findings
        WHERE project_key = ? AND status = 'open'
          AND (release_id = ? OR release_id IS NULL)`
        )
        .bindParams(projectKey, releaseId)
        .execute();
    const findings = found.rows;

    // 2. Score them with the pure calculator from part 1.
    const result = computeScore(findings, { ...DEFAULT_CONFIG, ...overrides });
    const breakdown = JSON.stringify(result.breakdown);

    // Overall confidence = average of the findings' confidence (100 if none).
    const confidence = findings.length
        ? Math.round(findings.reduce((s, f) => s + Number(f.evidence_confidence), 0) / findings.length)
        : 100;

    // 3. Skip saving if nothing changed since the last saved score,
    //    so the hourly scan doesn't fill the history with copies.
    const last = await sql
        .prepare(
            `SELECT score, band, open_findings, breakdown FROM release_assessments
        WHERE project_key = ? AND release_id = ?
        ORDER BY computed_at DESC LIMIT 1`
        )
        .bindParams(projectKey, releaseId)
        .execute();
    const p = last.rows[0];
    if (
        p && Number(p.score) === result.score && p.band === result.band &&
        Number(p.open_findings) === findings.length && p.breakdown === breakdown
    ) {
        return { ...result, saved: false };
    }

    // 4. Save a new row in release_assessments.
    await sql
        .prepare(
            `INSERT INTO release_assessments
         (id, project_key, release_id, score, band, blocked_reason,
          evidence_confidence, open_findings, breakdown)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bindParams(
            newId(), projectKey, releaseId, result.score, result.band,
            result.blockedReason, confidence, findings.length, breakdown
        )
        .execute();

    return { ...result, saved: true };
}

// Score history for one release, newest first.
export async function getHistory(projectKey, releaseId, limit = 20) {
    // Forge SQL rejects a bound value after LIMIT, so the number is written
    // into the text. It is forced to a whole number from 1 to 100 first, so it is safe.
    const n = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20));
    const r = await sql
        .prepare(
            `SELECT score, band, blocked_reason, open_findings, computed_at
         FROM release_assessments
        WHERE project_key = ? AND release_id = ?
        ORDER BY computed_at DESC LIMIT ${n}`
        )
        .bindParams(projectKey, releaseId)
        .execute();
    return r.rows;
}