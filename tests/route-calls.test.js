import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Forge refuses a plain string path in requestJira / requestConfluence. Every call must use the
// route`...` template. This test scans the source so such a call cannot slip in again.
function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('no Jira or Confluence call passes a plain string path', () => {
  const bad = [];
  for (const f of files('src')) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(jiraGet|jiraWrite|confluenceGet|requestJira|requestConfluence)\(\s*(['"`])/g)) {
      bad.push(`${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(bad, []);
});
