// Gives every open secret finding that has no remediation issue a chance to get one.
// Needed because a finding can open before remediation is switched on, and its one job is then
// spent. Safe to call as often as you like: the remediation worker claims each finding in the
// database, so a finding never gets two issues. Dependencies are injected for tests.
export function makeBackfill({ getConfig, listWithoutIssue, enqueue, limit = 20 }) {
  return async function backfillRemediation() {
    const cfg = await getConfig();
    if (!cfg || !cfg.enabled || !cfg.projectKey) return { queued: 0 };
    const ids = await listWithoutIssue(limit);
    if (ids.length) await enqueue(ids);
    return { queued: ids.length };
  };
}
