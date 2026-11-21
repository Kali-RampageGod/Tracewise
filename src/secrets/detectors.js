// Secret shapes. Pure data: no database, no Jira.
// A detector = a name, a regex, a severity, and optionally:
//   valueGroup: which capture group holds the secret itself (default: the whole match)
//   validate:   extra check on that value, to drop placeholders and look-alikes
import { isPlaceholder, looksLikeSecretValue } from './entropy.js';

const KEY_WORDS = String.raw`(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth)\w*`;

export const DETECTORS = [
    { name: 'AWS Access Key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, severity: 4 },
    { name: 'GitHub Token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/g, severity: 4 },
    { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, severity: 4 },
    { name: 'Google API Key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g, severity: 4 },
    { name: 'Slack Token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g, severity: 4 },
    { name: 'Stripe Live Key', pattern: /\b[sr]k_live_[0-9A-Za-z]{24,}/g, severity: 4 },
    {
        name: 'Connection String',
        pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver):\/\/[^\s:@\/'"]+:([^\s@\/'"]+)@[^\s'"<>]+/gi,
        severity: 4, valueGroup: 1, validate: (v) => !isPlaceholder(v),
    },
    { name: 'JSON Web Token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, severity: 3 },
    {
        name: 'Generic API Key',
        pattern: new RegExp(String.raw`(?<![A-Za-z0-9])(?:api[_-]?key|secret|token)['"]?\s*[:=]\s*['"]?([A-Za-z0-9_-]{16,})['"]?`, 'gi'),
        severity: 3, valueGroup: 1, validate: looksLikeSecretValue,
    },
    {
        // High-entropy value next to a context word: password, secret, token, key, credentials, auth.
        name: 'Credential Assignment',
        pattern: new RegExp(String.raw`(?<![A-Za-z0-9])${KEY_WORDS}['"]?\s*[:=]\s*['"]?([^\s'"<>,;]{8,})['"]?`, 'gi'),
        severity: 3, valueGroup: 1, validate: looksLikeSecretValue,
    },
];
