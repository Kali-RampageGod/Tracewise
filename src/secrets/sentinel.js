import { createHash } from 'crypto';
import { DETECTORS } from './detectors.js';

// Masks a secret: keeps first 4 and last 4 characters only.
export function redact(secret) {
    if (secret.length < 12) return '****';
    return secret.slice(0, 4) + '****' + secret.slice(-4);
}

// Pure function: text in, list of findings out. No database, no Jira.
// The real secret is NEVER returned, only fingerprint + preview.
// Fingerprint and preview are made from the secret value itself (for "password = x" that is x),
// so the same secret found by two detectors or in two places gives one finding.
export function findSecrets(text) {
    const found = [];
    const seen = new Set();
    const matched = []; // texts already claimed by an earlier, more specific detector
    for (const d of DETECTORS) {
        for (const m of String(text || '').matchAll(d.pattern)) {
            const value = d.valueGroup ? m[d.valueGroup] : m[0];
            if (!value) continue;
            if (d.validate && !d.validate(value)) continue;
            if (matched.some((t) => t.includes(value))) continue;
            const fingerprint = createHash('sha256').update(value).digest('hex');
            if (seen.has(fingerprint)) continue;
            seen.add(fingerprint);
            matched.push(m[0]);
            found.push({
                name: d.name,
                severity: d.severity,
                fingerprint,
                preview: redact(value),
            });
        }
    }
    return found;
}
