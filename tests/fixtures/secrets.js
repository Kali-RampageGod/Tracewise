// Fixture corpus for Secret Sentinel. Every fake secret is built from pieces so that no complete
// key sits in the file (GitHub push protection and scanners would flag it).
const r = (c, n) => c.repeat(n);
const rnd = 'k9Xq2Lm7Zp4Wv8Nb3Tr6Yc1Hd5Jf0Sg'; // 32 mixed characters, looks random

export const POSITIVES = [
    { name: 'AWS Access Key', secret: 'AKIA' + 'IOSFODNN7' + 'ABCDEFG'.slice(0, 7), text: (s) => `deploy failed, key is ${s} please check` },
    { name: 'AWS Access Key', secret: 'ASIA' + 'IOSFODNN7' + 'ABCDEFG'.slice(0, 7), text: (s) => `temp creds: ${s}` },
    { name: 'GitHub Token', secret: 'gh' + 'p_' + r('a1B2', 9), text: (s) => `git remote set-url origin https://${s}@github.com/org/repo` },
    { name: 'GitHub Token', secret: 'github' + '_pat_' + r('A1b2C3', 5) + 'xy', text: (s) => `PAT: ${s}` },
    { name: 'Private Key', secret: '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----', text: (s) => `${s}\nb3BlbnNzaC1rZXk...` },
    { name: 'Private Key', secret: '-----BEGIN ' + 'RSA PRIVATE KEY-----', text: (s) => `id_rsa:\n${s}` },
    { name: 'Google API Key', secret: 'AI' + 'za' + r('a', 35), text: (s) => `maps key ${s}` },
    { name: 'Slack Token', secret: 'xox' + 'b-' + r('1', 12), text: (s) => `bot token ${s} in the channel` },
    { name: 'Stripe Live Key', secret: 'sk_' + 'live_' + r('a', 24), text: (s) => `charge using ${s}` },
    { name: 'Stripe Live Key', secret: 'rk_' + 'live_' + r('b', 24), text: (s) => `restricted ${s}` },
    { name: 'Connection String', secret: 'Zx9' + 'Qp7Lm2Vb', text: (s) => `DATABASE_URL=postgres://app:${s}@db.internal:5432/prod` },
    { name: 'Connection String', secret: 'Tr0ub4dor' + '3xyz', text: (s) => `mongodb+srv://admin:${s}@cluster0.example.mongodb.net/test` },
    { name: 'Connection String', secret: 'h7Kd92' + 'LmPq', text: (s) => `redis://default:${s}@cache.internal:6379` },
    { name: 'JSON Web Token', secret: 'eyJ' + 'hbGciOiJIUzI1NiJ9.' + 'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0.' + 'abcDEF123_-xyzABC', text: (s) => `Authorization: Bearer ${s}` },
    { name: 'Generic API Key', secret: 'abcd1234' + 'efgh5678ijkl', text: (s) => `api_key = ${s}` },
    { name: 'Generic API Key', secret: rnd, text: (s) => `{"apiKey": "${s}"}` },
    { name: 'Credential Assignment', secret: 'Tr0ub4dor&' + '3xYz', text: (s) => `Login with password: ${s} then restart` },
    { name: 'Credential Assignment', secret: rnd + '+/=', text: (s) => `client_secret = "${s}"` },
    { name: 'Credential Assignment', secret: 'S3cr3t!' + 'Passw0rd', text: (s) => `The admin password=${s}` },
    // inside Confluence code macro text, among normal prose
    { name: 'Generic API Key', secret: 'q8Zr3' + 'Tn6Vx1Mc9Wb4Hs', text: (s) => `Setup steps. 1. Install. 2. Export TOKEN=${s} 3. Run the app.` },
];

export const NEGATIVES = [
    'Please update the login page',
    'Reset your password using the link we sent you',
    'password: required',
    'passwordless login with magic links',
    'We use a token bucket algorithm for rate limiting',
    'secret sauce of the product is the matching engine',
    'api key rotation policy is every 90 days',
    'token: 550e8400-e29b-41d4-a716-446655440000',
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8 fixed it',
    'password: changeme',
    'password: ********',
    'token: <your-token-here>',
    'api_key=${API_KEY}',
    'secret: process.env.SECRET_KEY',
    'token: refreshTokenHandler',
    'auth = config.auth.provider',
    'DATABASE_URL=postgres://user:password@localhost:5432/db',
    'postgres://localhost:5432/mydb',
    'https://user@example.com/path',
    'AKIA is the prefix AWS uses for access keys',
    'a ghp_ token starts with ghp_',
    'credentials: see the vault',
    'The access key must be rotated',
    'token=abc',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
    'Version 2.4.1 ships on 2026-12-10 with build 20261210.1',
];
