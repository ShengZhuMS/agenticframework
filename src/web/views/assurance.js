import { esc, attr, layout } from '../layout.js';
import { MANUAL_CHECKS, UI_REVISION, evidenceFingerprint } from '../../bff/services/evidence.js';

export function evidencePage(ctx, { entry, report }) {
  const audit = entry._agent?.accessibility;
  const fingerprint = evidenceFingerprint(entry);
  const current = audit?.fingerprint === fingerprint && audit?.uiRevision === UI_REVISION;
  return layout({ ...ctx, title: 'Agent assurance evidence', section: 'build' }, `
    <a class="govuk-back-link" href="/agent/${attr(entry.id)}">Back to agent</a>
    <h1 class="govuk-heading-xl">Agent assurance evidence</h1>
    <p class="govuk-body-l">${esc(entry.name)} / version ${esc(entry._agent?.version)}</p>
    <section id="rai"><h2 class="govuk-heading-l">Responsible AI review</h2>
      <p class="govuk-body">${esc(report.method)} Generated ${esc(report.createdAt)}. Jurisdiction-specific obligations: ${esc(report.jurisdiction)}.</p>
      <p class="govuk-body">${report.frameworks.map((item) => `<a href="${attr(item.url)}">${esc(item.title)}</a>`).join(' | ')}</p>
      <table class="govuk-table"><thead><tr><th scope="col">Principle / NIST function</th><th scope="col">Configuration evidence</th><th scope="col">Required human review</th></tr></thead><tbody>
        ${report.checks.map((check) => `<tr><th scope="row">${esc(check.principle)}<br>${esc(check.nist)}</th><td>${esc(check.status === 'pass' ? 'Configuration check passed' : 'Review required')}: ${esc(check.finding)}</td><td>${esc(check.action)}</td></tr>`).join('')}
      </tbody></table></section>
    <section id="a11y"><h2 class="govuk-heading-l">Accessibility: WCAG 2.2 AA</h2>
      <p class="govuk-body">Run axe-core in your browser on this agent's chat page. It checks selected WCAG 2.0, 2.1 and 2.2 A/AA rules. Results are browser-reported evidence, not an independent certification or a full-platform assessment.</p>
      <a class="govuk-button" href="/agent/${attr(entry.id)}/chat?audit=1">Open chat accessibility checks</a>
      ${audit ? `<p class="govuk-body">${current ? 'Current' : 'STALE - rerun after changes'} evidence. ${audit.automatic ? `${audit.automatic.violations.length} violations; ${audit.automatic.incomplete.length} checks need review; ${audit.automatic.passes} automated rules passed.` : 'Automated checks not run.'}</p>
      ${(audit.automatic?.violations || []).concat(audit.automatic?.incomplete || []).map((item) => `<p class="govuk-body"><strong>${esc(item.id)}</strong>: ${esc(item.description)}<br>${item.targets.map(esc).join(', ')}</p>`).join('')}` : '<p class="govuk-body">No accessibility evidence yet.</p>'}
      <form method="post" action="/agent/${attr(entry.id)}/assurance">
        <input type="hidden" name="fingerprint" value="${attr(fingerprint)}"><input type="hidden" name="uiRevision" value="${UI_REVISION}">
        <fieldset class="govuk-fieldset"><legend class="govuk-fieldset__legend govuk-fieldset__legend--m">Record only checks you actually performed</legend>
          ${MANUAL_CHECKS.map(([id, text]) => `<p><label class="govuk-label"><input type="checkbox" name="${id}" value="yes" ${current && audit?.manual?.[id] ? 'checked' : ''}> ${esc(text)}</label></p>`).join('')}
        </fieldset>
        <label class="govuk-label" for="review-notes">Reviewer notes: browser, assistive technology, pages, findings and evidence references</label>
        <textarea class="govuk-textarea" id="review-notes" name="notes" maxlength="4000" rows="3">${esc(current ? audit?.notes || '' : '')}</textarea>
        <button class="govuk-button" type="submit">Save reviewer evidence</button>
      </form>
    </section>`);
}
