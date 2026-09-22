import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import index from '../index/store.js';
import { allAssessments, publicationVerdict } from './redteam.js';

const uiFiles = ['../../web/layout.js', '../../web/views/chat.js', '../../web/assets/chat-panel.js', '../../web/assets/cortex.css'];
export const UI_REVISION = createHash('sha256').update(uiFiles.map((file) => readFileSync(new URL(file, import.meta.url))).join('\n')).digest('hex').slice(0, 16);
export const MANUAL_CHECKS = [
  ['keyboard', 'Complete the build, chat and publish journeys using only the keyboard; verify logical focus order and no trap.'],
  ['focus', 'Verify visible, unobscured focus; chat Escape closes and restores focus to its launcher (WCAG 2.4.7, 2.4.11).'],
  ['reader', 'Use a screen reader to check headings, labels, error messages, status announcements and the chat dialog.'],
  ['reflow', 'Check 200% text resizing and 400% zoom / 320 CSS-pixel reflow without lost content or two-dimensional scrolling.'],
  ['contrast', 'Check text, controls and focus indicators in each deployed theme, including hover, disabled and error states.'],
  ['targets', 'Check pointer target size/spacing (2.5.8), no dragging-only interaction (2.5.7), and alternatives to gestures.'],
  ['auth', 'Check the actual Entra sign-in journey for accessible authentication (3.3.8), errors and redundant entry (3.3.7).']
];

export function evidenceFingerprint(entry) {
  const def = entry._agent?.definition || {};
  const sources = (def.knowledge || []).map((id) => index.get(id)).filter(Boolean).map((item) => ({
    id: item.id, sens: item.sens, limits: item.limits, allowedGroups: item.allowedGroups
  }));
  return createHash('sha256').update(JSON.stringify({ version: entry._agent?.version, def, sources })).digest('hex');
}

export function ensureResponsibleAI(entry) {
  const fingerprint = evidenceFingerprint(entry);
  if (entry._agent?.responsibleAI?.fingerprint === fingerprint) return entry._agent.responsibleAI;
  const def = entry._agent?.definition || {};
  const sources = (def.knowledge || []).map((id) => index.get(id)).filter(Boolean);
  const report = {
    fingerprint, version: String(entry._agent?.version || ''), createdAt: new Date().toISOString(),
    method: 'Automated configuration review, not a model-behaviour evaluation or legal certification.',
    jurisdiction: 'Not assessed', status: 'review-required',
    frameworks: [
      { title: 'Microsoft Responsible AI principles', url: 'https://www.microsoft.com/en-us/ai/principles-and-approach' },
      { title: 'NIST AI Risk Management Framework', url: 'https://www.nist.gov/itl/ai-risk-management-framework' }
    ],
    checks: [
      { principle: 'Accountability', nist: 'GOVERN', status: def.builtById ? 'pass' : 'review', finding: def.builtById ? 'An accountable builder is recorded.' : 'No accountable builder is recorded.', action: 'Assign business ownership and an escalation/incident process.' },
      { principle: 'Transparency', nist: 'MAP', status: def.instructions?.trim() ? 'pass' : 'review', finding: 'Instructions and attached knowledge define the declared purpose, not proof of behaviour.', action: 'Review purpose, limitations, audience and citation quality against sample answers.' },
      { principle: 'Privacy and security', nist: 'MAP / MANAGE', status: 'review', finding: `${sources.length} knowledge sources; ${sources.filter((source) => /Sensitive/i.test(source.sens || '')).length} labelled sensitive. Source labels alone do not establish privacy compliance.`, action: 'Review data minimisation, service-identity permissions, retention and audience. Perform a DPIA where applicable.' },
      { principle: 'Reliability and safety', nist: 'MEASURE', status: 'review', finding: 'Configuration alone cannot establish reliability or safety.', action: 'Inspect current-version red-team evidence, task accuracy, failure handling and tool side effects.' },
      { principle: 'Fairness', nist: 'MEASURE', status: 'review', finding: 'No representative fairness evaluation has been supplied.', action: 'Define affected groups and evaluate disparate error rates using representative, permitted data.' },
      { principle: 'Inclusiveness', nist: 'MANAGE', status: 'review', finding: 'Accessibility and user research need recorded evidence.', action: 'Run WCAG checks and the manual checklist, and include users with differing access needs.' }
    ]
  };
  index.upsert({ ...entry, _agent: { ...entry._agent, responsibleAI: report } });
  return report;
}

