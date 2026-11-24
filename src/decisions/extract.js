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

// ---- Decision template: a two-column Confluence table ----
const TABLE_RE = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
const ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL_RE = /<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const ACTIVE_WORDS = new Set(['', 'active', 'accepted', 'approved', 'decided']);

// Returns { decision } or null when the table is not a decision template.
// decision is null when it is a template whose status is not active.
function parseTemplate(table) {
  const f = {};
  let blockId = null;
  for (const row of table.matchAll(ROW_RE)) {
    const cells = [...row[1].matchAll(CELL_RE)];
    if (cells.length < 2) continue;
    const label = stripTags(cells[0][3]).toLowerCase().replace(/[:\s]+$/, '');
    f[label] = stripTags(cells[1][3]);
    if (label === 'decision') {
      const lid = /local-id="([^"]+)"/.exec(row[0]);
      blockId = lid ? lid[1] : null;
    }
  }
  if (!f.decision || !(f.status !== undefined || f.scope !== undefined || f.rationale !== undefined)) return null;
  if (!ACTIVE_WORDS.has((f.status || '').toLowerCase())) return { decision: null };
  if (f.decision.length < 5 || f.decision.length > 1000) return { decision: null };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(f.date || '') ? f.date : null;
  const fields = {
    title: (f.title || f.decision).slice(0, 255),
    scope: (f.scope || '').slice(0, 255) || null,
    rationale: (f.rationale || '').slice(0, 2000) || null,
    decidedOn: date,
  };
  return {
    decision: {
      blockId: blockId || 'h-' + sha256(f.decision).slice(0, 12),
      text: f.decision,
      ...fields,
      // Hash covers every field, so a rationale-only edit counts as a change.
      hash: sha256([f.decision, fields.scope, fields.rationale, date].join('\u0001')),
    },
  };
}

// Template tables first, then free-text sentences that sound like decisions.
export function extractDecisions(storage) {
  const seen = new Set();
  const out = [];
  const add = (d) => {
    if (seen.has(d.blockId) || out.length >= MAX_DECISIONS_PER_PAGE) return;
    seen.add(d.blockId);
    out.push(d);
  };
  // Template tables are removed so the sentence pass does not read them twice.
  const rest = String(storage || '').replace(TABLE_RE, (table) => {
    const t = parseTemplate(table);
    if (!t) return table;
    if (t.decision) add(t.decision);
    return '';
  });
  for (const b of extractBlocks(rest)) {
    if (isDecision(b.text)) add({ ...b, hash: sha256(b.text), title: null, scope: null, rationale: null, decidedOn: null });
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
