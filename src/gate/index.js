// Wires the Release Gate runner to Forge.
import { makeGateRunner } from './runner';
import { listVersions, readIssues, readRelatedWork, checkPage } from './jira';
import { loadPolicy, syncFindings, trackedReleases } from './store';
import { assessRelease, getHistory } from '../score/store';

export const gate = makeGateRunner({
  listVersions, readIssues, readRelatedWork, checkPage, loadPolicy, syncFindings,
  assess: assessRelease, getHistory,
});

// Hourly: re-check the versions people have looked at. One failure never stops the others.
export async function refreshTrackedGates(budgetMs = 60000) {
  const started = Date.now();
  const byProject = new Map();
  for (const r of await trackedReleases(10)) {
    if (!byProject.has(r.project_key)) byProject.set(r.project_key, []);
    byProject.get(r.project_key).push(r.release_id);
  }
  const report = { checked: 0, errors: 0 };
  for (const [projectKey, ids] of byProject) {
    if (Date.now() - started > budgetMs) break;
    try { report.checked += await gate.refreshVersions(projectKey, ids, 10); }
    catch (e) { report.errors++; console.log('TW_GATE_REFRESH_ERROR', projectKey, e.message); }
  }
  return report;
}
