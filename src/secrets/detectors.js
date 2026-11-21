// Secret shapes. Pure data: no database, no Jira.
// Each detector = a name + a regex (a pattern describing how the secret looks).
export const DETECTORS = [
    { name: 'AWS Access Key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, severity: 4 },
    { name: 'GitHub Token', pattern: /\bghp_[A-Za-z0-9]{36}\b/g, severity: 4 },
    { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g, severity: 4 },
    { name: 'Generic API Key', pattern: /\b(?:api[_-]?key|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}['"]?/gi, severity: 3 },
    { name: 'Google API Key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g, severity: 4 },
    { name: 'Slack Token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g, severity: 4 },
    { name: 'Stripe Live Key', pattern: /\bsk_live_[0-9A-Za-z]{24,}/g, severity: 4 },
];