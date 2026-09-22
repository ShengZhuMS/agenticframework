import { esc, attr, layout } from '../layout.js';
import { GUIDE } from '../../bff/services/guide.js';

export function guidePage(ctx, { answer, error, question = '', health = {} } = {}) {
  const topic = ctx.path.split('/').at(-1);
  const selected = GUIDE.find((item) => item.id === topic);
  return layout({ ...ctx, title: 'Help', section: 'help' }, `
    <h1 class="govuk-heading-xl">Your Cortex guide</h1>
    <p class="govuk-body-l">How to use it. How it works. What to do when something goes wrong.</p>
    <form method="post" action="/help">
      <label class="govuk-label govuk-label--s" for="guide-question">Ask about this platform</label>
      <p class="govuk-hint" id="guide-hint">Grounded in the guide below, not live logs. Do not include secrets or personal data. Uses the configured Foundry model.</p>
      <textarea class="govuk-textarea" id="guide-question" name="q" rows="2" required maxlength="4000" aria-describedby="guide-hint">${esc(question)}</textarea>
      <button class="govuk-button" type="submit">Ask the guide</button>
    </form>
    ${error ? `<p role="alert" class="govuk-error-message">${esc(error)} The written guide below remains available.</p>` : ''}
    ${answer ? `<section aria-labelledby="guide-answer"><h2 id="guide-answer" class="govuk-heading-m">Guide answer</h2>
      <p class="govuk-body" style="white-space:pre-wrap">${esc(answer.text)}</p>
      <p class="govuk-body-s">AI-generated guidance; verify before acting.</p>
      <ul class="govuk-list">${answer.sources.map((source) => `<li><a href="#guide-${attr(source.id)}">${esc(source.title)}</a></li>`).join('')}</ul></section>` : ''}
    <h2 class="govuk-heading-l">User guide</h2>
    ${GUIDE.map((item) => `<details class="govuk-details" id="guide-${attr(item.id)}" ${selected?.id === item.id ? 'open' : ''}>
      <summary class="govuk-details__summary">${esc(item.title)}</summary>
      <div class="govuk-details__text"><p class="govuk-body">${esc(item.text)}</p><a class="govuk-link" href="${attr(item.href)}">Open ${esc(item.title)}</a></div>
    </details>`).join('')}
    <details class="govuk-details"><summary>Service status</summary>
      <p class="govuk-hint">Backend reachability does not prove agent tool permissions or tenant installation.</p>
      <dl class="govuk-summary-list">${Object.entries(health).map(([name, status]) => `<div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">${esc(name)}</dt><dd class="govuk-summary-list__value">${status.ok ? 'Reachable' : 'Unavailable - ask the platform owner to inspect diagnostics'}</dd></div>`).join('')}</dl>
    </details>`);
}
