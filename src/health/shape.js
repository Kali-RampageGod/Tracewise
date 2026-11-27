// Turns raw numbers into the admin health view. Pure: no Forge, no database.
export const SCAN_STALE_MINUTES = 180; // the scans run hourly, so 3 hours of silence is a problem

const SCAN_NAME = { reconcile_jira: 'Jira work items', reconcile_confluence: 'Confluence pages' };

export function shapeHealth({ applied = [], expected = [], scans = [], counts = {}, events = {} }) {
  const have = new Set(applied);
  const missing = expected.filter((n) => !have.has(n));
  const problems = [];
  if (missing.length) problems.push(`${missing.length} database migration${missing.length > 1 ? 's' : ''} not applied. Use "Run migrations".`);

  const shownScans = scans.map((s) => {
    const minutes = s.minutes_ago == null ? null : Number(s.minutes_ago);
    const stale = minutes == null || minutes > SCAN_STALE_MINUTES;
    const failing = s.status === 'error';
    const name = SCAN_NAME[s.scan_type] || String(s.scan_type);
    if (failing) problems.push(`The ${name} scan failed last time: ${s.error_text || 'no detail'}`);
    else if (stale) problems.push(`The ${name} scan has not finished in over ${SCAN_STALE_MINUTES / 60} hours.`);
    return { name, status: s.status, lastFinishedMinutesAgo: minutes, itemsScanned: Number(s.items_scanned) || 0, error: failing ? s.error_text || null : null, stale };
  });
  if (!scans.length) problems.push('No scan has run yet. Use "Scan now".');

  return {
    status: problems.length ? 'attention' : 'ok',
    problems,
    migrations: { applied: applied.length, expected: expected.length, missing },
    scans: shownScans,
    counts: {
      decisionsActive: Number(counts.decisionsActive) || 0,
      decisionsTotal: Number(counts.decisionsTotal) || 0,
      openFindings: counts.openFindings || {},
    },
    events: { last24h: Number(events.last24h) || 0, lastMinutesAgo: events.lastMinutesAgo == null ? null : Number(events.lastMinutesAgo) },
  };
}
