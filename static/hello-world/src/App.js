import React, { useEffect, useState } from 'react';
import { invoke, view, router } from '@forge/bridge';

const card = { border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 };
const tabBtn = (active) => ({
  padding: '6px 14px', marginRight: 6, borderRadius: 6, cursor: 'pointer',
  border: '1px solid #bbb', background: active ? '#0c66e4' : '#fff', color: active ? '#fff' : '#222',
});

const openPage = (pageId) => router.open('/wiki/pages/viewpage.action?pageId=' + pageId);

function DecisionsTab({ projectKey }) {
  const [status, setStatus] = useState('active');
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = (offset, replace) => {
    setLoading(true);
    invoke('getDecisions', { projectKey, status, offset })
      .then((r) => {
        if (r.error) { setErr(r.error); return; }
        setErr(null);
        setRows((prev) => (replace ? r.rows : prev.concat(r.rows)));
        setHasMore(r.hasMore);
      })
      .catch((e) => setErr(String(e && e.message ? e.message : e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (projectKey) load(0, true); }, [projectKey, status]);

  return (
    <div style={card}>
      <b>Decision Memory</b>
      <div style={{ margin: '8px 0' }}>
        {['active', 'superseded', 'all'].map((s) => (
          <button key={s} style={tabBtn(s === status)} onClick={() => setStatus(s)}>
            {s === 'active' ? 'Active' : s === 'superseded' ? 'History' : 'All'}
          </button>
        ))}
      </div>
      {err && <p>Error: {err}</p>}
      {!err && loading && rows.length === 0 && <p>Loading...</p>}
      {!err && !loading && rows.length === 0 && (
        <p>
          No decisions yet. TraceWise reads Confluence pages and keeps sentences such as
          "We decided to use X instead of Y" or "We will not support Z". Edit a page, then wait for the next scan.
        </p>
      )}
      {rows.map((d) => (
        <div key={d.id} style={{ borderTop: '1px solid #ddd', padding: '8px 0' }}>
          <div><b>{d.text}</b></div>
          <div>
            {d.status === 'active' ? 'Active' : 'Replaced'} · page version {d.pageVersion}
            {d.decidedAt ? ` · decided ${d.decidedAt}` : ''}
          </div>
          <a href="#" onClick={(e) => { e.preventDefault(); openPage(d.pageId); }}>Open page: {d.pageTitle}</a>
          {d.replacedBy && <div>Now reads: <i>{d.replacedBy.text}</i> (version {d.replacedBy.pageVersion})</div>}
          {d.status === 'superseded' && !d.replacedBy && <div>This decision was removed from the page.</div>}
          {d.conflicts.length > 0 && (
            <div style={{ color: '#c9372c' }}>
              Possible conflicts: {d.conflicts.map((c) => c.issueKey || c.title).join(', ')}
            </div>
          )}
        </div>
      ))}
      {hasMore && <button style={tabBtn(false)} disabled={loading} onClick={() => load(rows.length, false)}>Load more</button>}
    </div>
  );
}

const bandColor = { ready: '#1f845a', at_risk: '#b38600', blocked: '#c9372c' };
const bandLabel = { ready: 'Ready', at_risk: 'At risk', blocked: 'Blocked' };
const sevLabel = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' };
const checkIcon = { pass: '\u2714', fail: '\u2716', warn: '!', skipped: '\u2013', info: 'i' };
const checkColor = { pass: '#1f845a', fail: '#c9372c', warn: '#b38600', skipped: '#6b778c', info: '#6b778c' };
const errText = (e) => String(e && e.message ? e.message : e);

function GateTab({ projectKey }) {
  const [releases, setReleases] = useState(null);
  const [versionId, setVersionId] = useState('');
  const [gate, setGate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!projectKey) return;
    invoke('getReleases', { projectKey })
      .then((r) => {
        if (r.error) { setErr(r.error); return; }
        setReleases(r.rows);
        if (r.rows.length) setVersionId(r.rows[0].id);
      })
      .catch((e) => setErr(errText(e)));
  }, [projectKey]);

  const check = (id) => {
    setLoading(true);
    setErr(null);
    invoke('runGate', { projectKey, versionId: id })
      .then((r) => { if (r.error) { setErr(r.error); setGate(null); } else setGate(r); })
      .catch((e) => setErr(errText(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (versionId) check(versionId); }, [versionId]);

  return (
    <div style={card}>
      <b>Release gate</b>
      {releases && releases.length === 0 && (
        <p>This project has no versions yet. In Jira, open Releases, create a version, and set the Fix version on its work items.</p>
      )}
      {releases && releases.length > 0 && (
        <div style={{ margin: '8px 0' }}>
          <select value={versionId} onChange={(e) => setVersionId(e.target.value)}>
            {releases.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}{v.releaseDate ? ` (due ${v.releaseDate})` : ''}{v.released ? ' - released' : ''}
              </option>
            ))}
          </select>{' '}
          <button style={tabBtn(false)} disabled={loading || !versionId} onClick={() => check(versionId)}>Check again</button>
        </div>
      )}
      {err && <p style={{ color: '#c9372c' }}>Error: {err}</p>}
      {loading && <p>Reading Jira...</p>}
      {gate && !loading && (
        <div>
          <div style={{ fontSize: 40, fontWeight: 700, color: bandColor[gate.score.band] }}>
            {gate.released ? 'Released' : bandLabel[gate.score.band]} <span style={{ fontSize: 24 }}>{gate.score.score}</span>
          </div>
          {gate.score.blockedReason && <p>Reason: {gate.score.blockedReason}</p>}
          {!gate.released && <p>{gate.stats.total} work items · {gate.stats.done} done · {gate.stats.unfinished} not done</p>}

          <b>Checks</b>
          <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
            {gate.checks.map((c) => (
              <li key={c.key} style={{ padding: '2px 0' }}>
                <span style={{ color: checkColor[c.status], fontWeight: 700, display: 'inline-block', width: 20 }}>{checkIcon[c.status]}</span>
                {c.label} <span style={{ color: '#6b778c' }}>· {c.detail}</span>
              </li>
            ))}
          </ul>

          {gate.blockers.length > 0 && (
            <div>
              <b>Problems to fix</b>
              {gate.blockers.map((b) => (
                <div key={b.key} style={{ borderTop: '1px solid #ddd', padding: '6px 0' }}>
                  <div>{b.title}</div>
                  <div style={{ color: '#6b778c' }}>
                    {sevLabel[b.severity]}
                    {b.detail && b.detail.status ? ` · ${b.detail.status}` : ''}
                    {b.detail && b.detail.priority ? ` · ${b.detail.priority} priority` : ''}
                  </div>
                  {b.detail && b.detail.issueKey && (
                    <a href="#" onClick={(e) => { e.preventDefault(); router.open('/browse/' + b.detail.issueKey); }}>Open {b.detail.issueKey}</a>
                  )}
                  {b.detail && b.detail.pageId && (
                    <a href="#" onClick={(e) => { e.preventDefault(); openPage(b.detail.pageId); }}>Open linked page</a>
                  )}
                </div>
              ))}
            </div>
          )}

          {gate.score.breakdown.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <b>Where the points went</b>
              <ul>{gate.score.breakdown.map((b) => <li key={b.finding_id}>-{b.points}: {b.title}</li>)}</ul>
            </div>
          )}

          {gate.history.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <b>Score history</b>
              <ul>
                {gate.history.map((h, i) => (
                  <li key={i}>{h.computed_at}: {h.score} ({bandLabel[h.band] || h.band}{h.blocked_reason ? `, ${h.blocked_reason}` : ''})</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const POLICY_LABELS = {
  requireReleaseNotes: 'Release notes must be linked to the version, and the page must exist',
  flagBlockedLinks: 'Flag unfinished work items that are blocked by other unfinished items',
  flagOverdue: 'Flag versions whose release date has passed',
  flagEmptyRelease: 'Flag versions with no work items',
  blockOnCriticalIssue: 'An unfinished Highest or Blocker work item forces the verdict to Blocked',
};

function PolicyCard({ projectKey }) {
  const [state, setState] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!projectKey) return;
    invoke('getGatePolicy', { projectKey })
      .then((r) => { setState(r); if (r.policy) setPolicy(r.policy); })
      .catch((e) => setState({ error: errText(e) }));
  }, [projectKey]);

  const save = () => {
    setMsg('Saving...');
    invoke('saveGatePolicy', { projectKey, policy })
      .then((r) => { if (r.error) setMsg('Error: ' + r.error); else { setPolicy(r.policy); setMsg('Saved.'); } })
      .catch((e) => setMsg('Error: ' + errText(e)));
  };

  return (
    <div style={card}>
      <b>Release gate policy</b>
      {!state && <p>Loading...</p>}
      {state && state.error && <p>Error: {state.error}</p>}
      {state && !state.error && policy && (
        <div>
          {Object.keys(POLICY_LABELS).map((k) => (
            <div key={k}>
              <label>
                <input type="checkbox" checked={!!policy[k]} disabled={!state.canEdit}
                  onChange={(e) => setPolicy({ ...policy, [k]: e.target.checked })} />{' '}
                {POLICY_LABELS[k]}
              </label>
            </div>
          ))}
          {state.canEdit
            ? <p><button onClick={save}>Save policy</button> {msg}</p>
            : <p>Only project administrators can change the policy.</p>}
        </div>
      )}
    </div>
  );
}

function ProjectPage({ projectKey }) {
  const tabs = ['Overview', 'Decisions', 'Findings', 'Release gate'];
  const [tab, setTab] = useState('Overview');
  const [ov, setOv] = useState(null);

  // Load the latest score whenever the Overview tab is opened.
  useEffect(() => {
    if (!projectKey || tab !== 'Overview') return;
    invoke('getOverview', { projectKey })
      .then(setOv)
      .catch((e) => setOv({ error: String(e && e.message ? e.message : e) }));
  }, [projectKey, tab]);

  const [fl, setFl] = useState(null);
  useEffect(() => {
    if (!projectKey || tab !== 'Findings') return;
    invoke('getFindings', { projectKey })
      .then(setFl)
      .catch((e) => setFl({ error: String(e && e.message ? e.message : e) }));
  }, [projectKey, tab]);
  const sev = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' };
  const conf = (c) => (Number(c) >= 80 ? 'confirmed' : Number(c) >= 40 ? 'unclear' : 'weak');

  const color = { ready: '#1f845a', at_risk: '#b38600', blocked: '#c9372c' };
  const label = { ready: 'Ready', at_risk: 'At risk', blocked: 'Blocked' };

  return (
    <div>
      <h2>TraceWise {projectKey ? `· ${projectKey}` : ''}</h2>
      <p style={{ color: '#6b778c', margin: '0 0 8px' }}>
        Detection may take a few minutes after a page or work item changes.
      </p>
      <div style={{ marginBottom: 12 }}>
        {tabs.map((t) => (
          <button key={t} style={tabBtn(t === tab)} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === 'Overview' && (
        <div style={card}>
          <b>Release confidence score</b>
          {!ov && <p>Loading...</p>}
          {ov && ov.error && <p>Error: {ov.error}</p>}
          {ov && ov.empty && <p>No assessment yet.</p>}
          {ov && !ov.empty && !ov.error && (
            <div>
              <div style={{ fontSize: 48, fontWeight: 700, color: color[ov.band] }}>{ov.score}</div>
              <div style={{ fontWeight: 600, color: color[ov.band] }}>{label[ov.band] || ov.band}</div>
              {ov.blocked_reason && <p>Reason: {ov.blocked_reason}</p>}
              <p>{ov.open_findings} open findings · release {ov.release_id} · {ov.computed_at}</p>
              <b>Where the points went</b>
              <ul>
                {ov.breakdown.map((b) => (
                  <li key={b.finding_id}>-{b.points}: {b.title} ({b.reason})</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {tab === 'Decisions' && <DecisionsTab projectKey={projectKey} />}
      {tab === 'Findings' && (
        <div style={card}>
          <b>Open findings</b>
          {!fl && <p>Loading...</p>}
          {fl && fl.error && <p>Error: {fl.error}</p>}
          {fl && !fl.error && fl.rows.length === 0 && <p>No open findings.</p>}
          {fl && !fl.error && fl.rows.map((f) => (
            <div key={f.id} style={{ borderTop: '1px solid #ddd', padding: '8px 0' }}>
              <div><b>{f.title}</b></div>
              <div>{sev[f.severity]} · {conf(f.evidence_confidence)} ({f.evidence_confidence}) · first seen {f.first_seen_at}</div>
              {f.detail && f.detail.shared && <div>Matched words: {f.detail.shared.join(', ')}</div>}
              {f.redacted_preview && <div>Found: <code>{f.redacted_preview}</code> (real value never stored)</div>}
              {f.type === 'secret' && f.detail && f.detail.inCurrentVersion === false && (
                <div>No longer in the current page, but it is still in the page history. Rotate it.</div>
              )}
              {f.detail && f.detail.pageId && (
                <a href="#" onClick={(e) => { e.preventDefault(); openPage(f.detail.pageId); }}>
                  {f.type === 'secret' ? 'Open the page' : 'Open the original decision'}: {f.detail.pageTitle}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
      {tab === 'Release gate' && <GateTab projectKey={projectKey} />}
    </div>
  );
}

function SettingsPage({ projectKey }) {
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [pageId, setPageId] = useState('');
  const [issueKey, setIssueKey] = useState('TRAC-2');
  const call = async (name, payload) => {
    setBusy(true);
    setOut('Running ' + name + '...');
    try { setOut(String(await invoke(name, payload))); }
    catch (e) { setOut('Error: ' + (e && e.message ? e.message : JSON.stringify(e))); }
    setBusy(false);
  };
  return (
    <div>
      <h2>TraceWise settings {projectKey ? `· ${projectKey}` : ''}</h2>
      <PolicyCard projectKey={projectKey} />
      <div style={card}>
        <b>Database</b>
        <div>
          <button disabled={busy} onClick={() => call('migrate')}>Run migrations</button>{' '}
          <button disabled={busy} onClick={() => call('migrationStatus')}>Show applied migrations</button>
          <button disabled={busy} onClick={() => call('reconcileNow')}>Run scan now</button>
          <button disabled={busy} onClick={() => call('processedEvents')}>Show processed events</button>

          <br /><br />
          <button disabled={busy} onClick={() => call('scoreDemo', { projectKey, type: 'gate', severity: 3 })}>Add high gate problem</button>{' '}
          <button disabled={busy} onClick={() => call('scoreDemo', { projectKey, type: 'secret', severity: 4 })}>Add critical secret</button>{' '}
          <button disabled={busy} onClick={() => call('scoreDemoClear', { projectKey })}>Clear demo data</button>

          <br /><br />
          <input placeholder="Confluence page id" value={pageId} onChange={(e) => setPageId(e.target.value)} />{' '}
          <button disabled={busy} onClick={() => call('decisionDemoCreate', { projectKey, pageId })}>Create demo decision</button>{' '}
          <button disabled={busy} onClick={() => call('decisionDemoClear', { projectKey })}>Clear demo decision</button>

          <br /><br />
          <input value={issueKey} onChange={(e) => setIssueKey(e.target.value)} />{' '}
          <button disabled={busy} onClick={() => call('decisionDemoScan', { projectKey, issueKey })}>Scan issue</button>

          {' '}<button disabled={busy} onClick={() => call('secretScanClear', { projectKey })}>Clear scanned secrets</button>
        </div>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{out}</pre>
      </div>
    </div>
  );
}

function App() {
  const [ctx, setCtx] = useState(null);
  useEffect(() => { view.getContext().then(setCtx); }, []);
  if (!ctx) return <div style={{ padding: 16 }}>Loading...</div>;
  const projectKey = ctx.extension && ctx.extension.project ? ctx.extension.project.key : null;
  const isSettings = ctx.moduleKey === 'tracewise-settings-page';
  return (
    <div style={{ padding: 16, fontFamily: 'sans-serif' }}>
      {isSettings ? <SettingsPage projectKey={projectKey} /> : <ProjectPage projectKey={projectKey} />}
    </div>
  );
}

export default App;