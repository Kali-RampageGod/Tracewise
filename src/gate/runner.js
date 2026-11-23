// Runs the Release Gate for one version: read Jira, apply the rules, save findings, score.
// Dependencies are injected so this can be tested without Forge.
import { evaluateGate, findNotesLinks } from './evaluate.js';

export const isVersionId = (v) => /^\d{1,12}$/.test(String(v || ''));

export function makeGateRunner({
  listVersions, readIssues, readRelatedWork, checkPage, loadPolicy, syncFindings, assess, getHistory,
  readRuleIssues = async () => ({ issues: [], truncated: false }), countCritical = async () => null,
  now = () => new Date(),
}) {
  async function evaluateVersion(projectKey, version) {
    const policy = await loadPolicy(projectKey);
    let result;
    if (version.released) {
      result = evaluateGate({ version, issues: [], policy, notes: { links: [] }, now: now() });
      result.stats = { total: 0, done: 0, unfinished: 0, truncated: false };
    } else {
      const { issues, truncated } = await readIssues(version.id);
      let notes = { links: [], pageState: {} };
      if (policy.requireReleaseNotes) {
        const links = findNotesLinks(await readRelatedWork(version.id));
        const pageState = {};
        for (const l of links) {
          if (l.pageId && !(l.pageId in pageState)) pageState[l.pageId] = await checkPage(l.pageId);
        }
        notes = { links, pageState };
      }
      // A rule with a broken JQL is reported on its own row. Anything else (rate limit, outage) stops the run.
      const rules = [];
      for (const rule of policy.customRules || []) {
        try {
          const r = await readRuleIssues(version.id, rule.jql);
          rules.push({ rule, issues: r.issues, truncated: r.truncated });
        } catch (e) {
          if (e && e.status === 400) rules.push({ rule, issues: [], error: 'the JQL is not valid for this project' });
          else throw e;
        }
      }
      const criticalOpen = policy.requireNoCriticalFindings ? await countCritical(projectKey, String(version.id)) : null;
      result = evaluateGate({ version, issues, truncated, notes, policy, now: now(), rules, criticalOpen });
    }
    await syncFindings(projectKey, version.id, result.findings);
    const score = await assess(projectKey, String(version.id), { forceBlockGate: policy.blockOnCriticalIssue });
    return { result, score, policy };
  }

  // Full result for the Release gate tab.
  async function runGate(projectKey, versionId) {
    if (!isVersionId(versionId)) return { error: 'Invalid version id' };
    const version = (await listVersions(projectKey)).find((v) => String(v.id) === String(versionId));
    if (!version) return { error: 'This version does not exist in this project' };
    const { result, score } = await evaluateVersion(projectKey, version);
    const blockers = [...result.findings].sort((a, b) => b.severity - a.severity);
    return {
      version: { id: String(version.id), name: version.name, releaseDate: version.releaseDate || null, released: !!version.released },
      released: result.released,
      stats: result.stats,
      checks: result.checks,
      blockers: blockers.map((f) => ({ key: f.key, title: f.title, severity: f.severity, detail: f.detail })),
      score: { score: score.score, band: score.band, blockedReason: score.blockedReason, breakdown: score.breakdown },
      history: await getHistory(projectKey, String(version.id), 10),
    };
  }

  // Event and hourly path: refresh unreleased versions only. Returns how many ran.
  async function refreshVersions(projectKey, versionIds, limit = 5) {
    const wanted = new Set(versionIds.filter(isVersionId).map(String));
    if (wanted.size === 0) return 0;
    const versions = (await listVersions(projectKey))
      .filter((v) => wanted.has(String(v.id)) && !v.released && !v.archived)
      .slice(0, limit);
    for (const v of versions) await evaluateVersion(projectKey, v);
    return versions.length;
  }

  return { runGate, refreshVersions };
}
