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
          <p>No assessment yet. Scans and scoring are added in the next blocks.</p>
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
  const call = async (name) => {
    setBusy(true);
    setOut('Running ' + name + '...');
    try { setOut(String(await invoke(name))); }
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