import React, { useEffect, useState } from 'react';
import { invoke, view } from '@forge/bridge';

const card = { border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 };
const tabBtn = (active) => ({
  padding: '6px 14px', marginRight: 6, borderRadius: 6, cursor: 'pointer',
  border: '1px solid #bbb', background: active ? '#0c66e4' : '#fff', color: active ? '#fff' : '#222',
});

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

  const color = { ready: '#1f845a', at_risk: '#b38600', blocked: '#c9372c' };
  const label = { ready: 'Ready', at_risk: 'At risk', blocked: 'Blocked' };

  return (
    <div>
      <h2>TraceWise {projectKey ? `· ${projectKey}` : ''}</h2>
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
      {tab === 'Decisions' && <div style={card}>Decision Memory will list decisions here.</div>}
      {tab === 'Findings' && <div style={card}>Secret and gate findings will appear here.</div>}
      {tab === 'Release gate' && <div style={card}>The Ready, At risk or Blocked verdict will appear here.</div>}
    </div>
  );
}

function SettingsPage({ projectKey }) {
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
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
      <div style={card}>
        <b>Rules</b>
        <p>Per-project rule toggles will go here (secret patterns, severity weights, gate thresholds).</p>
      </div>
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