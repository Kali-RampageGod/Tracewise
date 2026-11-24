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
      {rows.map((d) => d.restricted ? (
        <div key={d.id} style={{ borderTop: '1px solid #ddd', padding: '8px 0' }}>
          <RestrictedNote />
        </div>
      ) : (
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

function GateTab({ projectKey, initialVersionId }) {
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
        const wanted = r.rows.find((v) => v.id === initialVersionId);
        if (r.rows.length) setVersionId(wanted ? wanted.id : r.rows[0].id);
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

  // Keep an open tab fresh: re-check quietly every minute, never while a check is running.
  useEffect(() => {
    if (!versionId) return undefined;
    const t = setInterval(() => {
      invoke('runGate', { projectKey, versionId })
        .then((r) => { if (!r.error) setGate(r); })
        .catch(() => { });
    }, 60000);
    return () => clearInterval(t);
  }, [projectKey, versionId]);

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
  requireNoCriticalFindings: 'Open critical findings (such as a leaked secret) fail the gate',
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

  const setRule = (i, patch) => setPolicy({ ...policy, customRules: policy.customRules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

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
          <div style={{ marginTop: 8 }}>
            <label>Required states (comma separated, empty means the Done category):{' '}
              <input style={{ width: 260 }} disabled={!state.canEdit} placeholder="Done, Released"
                value={(policy.requiredStatuses || []).join(', ')}
                onChange={(e) => setPolicy({ ...policy, requiredStatuses: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
            </label>
          </div>
          <div style={{ marginTop: 8 }}>
            <b>Custom rules</b> (a work item of the version that matches the JQL is a problem)
            {(policy.customRules || []).map((r, i) => (
              <div key={i} style={{ margin: '4px 0' }}>
                <input style={{ width: 150 }} placeholder="Name" disabled={!state.canEdit} value={r.name}
                  onChange={(e) => setRule(i, { name: e.target.value })} />{' '}
                <input style={{ width: 280 }} placeholder='JQL, for example labels = "needs-qa"' disabled={!state.canEdit} value={r.jql}
                  onChange={(e) => setRule(i, { jql: e.target.value })} />{' '}
                <select disabled={!state.canEdit} value={r.severity || 3} onChange={(e) => setRule(i, { severity: Number(e.target.value) })}>
                  <option value={1}>Low</option><option value={2}>Medium</option><option value={3}>High</option><option value={4}>Critical</option>
                </select>{' '}
                {state.canEdit && <button onClick={() => setPolicy({ ...policy, customRules: policy.customRules.filter((_, j) => j !== i) })}>Remove</button>}
              </div>
            ))}
            {state.canEdit && (policy.customRules || []).length < 5 && (
              <button onClick={() => setPolicy({ ...policy, customRules: [...(policy.customRules || []), { name: '', jql: '', severity: 3 }] })}>Add rule</button>
            )}
          </div>
          {state.canEdit
            ? <p><button onClick={save}>Save policy</button> {msg}</p>
            : <p>Only project administrators can change the policy.</p>}
        </div>
      )}
    </div>
  );
}

const SEV = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' };
const confWord = (c) => (Number(c) >= 80 ? 'confirmed' : Number(c) >= 40 ? 'unclear' : 'weak');
const DISMISS_CODES = [
  ['false_positive', 'Not a real secret'],
  ['test_data', 'Test or sample data'],
  ['accepted_risk', 'Risk accepted'],
];

function SecretActions({ f, projectKey, onDone }) {
  const [mode, setMode] = useState(null);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('false_positive');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const labels = {
    confirm_rotation: 'Confirm that the credential was rotated or revoked',
    dismiss: 'Dismiss this finding',
    allow_value: 'Never report this exact value again',
    allow_source: 'Never report anything from this page or work item again',
  };
  const submit = () => {
    setBusy(true);
    setErr(null);
    invoke('secretAction', { projectKey, findingId: f.id, action: mode, reason, code })
      .then((r) => { if (r.error) setErr(r.error); else onDone(); })
      .catch((e) => setErr(errText(e)))
      .finally(() => setBusy(false));
  };
  if (!mode) {
    return (
      <div style={{ marginTop: 6 }}>
        <button style={tabBtn(false)} onClick={() => setMode('confirm_rotation')}>Confirm rotated</button>
        <button style={tabBtn(false)} onClick={() => setMode('dismiss')}>Dismiss</button>
        <button style={tabBtn(false)} onClick={() => setMode('allow_value')}>Allow this value</button>
        <button style={tabBtn(false)} onClick={() => setMode('allow_source')}>Allow this source</button>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 6 }}>
      <div><b>{labels[mode]}</b></div>
      {mode === 'dismiss' && (
        <select value={code} onChange={(e) => setCode(e.target.value)}>
          {DISMISS_CODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      )}{' '}
      <input style={{ width: 280 }} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />{' '}
      <button disabled={busy || reason.trim().length < 3} onClick={submit}>Save</button>{' '}
      <button disabled={busy} onClick={() => { setMode(null); setErr(null); }}>Cancel</button>
      {err && <div style={{ color: '#c9372c' }}>Error: {err}</div>}
    </div>
  );
}

function FindingsTab({ projectKey }) {
  const [view, setView] = useState('open');
  const [fl, setFl] = useState(null);
  const load = () => {
    if (!projectKey) return;
    invoke('getFindings', { projectKey, status: view })
      .then(setFl)
      .catch((e) => setFl({ error: errText(e) }));
  };
  useEffect(() => { setFl(null); load(); }, [projectKey, view]);

  return (
    <div style={card}>
      <b>Findings</b>
      <div style={{ margin: '8px 0' }}>
        <button style={tabBtn(view === 'open')} onClick={() => setView('open')}>Open</button>
        <button style={tabBtn(view === 'closed')} onClick={() => setView('closed')}>Closed</button>
      </div>
      {!fl && <p>Loading...</p>}
      {fl && fl.error && <p>Error: {fl.error}</p>}
      {fl && !fl.error && fl.rows.length === 0 && <p>{view === 'open' ? 'No open findings.' : 'No closed findings.'}</p>}
      {fl && !fl.error && fl.rows.map((f) => {
        if (f.restricted) {
          return (
            <div key={f.id} style={{ borderTop: '1px solid #ddd', padding: '8px 0' }}>
              <div>{SEV[f.severity]} · open {f.ageText || 'unknown'}</div>
              <RestrictedNote />
            </div>
          );
        }
        const d = f.detail || {};
        return (
          <div key={f.id} style={{ borderTop: '1px solid #ddd', padding: '8px 0' }}>
            <div><b>{f.title}</b></div>
            <div style={{ color: '#6b778c' }}>Owner: {f.ownerName || 'unknown'} · open {f.ageText || 'unknown'}</div>
            <div>
              {SEV[f.severity]} · {confWord(f.evidence_confidence)} ({f.evidence_confidence}) · first seen {f.first_seen_at}
              {f.status !== 'open' ? ` · ${f.status === 'resolved' ? 'rotation confirmed' : 'dismissed'} ${f.resolved_at || ''}` : ''}
            </div>
            {d.shared && <div>Matched words: {d.shared.join(', ')}</div>}
            {f.redacted_preview && <div>Found: <code>{f.redacted_preview}</code> (real value never stored)</div>}
            {f.type === 'secret' && d.historyOnly && (
              <div>Only in page version {d.foundInVersion}, not in the current page. It is still exposed in the history. Rotate it.</div>
            )}
            {f.type === 'secret' && !d.historyOnly && d.inCurrentVersion === false && (
              <div>No longer in the current text, but it is still in the history. Rotate it.</div>
            )}
            {d.pageId && (
              <a href="#" onClick={(e) => { e.preventDefault(); openPage(d.pageId); }}>
                {f.type === 'secret' ? 'Open the page' : 'Open the original decision'}: {d.pageTitle}
              </a>
            )}
            {f.link && f.link.kind !== 'page' && (
              <div>
                <a href="#" onClick={(e) => { e.preventDefault(); openLink(f.link, projectKey); }}>{linkText(f.link)}</a>
              </div>
            )}
            {f.type === 'secret' && f.remediation_issue_key && (
              <div>
                Remediation issue:{' '}
                <a href="#" onClick={(e) => { e.preventDefault(); router.open('/browse/' + f.remediation_issue_key); }}>{f.remediation_issue_key}</a>
              </div>
            )}
            {f.type === 'secret' && !f.remediation_issue_key && f.status === 'open' && (
              <div style={{ color: '#6b778c' }}>No remediation issue yet. Choose a project for them in Space settings.</div>
            )}
            {f.type === 'secret' && f.status === 'open' && <SecretActions f={f} projectKey={projectKey} onDone={load} />}
          </div>
        );
      })}
    </div>
  );
}

function RemediationCard({ projectKey }) {
  const [state, setState] = useState(null);
  const [target, setTarget] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!projectKey) return;
    invoke('getRemediationConfig', { projectKey })
      .then((r) => {
        setState(r);
        if (r.config) { setTarget(r.config.projectKey || projectKey); setEnabled(!!r.config.enabled); }
      })
      .catch((e) => setState({ error: errText(e) }));
  }, [projectKey]);
  const save = () => {
    setMsg('Saving...');
    invoke('saveRemediationConfig', { projectKey, targetProject: target, enabled })
      .then((r) => setMsg(r.error ? 'Error: ' + r.error : r.queued ? `Saved. Creating ${r.queued} issue${r.queued > 1 ? 's' : ''} for open findings.` : 'Saved.'))
      .catch((e) => setMsg('Error: ' + errText(e)));
  };
  return (
    <div style={card}>
      <b>Secret remediation</b>
      <p>When Tracewise finds a secret, it creates one Jira work item that asks the owner to rotate it. The owner is assigned and mentioned.</p>
      {!state && <p>Loading...</p>}
      {state && state.error && <p>Error: {state.error}</p>}
      {state && !state.error && (
        <div>
          <label>
            <input type="checkbox" checked={enabled} disabled={!state.canEdit} onChange={(e) => setEnabled(e.target.checked)} />{' '}
            Create remediation issues
          </label>
          <div style={{ margin: '6px 0' }}>
            Project key for the issues:{' '}
            <input style={{ width: 90 }} value={target} disabled={!state.canEdit} onChange={(e) => setTarget(e.target.value)} />
          </div>
          {state.canEdit
            ? <p><button onClick={save}>Save</button> {msg}</p>
            : <p>Only project administrators can change this.</p>}
        </div>
      )}
    </div>
  );
}

const openLink = (link, projectKey) => {
  if (!link) return;
  if (link.kind === 'page') openPage(link.id);
  else if (link.kind === 'issue') router.open('/browse/' + link.key);
  else router.open(`/projects/${projectKey}/versions/${link.id}`);
};
const linkText = (link) =>
  link.kind === 'page' ? `Open page: ${link.label}` : link.kind === 'issue' ? `Open ${link.key}` : `Open version ${link.label}`;

function RestrictedNote() {
  return (
    <div>
      <span style={{ background: '#dfe1e6', borderRadius: 3, padding: '1px 6px', fontWeight: 600 }}>Restricted</span>{' '}
      You cannot open the source of this item, so its details are hidden. Ask its owner for access.
    </div>
  );
}

function OverviewTab({ projectKey, onOpenRelease }) {
  const [ov, setOv] = useState(null);
  useEffect(() => {
    if (!projectKey) return;
    invoke('getOverview', { projectKey })
      .then(setOv)
      .catch((e) => setOv({ error: errText(e) }));
  }, [projectKey]);

  return (
    <div>
      <div style={card}>
        <b>Release confidence score</b>
        {!ov && <p>Loading...</p>}
        {ov && ov.error && <p>Error: {ov.error}</p>}
        {ov && ov.empty && <p>No assessment yet.</p>}
        {ov && !ov.empty && !ov.error && (
          <div>
            <div style={{ fontSize: 48, fontWeight: 700, color: bandColor[ov.current.band] }}>{ov.current.score}</div>
            <div style={{ fontWeight: 600, color: bandColor[ov.current.band] }}>{bandLabel[ov.current.band] || ov.current.band}</div>
            {ov.current.blockedReason && <p>Reason: {ov.current.blockedReason}</p>}
            <p style={{ color: '#6b778c' }}>
              {ov.current.openFindings} open finding{ov.current.openFindings === 1 ? '' : 's'} · updated {ov.current.computedAt}
            </p>
          </div>
        )}
      </div>

      {ov && !ov.empty && !ov.error && (
        <div style={card}>
          <b>What holds the score down</b>
          {ov.rows.length === 0 && <p>Nothing. No open findings deduct points.</p>}
          {ov.rows.map((r, i) => (
            <div key={r.id} style={{ borderTop: '1px solid #ddd', padding: '8px 0' }}>
              <div>
                <b>{i + 1}. -{r.points}</b> · {sevLabel[r.severity]}{r.reason && r.reason !== 'confirmed' ? ` · ${r.reason}` : ''}
              </div>
              {r.restricted ? <RestrictedNote /> : (
                <div>
                  <div>{r.title}</div>
                  <div style={{ color: '#6b778c' }}>
                    Owner: {r.owner || 'unknown'} · open {r.ageText || 'unknown'}
                    {r.preview ? <span> · found <code>{r.preview}</code></span> : null}
                  </div>
                  {r.link && (
                    <a href="#" onClick={(e) => { e.preventDefault(); openLink(r.link, projectKey); }}>{linkText(r.link)}</a>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {ov && !ov.empty && !ov.error && ov.releases.length > 0 && (
        <div style={card}>
          <b>Releases</b>
          {ov.releases.map((v) => (
            <div key={v.id} style={{ borderTop: '1px solid #ddd', padding: '6px 0' }}>
              <b>{v.name}</b> · <span style={{ color: bandColor[v.band], fontWeight: 600 }}>{bandLabel[v.band] || v.band} {v.score}</span>
              {v.blockedReason ? ` · ${v.blockedReason}` : ''}{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); onOpenRelease(v.id); }}>Open gate</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectPage({ projectKey }) {
  const tabs = ['Overview', 'Decisions', 'Findings', 'Release gate'];
  const [tab, setTab] = useState('Overview');
  const [gateVersion, setGateVersion] = useState('');

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
        <OverviewTab projectKey={projectKey} onOpenRelease={(id) => { setGateVersion(id); setTab('Release gate'); }} />
      )}
      {tab === 'Decisions' && <DecisionsTab projectKey={projectKey} />}
      {tab === 'Findings' && <FindingsTab projectKey={projectKey} />}
      {tab === 'Release gate' && <GateTab projectKey={projectKey} initialVersionId={gateVersion} />}
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
      <RemediationCard projectKey={projectKey} />
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

function IssuePanel({ projectKey, issueId }) {
  const [flags, setFlags] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    invoke('getIssueFlags', { projectKey, issueId })
      .then((r) => (r && r.error ? setErr(r.error) : setFlags(r.flags)))
      .catch((e) => setErr(errText(e)));
  }, [projectKey, issueId]);

  if (err) return <p style={{ color: '#c9372c' }}>{err}</p>;
  if (!flags) return <p>Loading...</p>;
  if (!flags.length) return <p>No decision conflicts for this work item.</p>;
  return (
    <div>
      {flags.map((f) =>
        f.restricted ? (
          <div key={f.findingId} style={{ ...card, borderColor: '#e2b203' }}>
            This work item may conflict with a decision you do not have access to.
          </div>
        ) : (
          <div key={f.findingId} style={{ ...card, borderColor: '#e2b203' }}>
            <strong>May contradict: {f.title}</strong>
            <div style={{ color: '#555', fontSize: 13 }}>
              {f.decidedAt ? 'Decided ' + String(f.decidedAt).slice(0, 10) : 'Decided'}
              {f.scope ? ' · scope: ' + f.scope : ''}
            </div>
            <p style={{ margin: '8px 0' }}>{f.text}</p>
            <p style={{ margin: '8px 0' }}><strong>Why:</strong> {f.rationale || 'No rationale recorded.'}</p>
            <div style={{ color: '#555', fontSize: 13 }}>Matched words: {f.shared.join(', ')}</div>
            <a href="#" onClick={(e) => { e.preventDefault(); openPage(f.pageId); }}>Open decision: {f.pageTitle}</a>
          </div>
        )
      )}
    </div>
  );
}

function App() {
  const [ctx, setCtx] = useState(null);
  useEffect(() => { view.getContext().then(setCtx); }, []);
  if (!ctx) return <div style={{ padding: 16 }}>Loading...</div>;
  const ext = ctx.extension || {};
  const projectKey = ext.project ? ext.project.key : null;
  const isSettings = ctx.moduleKey === 'tracewise-settings-page';
  const isPanel = ctx.moduleKey === 'tracewise-issue-panel';
  return (
    <div style={{ padding: 16, fontFamily: 'sans-serif' }}>
      {isPanel
        ? <IssuePanel projectKey={projectKey} issueId={ext.issue ? ext.issue.id : null} />
        : isSettings
          ? <SettingsPage projectKey={projectKey} />
          : <ProjectPage projectKey={projectKey} />}
    </div>
  );
}

export default App;