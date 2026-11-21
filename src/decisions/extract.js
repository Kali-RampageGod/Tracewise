// Pulls decision statements out of a Confluence page body (storage format).
// Pure functions: no Forge, no database.
import { createHash } from 'crypto';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
export const decodeEntities = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] || m);
export const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const BLOCK_RE = /<(p|li|h[1-6]|td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const HAS_INNER_BLOCK = /<(p|li|h[1-6]|td|th)\b/i;

// Splits storage format into text blocks. A block keeps its Confluence local-id, which stays
// the same across edits, so a changed decision can be recognised as the same block.
// Without a local-id the id comes from the text, so an edit looks like "removed + added".
export function extractBlocks(storage) {
  const out = [];
  const walk = (html) => {
    for (const m of String(html || '').matchAll(BLOCK_RE)) {
      if (HAS_INNER_BLOCK.test(m[3])) { walk(m[3]); continue; } // prefer the innermost block
      const text = stripTags(m[3]);
      if (!text) continue;
      const lid = /local-id="([^"]+)"/.exec(m[2]);
      out.push({ blockId: lid ? lid[1] : 'h-' + sha256(text).slice(0, 12), text });
    }
  };
  walk(storage);
  return out;
}

const DECISION_RE =
  /\b(decision:|decided|we (will|have decided|chose|agreed|are going|'ll)|going with|instead of|will not|won't|must not|deprecated|standard is)\b/i;

export const isDecision = (text) => text.length >= 15 && text.length <= 1000 && DECISION_RE.test(text);

export const MAX_DECISIONS_PER_PAGE = 100;

// Decision blocks of a page, de-duplicated by block id, each with a content hash.
export function extractDecisions(storage) {
  const seen = new Set();
  const out = [];
  for (const b of extractBlocks(storage)) {
    if (!isDecision(b.text) || seen.has(b.blockId)) continue;
    seen.add(b.blockId);
    out.push({ ...b, hash: sha256(b.text) });
    if (out.length >= MAX_DECISIONS_PER_PAGE) break;
  }
  return out;
}

// Whole page as plain text, for secret scanning. Code macro bodies (CDATA) are kept:
// that is where people paste keys and connection strings.
export function pageText(storage) {
  return decodeEntities(
    String(storage || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => ' ' + c.replace(/</g, '‹') + ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/‹/g, '<').replace(/[ \t\r\f\v]+/g, ' ').trim();
}
