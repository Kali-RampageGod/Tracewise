// Secret finding lifecycle rules. Pure: no Forge, no database.

export const DISMISS_CODES = ['false_positive', 'test_data', 'accepted_risk'];
export const ACTIONS = ['confirm_rotation', 'dismiss', 'allow_value', 'allow_source'];

// Checks a user action before anything is written. Returns { ok, error, reason, code }.
export function validateAction({ action, reason, code }) {
  if (!ACTIONS.includes(action)) return { ok: false, error: 'Unknown action' };
  const text = String(reason || '').trim();
  if (text.length < 3) return { ok: false, error: 'A reason of at least 3 characters is required' };
  if (text.length > 400) return { ok: false, error: 'The reason is too long (400 characters at most)' };
  if (action === 'dismiss' && !DISMISS_CODES.includes(code)) return { ok: false, error: 'Choose why this is dismissed' };
  return { ok: true, reason: text, code: action === 'dismiss' ? code : null };
}

// Status after an action. Only an open finding can be acted on.
export function nextStatus(current, action) {
  if (current !== 'open') return { error: `This finding is already ${current}` };
  if (action === 'confirm_rotation') return { status: 'resolved', eventType: 'rotation_confirmed' };
  if (action === 'dismiss') return { status: 'dismissed', eventType: 'dismissed' };
  if (action === 'allow_value' || action === 'allow_source') return { status: 'dismissed', eventType: 'allowlisted' };
  return { error: 'Unknown action' };
}

// ---- Remediation issue ----
export const remediationLabel = (findingId) => 'tw-' + String(findingId).toLowerCase();

const text = (t) => ({ type: 'text', text: t });
const para = (...content) => ({ type: 'paragraph', content });
const item = (t) => ({ type: 'listItem', content: [para(text(t))] });

// The Jira issue that asks someone to rotate an exposed secret.
// Only the redacted preview is used; the secret itself never reaches this function.
// finding: { id, preview, detail: { detector, pageId, pageTitle, issueKey, ownerAccountId, foundInVersion } }
export function buildRemediationIssue({ finding, baseUrl }) {
  const d = finding.detail || {};
  const detector = d.detector || 'secret';
  const where = d.pageId ? `the Confluence page "${d.pageTitle || d.pageId}"` : `work item ${d.issueKey || ''}`.trim();
  const summary = `Rotate exposed ${detector} found in ${d.pageId ? 'page "' + (d.pageTitle || d.pageId) + '"' : d.issueKey || 'a work item'}`.slice(0, 250);

  const intro = [text(`Tracewise found a possible ${detector} (${finding.preview || 'redacted'}) in ${where}`)];
  if (d.foundInVersion) intro.push(text(` (page version ${d.foundInVersion}, only in the page history)`));
  intro.push(text('. Tracewise does not store the secret itself.'));

  const content = [para(...intro)];
  if (d.ownerAccountId) {
    content.push(para({ type: 'mention', attrs: { id: d.ownerAccountId, text: '@owner' } }, text(' you own this content. Please rotate or revoke the credential.')));
  }
  if (baseUrl && d.pageId) {
    const url = `${baseUrl}/wiki/pages/viewpage.action?pageId=${d.pageId}`;
    content.push(para(text('Page: '), { type: 'text', text: d.pageTitle || url, marks: [{ type: 'link', attrs: { href: url } }] }));
  }
  content.push({
    type: 'bulletList',
    content: [
      item('Revoke or rotate the credential at the service that issued it.'),
      item('Remove it from the page or work item. Old versions keep it, so rotation is what protects you.'),
      item('Open Tracewise, Findings, and choose "Confirm rotated" so the release gate clears it.'),
    ],
  });
  return { summary, description: { type: 'doc', version: 1, content }, label: remediationLabel(finding.id) };
}

// What the remediation worker should do next, from the stored claim.
//  done:   an issue key is already saved
//  create: nobody has claimed it yet
//  wait:   another attempt claimed it a moment ago and may still be creating the issue
//  search: a claim is old; the issue may exist without its key saved, so look it up first
export const CLAIM_STALE_MS = 2 * 60 * 1000;
export function claimState({ issueKey, claimedAtMs, nowMs }) {
  if (issueKey) return 'done';
  if (claimedAtMs == null) return 'create';
  return nowMs - claimedAtMs < CLAIM_STALE_MS ? 'wait' : 'search';
}
