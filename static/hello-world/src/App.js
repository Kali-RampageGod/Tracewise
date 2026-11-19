import React, { useState } from 'react';
import { invoke } from '@forge/bridge';

function App() {
  const [out, setOut] = useState('Ready.');
  const [busy, setBusy] = useState(false);
  const [pageId, setPageId] = useState('');

  const call = async (name, payload) => {
    setBusy(true);
    setOut('Running ' + name + '...');
    try {
      setOut(String(await invoke(name, payload)));
    } catch (e) {
      setOut('Error: ' + (e && e.message ? e.message : JSON.stringify(e)));
    }
    setBusy(false);
  };

  return (
    <div style={{ padding: 16, fontFamily: 'sans-serif' }}>
      <h2>TraceWise: Forge checks</h2>
      <button disabled={busy} onClick={() => call('runMigration')}>1. Run migration</button>{' '}
      <button disabled={busy} onClick={() => call('sqlPoc')}>2. Run SQL test</button>
      <div style={{ marginTop: 16 }}>
        <input
          value={pageId}
          onChange={(e) => setPageId(e.target.value.trim())}
          placeholder="Confluence page ID"
          style={{ padding: 4, width: 220 }}
        />{' '}
        <button disabled={busy || !pageId} onClick={() => call('versionPoc', { pageId })}>
          3. Run version history test
        </button>
      </div>
      <pre style={{ whiteSpace: 'pre-wrap', marginTop: 16 }}>{out}</pre>
    </div>
  );
}

export default App;