export function redTeamSummary(entry) {
  const candidates = allAssessments().filter((run) => run.agentId === entry.id &&
    String(run.target?.version) === String(entry._agent?.version) &&
    run.target?.name === (entry._source?.id || entry.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const run = candidates[0];
  if (!run) return { status: 'notStarted', label: 'Not run', reason: 'No assessment evidence for the current agent version.' };
  const verdict = publicationVerdict(run);
  if (verdict.passed) return { status: 'complete', label: 'Passed', reason: verdict.reason, run };
  if (run.error || ['failed', 'canceled', 'cancelled', 'submission-unknown'].includes(run.status)) {
    return { status: 'outstanding', label: 'Blocked', reason: run.error || `Assessment ${run.status}; no passing evidence.`, run };
  }
  if (run.status === 'completed') return { status: 'outstanding', label: 'Failed / incomplete evidence', reason: verdict.reason, run };
  return { status: 'inProgress', label: 'In progress', reason: `Foundry status: ${run.status}.`, run };
}

export function evidenceGates(entry, gates) {
  const rai = ensureResponsibleAI(entry);
  const redteam = redTeamSummary(entry);
  const audit = entry._agent?.accessibility;
  const current = audit?.uiRevision === UI_REVISION && audit?.fingerprint === evidenceFingerprint(entry);
  const automatic = current ? audit.automatic : null;
  const manual = current && MANUAL_CHECKS.every(([id]) => audit.manual?.[id] === true);
  const a11yPassed = automatic && automatic.violations.length === 0 && automatic.incomplete.length === 0 && manual;
  return gates.map((gate) => {
    if (!entry._agent?.definition && ['dpia', 'gateway', 'model', 'service'].includes(gate.id)) {
      return { ...gate, statusKey: 'notStarted', label: 'Not assessed', tone: 'orange', reason: 'This agent has no recorded Cortex build definition. Its source configuration and approval cannot be inferred from registration alone.', evidence: `/agent/${encodeURIComponent(entry.id)}/assurance` };
    }
    if (gate.id === 'rai') return { ...gate, statusKey: 'inProgress', label: 'Review required', tone: 'orange', reason: `${rai.checks.length} principle mappings generated automatically; human assessment remains required.`, evidence: `/agent/${encodeURIComponent(entry.id)}/assurance#rai` };
    if (gate.id === 'redteam') return { ...gate, statusKey: redteam.status, label: redteam.label, tone: redteam.status === 'complete' ? 'green' : 'orange', reason: redteam.reason, evidence: `/agent/${encodeURIComponent(entry.id)}/redteam` };
    if (gate.id === 'a11y') return { ...gate, statusKey: a11yPassed ? 'complete' : 'outstanding', label: a11yPassed ? 'Recorded checks passed' : automatic?.violations.length ? 'Issues found' : current ? 'Manual review required' : 'Not run / stale', tone: a11yPassed ? 'green' : 'orange', reason: 'Browser-reported axe checks and reviewer attestations cover selected checks, not a complete WCAG conformance certification.', evidence: `/agent/${encodeURIComponent(entry.id)}/assurance#a11y` };
    return gate;
  });
}

export function saveAccessibility(entry, user, data) {
  if (data.uiRevision !== UI_REVISION || data.fingerprint !== evidenceFingerprint(entry)) throw new Error('The agent or interface changed. Reload and run the checks again.');
  const existing = entry._agent?.accessibility;
  const report = existing?.uiRevision === UI_REVISION && existing?.fingerprint === data.fingerprint ? { ...existing } : { uiRevision: UI_REVISION, fingerprint: data.fingerprint };
  if (data.automatic) {
    const auto = data.automatic;
    if (typeof auto.version !== 'string' || !auto.version || !Array.isArray(auto.violations) || !Array.isArray(auto.incomplete) || !Number.isInteger(auto.passes) || auto.passes < 1 ||
        auto.violations.length > 200 || auto.incomplete.length > 200) throw new Error('Invalid or empty accessibility audit.');
    const trim = (item) => {
      if (!item || typeof item.id !== 'string' || typeof item.description !== 'string') throw new Error('Invalid accessibility finding.');
      return { id: item.id.slice(0, 100), description: item.description.slice(0, 1000), impact: String(item.impact || 'review').slice(0, 30), targets: Array.isArray(item.targets) ? item.targets.slice(0, 20).map((target) => String(target).slice(0, 300)) : [] };
    };
    report.automatic = { version: auto.version.slice(0, 40), violations: auto.violations.map(trim), incomplete: auto.incomplete.map(trim), passes: auto.passes, scope: 'Agent chat page, as rendered in the reporting browser', at: new Date().toISOString(), reportedBy: user.id };
  } else {
    report.manual = Object.fromEntries(MANUAL_CHECKS.map(([id]) => [id, data[id] === 'yes']));
    report.manualReviewer = user.name;
    report.manualAt = new Date().toISOString();
    report.notes = String(data.notes || '').slice(0, 4000);
  }
  index.upsert({ ...entry, _agent: { ...entry._agent, accessibility: report } });
  return report;
}
