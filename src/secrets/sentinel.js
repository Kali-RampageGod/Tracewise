import { createHash } from 'crypto';
import { DETECTORS } from './detectors.js';

// Masks a secret: keeps first 4 and last 4 characters only.
export function redact(secret) {
    if (secret.length < 12) return '****';
    return secret.slice(0, 4) + '****' + secret.slice(-4);
}

// Pure function: text in, list of findings out. No database, no Jira.
// The real secret is NEVER returned, only fingerprint + preview.
export function findSecrets(text) {
    const found = [];
    const seen = new Set();
    for (const d of DETECTORS) {
        for (const m of String(text || '').matchAll(d.pattern)) {
            const secret = m[0];
            const fingerprint = createHash('sha256').update(secret).digest('hex');
            if (seen.has(fingerprint)) continue; // same secret twice = one finding
            seen.add(fingerprint);
            found.push({
                name: d.name,
                severity: d.severity,
                fingerprint,
                preview: redact(secret),
            });
        }
    }
    return found;
}