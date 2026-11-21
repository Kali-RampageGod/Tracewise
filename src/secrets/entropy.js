// Helpers that tell a real secret value from a placeholder or an ordinary word. Pure.

// Shannon entropy in bits per character. Random keys score high, words and repeats score low.
export function entropy(s) {
    if (!s) return 0;
    const counts = new Map();
    for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
    let h = 0;
    for (const n of counts.values()) {
        const p = n / s.length;
        h -= p * Math.log2(p);
    }
    return h;
}

const PLACEHOLDER_WORDS = new Set([
    'password', 'passwd', 'pass', 'secret', 'token', 'apikey', 'api_key', 'changeme', 'change_me',
    'required', 'optional', 'none', 'null', 'undefined', 'true', 'false', 'string', 'redacted',
]);

export function isPlaceholder(v) {
    const s = String(v || '').trim();
    const low = s.toLowerCase();
    if (!s || PLACEHOLDER_WORDS.has(low)) return true;
    if (/^[x*•.#_\-]{3,}$/i.test(s)) return true;                 // xxxx, ****, ----
    if (/^<.*>$/.test(s) || /^\$\{.*\}$/.test(s) || /^\{\{.*\}\}$/.test(s) || /^%.*%$/.test(s)) return true;
    if (/^(your|my|insert|replace|enter|put)[-_ ]/i.test(s)) return true;
    if (/(example|placeholder|changeme|redacted|dummy|sample)/i.test(s)) return true;
    return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// process.env.KEY, config.apiKey, os.environ: a reference to a secret, not the secret.
const DOTTED_NAME = /^[A-Za-z_][\w]*(\.[A-Za-z_]\w*)+$/;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

// Used for "password = value" style matches, where the value is all we have to judge by.
export function looksLikeSecretValue(v) {
    const s = String(v || '');
    if (s.length < 8 || isPlaceholder(s)) return false;
    if (UUID.test(s) || DOTTED_NAME.test(s) || URL_LIKE.test(s)) return false;
    const hasDigitOrSymbol = /[0-9]/.test(s) || /[^A-Za-z0-9]/.test(s);
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
    if (classes < 2) return false;
    const h = entropy(s);
    // Letters only (camelCase names, words) are accepted only when long and truly random.
    if (!hasDigitOrSymbol) return s.length >= 32 && h >= 4.2;
    return h >= (s.length >= 16 ? 3.0 : 2.6);
}
