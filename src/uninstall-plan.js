// Clean-up plan for when the app is removed. Pure: no Forge, no database.
//
// The database is shared by the Jira and Confluence installations of one site. Removing only the
// Confluence side must not wipe the Jira data, so the plan depends on which product is leaving.
// If the product cannot be told, nothing is deleted.

const ALL_TABLES = ['finding_events', 'findings', 'decisions', 'decision_feedback', 'release_assessments',
  'project_rules', 'secret_allowlist', 'processed_events', 'scan_state'];

export function productOf(installContext) {
  const s = String(installContext || '').toLowerCase();
  if (s.includes(':jira:')) return 'jira';
  if (s.includes(':confluence:')) return 'confluence';
  return null;
}

// Each statement is a single DELETE, as Forge SQL allows one statement per call.
export function planCleanup(installContext) {
  const product = productOf(installContext);
  if (product === 'jira') return { product, statements: ALL_TABLES.map((t) => `DELETE FROM ${t}`) };
  if (product === 'confluence') {
    return {
      product,
      statements: [
        'DELETE FROM decision_feedback',
        'DELETE FROM decisions',
        "DELETE FROM findings WHERE source_type = 'confluence_page' OR type = 'decision_conflict'",
        'DELETE FROM finding_events WHERE finding_id NOT IN (SELECT id FROM findings)',
        "DELETE FROM scan_state WHERE scan_type = 'reconcile_confluence'",
      ],
    };
  }
  return { product: null, statements: [] };
}

export async function runCleanup(installContext, run) {
  const plan = planCleanup(installContext);
  let done = 0;
  for (const text of plan.statements) {
    try { await run(text); done += 1; } catch (e) { console.log('TW_CLEANUP_ERROR', text, e && e.message); }
  }
  return { product: plan.product, planned: plan.statements.length, done };
}
