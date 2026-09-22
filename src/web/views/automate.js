/**
 * Automate a task — recurring drafts with a person at the checkpoint.
 *
 * Three screens: the list, the set-up form, and one automation with its run
 * history. Every automation shows its four sentences — what it writes, who is
 * accountable, what stops it, how it is undone — before anything else,
 * because those are the questions an assurance reviewer asks first.
 */

import { esc, attr, layout } from '../layout.js';
import { CADENCES, DAYS, MAX_STEPS } from '../../bff/services/automations.js';

const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC' : '—');

function cadenceText(a) {
  const base = CADENCES[a.cadence]?.label || a.cadence;
  if (a.cadence === 'weekly') return `${base}, ${DAYS[a.dayOfWeek] || 'Monday'} at ${a.at} UTC`;
  if (a.cadence === 'daily' || a.cadence === 'weekdays') return `${base} at ${a.at} UTC`;
  return base;
}

function statusTag(a) {
  return a.status === 'paused'
    ? '<strong class="govuk-tag govuk-tag--grey">Paused</strong>'
    : '<strong class="govuk-tag govuk-tag--green">Active</strong>';
}

function errorSummary(errors) {
  if (!errors?.length) return '';
  return `<div class="govuk-error-summary" data-module="govuk-error-summary">
    <div role="alert">
      <h2 class="govuk-error-summary__title">There is a problem</h2>
      <div class="govuk-error-summary__body"><ul class="govuk-list govuk-error-summary__list">
        ${errors.map((e) => `<li><a href="#${attr(e.field)}">${esc(e.message)}</a></li>`).join('')}
      </ul></div>
    </div>
  </div>`;
}

export function automationsPage(ctx, { mine, all, created }) {
  const rows = (list) =>
    list.length
      ? `<table class="govuk-table">
          <thead class="govuk-table__head"><tr class="govuk-table__row">
            <th class="govuk-table__header">Automation</th><th class="govuk-table__header">Runs</th>
            <th class="govuk-table__header">Next run</th><th class="govuk-table__header">Accountable</th><th class="govuk-table__header">Status</th>
          </tr></thead>
          <tbody class="govuk-table__body">
            ${list
              .map(
                (a) => `<tr class="govuk-table__row">
                  <td class="govuk-table__cell"><a class="govuk-link" href="/automate/${attr(a.id)}">${esc(a.name)}</a>
                    <span class="cortex-src">${esc(a.kind === 'workflow' ? `${a.steps.length} ordered agent steps` : a.kind === 'agent' ? `asks ${a.agentName}` : 'approved method')} · ${esc(cadenceText(a))}</span></td>
                  <td class="govuk-table__cell">${a.runs.length}${a.runs[0]?.status === 'failed' ? ' <strong class="govuk-tag govuk-tag--red">last failed</strong>' : ''}</td>
                  <td class="govuk-table__cell">${a.status === 'active' ? esc(fmt(a.nextRunAt)) : '—'}</td>
                  <td class="govuk-table__cell">${esc(a.owner?.name || '—')}</td>
                  <td class="govuk-table__cell">${statusTag(a)}</td>
                </tr>`
              )
              .join('')}
          </tbody></table>`
      : '<p class="govuk-body">None yet.</p>';

  const others = all.filter((a) => !mine.some((m) => m.id === a.id));
  const content = `
${
  created
    ? `<div class="govuk-notification-banner govuk-notification-banner--success" role="alert" aria-labelledby="au-t">
        <div class="govuk-notification-banner__header"><p class="govuk-notification-banner__title" id="au-t">Automation set up</p></div>
        <div class="govuk-notification-banner__content"><p class="govuk-body govuk-!-margin-bottom-0"><a class="govuk-link" href="/automate/${attr(created)}">${esc(created)}</a> is active and will run at its next scheduled time. You can run it now from its page.</p></div>
      </div>`
    : ''
}
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-2">Automate a task</h1>
    <p class="govuk-body-l">Automations that draft, with a person at the checkpoint.</p>
    <div class="govuk-inset-text">
      <p class="govuk-body govuk-!-margin-bottom-0">Compose an ordered workflow of two to five agents. Each receives the previous agent's result; the final result stays a <strong>draft for human review</strong>. Use read-only agents and tools. Existing single-agent and approved-method schedules remain available in their histories.</p>
    </div>
    <a class="govuk-button" href="/automate/new" role="button">Set up an automation</a>

    <h2 class="govuk-heading-m">Yours</h2>
    ${rows(mine)}
    ${others.length ? `<h2 class="govuk-heading-m">Everyone else\u2019s</h2>${rows(others)}` : ''}
  </div>
  <div class="govuk-grid-column-one-third">
    <div class="cortex-filters">
      <h2 class="govuk-heading-m">How it works</h2>
      <ol class="govuk-list govuk-list--number govuk-list--spaced govuk-!-margin-bottom-0">
        <li>Choose multiple agents and instructions for each step, in order.</li>
        <li>Choose how often. Name the accountable owner — that is you.</li>
        <li>Each run drafts an answer, with its sources and the tools it used, into the run history.</li>
        <li>A person reads it. Pause or delete at any time.</li>
      </ol>
    </div>
  </div>
</div>`;
  return layout({ ...ctx, title: 'Automate a task', section: 'automate' }, content);
}

export function automationFormPage(ctx, { agents, methods, form = {}, errors = [] }) {
  const f = form;
  const kind = 'workflow';
  const err = (field) => errors.find((e) => e.field === field);
  const group = (field) => `govuk-form-group${err(field) ? ' govuk-form-group--error' : ''}`;
  const msg = (field) => (err(field) ? `<p class="govuk-error-message"><span class="govuk-visually-hidden">Error:</span> ${esc(err(field).message)}</p>` : '');

  const content = `
<div class="govuk-grid-row"><div class="govuk-grid-column-two-thirds">
  <a class="govuk-back-link" href="/automate">Back</a>
  <h1 class="govuk-heading-l">Set up an automation</h1>
  ${errorSummary(errors)}
  <form method="post" action="/automate/new">
    <div class="${group('name')}">
      <label class="govuk-label govuk-label--s" for="name">What is it called?</label>
      <div class="govuk-hint">For example: "Weekly operational insights and review".</div>
      ${msg('name')}
      <input class="govuk-input" id="name" name="name" type="text" value="${attr(f.name || '')}">
    </div>

    <input type="hidden" name="kind" value="${kind}">
    <p class="govuk-body">Steps run in order and stop on the first failure. Choose at least two different agents. Leave unused trailing steps blank.</p>
    ${Array.from({ length: MAX_STEPS }, (_, n) => {
      const i = n + 1;
      return `<fieldset class="govuk-fieldset">
        <legend class="govuk-fieldset__legend govuk-fieldset__legend--s">Step ${i}${i > 2 ? ' (optional)' : ''}</legend>
        <div class="${group(`stepAgent${i}`)}">
          <label class="govuk-label" for="stepAgent${i}">Agent</label>${msg(`stepAgent${i}`)}
          <select class="govuk-select" id="stepAgent${i}" name="stepAgent${i}">
            <option value="">Choose an agent</option>
            ${agents.map((a) => `<option value="${attr(a.id)}" ${(f[`stepAgent${i}`] || (i === 1 ? f.agentId : '')) === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
          </select>
        </div>
        <div class="${group(`stepInstruction${i}`)}">
          <label class="govuk-label" for="stepInstruction${i}">Instructions for this step</label>${msg(`stepInstruction${i}`)}
          <textarea class="govuk-textarea" id="stepInstruction${i}" name="stepInstruction${i}" rows="2" maxlength="4000">${esc(f[`stepInstruction${i}`] || '')}</textarea>
        </div>
      </fieldset>`;
    }).join('')}

    <div class="${group('question')}">
      <label class="govuk-label govuk-label--s" for="question">The overall task</label>
      <div class="govuk-hint">Written once, asked every run. Be specific about the period: "in the last 7 days".</div>
      ${msg('question')}
      <textarea class="govuk-textarea" id="question" name="question" rows="3">${esc(f.question || '')}</textarea>
    </div>

    ${
      kind === 'method' && methods.length
        ? `<div class="${group('methodId')}">
      <label class="govuk-label govuk-label--s" for="methodId">Which approved method?</label>
      <div class="govuk-hint">Only if you chose an approved method above. These were approved by a data holder when they released an answer.</div>
      ${msg('methodId')}
      <select class="govuk-select" id="methodId" name="methodId">
        <option value="">Choose a method</option>
        ${methods.map((m) => `<option value="${attr(m.id)}" ${f.methodId === m.id ? 'selected' : ''}>${esc(m.id)} — ${esc(m.question.slice(0, 80))} (approved by ${esc(m.owner)})</option>`).join('')}
      </select>
    </div>`
        : ''
    }

    <div class="${group('cadence')}">
      <fieldset class="govuk-fieldset">
        <legend class="govuk-fieldset__legend govuk-fieldset__legend--s">How often?</legend>
        ${msg('cadence')}
        <div class="govuk-radios govuk-radios--small">
          ${Object.entries(CADENCES)
            .map(
              ([k, c]) => `<div class="govuk-radios__item">
                <input class="govuk-radios__input" id="cad-${attr(k)}" name="cadence" type="radio" value="${attr(k)}" ${(f.cadence || 'daily') === k ? 'checked' : ''}>
                <label class="govuk-label govuk-radios__label" for="cad-${attr(k)}">${esc(c.label)} <span class="cortex-src">${esc(c.hint)}</span></label>
              </div>`
            )
            .join('')}
        </div>
      </fieldset>
    </div>

    <div class="govuk-grid-row">
      <div class="govuk-grid-column-one-half">
        <div class="${group('at')}">
          <label class="govuk-label govuk-label--s" for="at">At what time? (UTC)</label>
          ${msg('at')}
          <input class="govuk-input govuk-input--width-5" id="at" name="at" type="text" value="${attr(f.at || '07:00')}" inputmode="numeric">
        </div>
      </div>
      <div class="govuk-grid-column-one-half">
        <div class="govuk-form-group">
          <label class="govuk-label govuk-label--s" for="dayOfWeek">On which day? (weekly only)</label>
          <select class="govuk-select" id="dayOfWeek" name="dayOfWeek">
            ${DAYS.map((d, i) => `<option value="${i}" ${Number(f.dayOfWeek ?? 1) === i ? 'selected' : ''}>${esc(d)}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>

    <div class="${group('purpose')}">
      <label class="govuk-label govuk-label--s" for="purpose">What are the drafts for?</label>
      <div class="govuk-hint">One sentence. It is shown on every run so a reader knows why it exists.</div>
      ${msg('purpose')}
      <input class="govuk-input" id="purpose" name="purpose" type="text" value="${attr(f.purpose || '')}">
    </div>

    <div class="govuk-inset-text">
      <p class="govuk-body govuk-!-margin-bottom-1"><strong>Accountable owner:</strong> ${esc(ctx.user.name)}${ctx.user.email ? ` (${esc(ctx.user.email)})` : ''}</p>
      <p class="govuk-body govuk-!-margin-bottom-0"><strong>What it writes:</strong> nothing. Drafts land on the automation\u2019s page and stop there.</p>
      <p class="govuk-body">Scheduled runs use your captured permissions, not a fresh Entra token. Pause schedules when access changes. Keep agents read-only; Cortex does not sandbox external tool implementations.</p>
    </div>

    <button class="govuk-button" type="submit">Set it up</button>
  </form>
</div></div>`;
  return layout({ ...ctx, title: 'Set up an automation', section: 'automate' }, content);
}

function runBlock(a, r) {
  const t = r.at;
  return `<div class="cortex-run${r.status === 'failed' ? ' cortex-run--failed' : ''}" id="run-${attr(t)}">
    <p class="govuk-body-s govuk-!-margin-bottom-1"><strong>${esc(fmt(t))}</strong> · ${esc(Math.round((r.ms || 0) / 100) / 10)}s
      ${r.status === 'failed' ? '<strong class="govuk-tag govuk-tag--red">Failed</strong>' : '<strong class="govuk-tag govuk-tag--blue">Draft</strong>'}
      ${r.engine ? `<span class="cortex-src">via ${esc(r.engine)}</span>` : ''}</p>
    ${
      r.status === 'failed'
        ? `<p class="govuk-body govuk-!-margin-bottom-1"><strong>${esc(r.error?.heading)}</strong></p><p class="govuk-body-s">${esc(r.error?.message)}</p>
           <details class="govuk-details govuk-!-margin-bottom-1"><summary class="govuk-details__summary"><span class="govuk-details__summary-text">Technical detail</span></summary><div class="govuk-details__text"><code style="font-size:13px;word-break:break-all">${esc(r.error?.detail)}</code></div></details>`
        : `<p class="govuk-body" style="white-space:pre-wrap">${esc(r.draft || '(the agent returned no text)')}</p>
           ${r.sources?.length ? `<p class="govuk-body-s govuk-!-margin-bottom-1"><strong>Sources:</strong> ${r.sources.map((s) => (s.url ? `<a class="govuk-link" href="${attr(s.url)}">${esc(s.name)}</a>` : esc(s.name))).join(', ')}</p>` : ''}
           ${r.couldNotReach?.length ? `<p class="govuk-body-s" style="color:#d4351c"><strong>Could not reach:</strong> ${r.couldNotReach.map(esc).join('; ')}</p>` : ''}
           ${
             r.toolCalls?.filter((c) => c.kind !== 'list').length
               ? `<p class="govuk-body-s govuk-!-margin-bottom-1"><strong>Tools used:</strong> ${r.toolCalls
                   .filter((c) => c.kind !== 'list')
                   .map((c) => `${esc(c.server)}${c.tool ? ' › ' + esc(c.tool) : ''}`)
                   .join(', ')}</p>`
               : ''
           }`
    }
    ${r.steps?.length ? `<h3 class="govuk-heading-s">Step results</h3><ol class="govuk-list govuk-list--number">${r.steps.map((s) => `<li><strong>${esc(s.agentName)}: ${esc(s.status)}</strong>
      ${s.error ? `<p class="govuk-error-message">${esc(s.error.message)}</p>` : ''}
      <p style="white-space:pre-wrap">${esc(s.draft || '')}</p>
      ${s.truncated ? '<p class="govuk-hint">Stored output truncated at the handoff limit; this step failed.</p>' : ''}
      <details><summary>Sources and tool evidence</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify({ sources: s.sources || [], toolCalls: s.toolCalls || [] }, null, 2))}</pre></details></li>`).join('')}</ol>` : ''}
    <form method="post" action="/automate/${attr(a.id)}/runs/delete" style="margin:6px 0 0">
      <input type="hidden" name="at" value="${attr(t)}">
      <button class="govuk-link" style="border:0;background:none;cursor:pointer;padding:0;font-size:16px" type="submit">Delete this draft</button>
    </form>
  </div>`;
}

export function automationPage(ctx, { automation: a, ran, isOwner }) {
  const content = `
<a class="govuk-back-link" href="/automate">All automations</a>
${
  ran
    ? `<div class="govuk-notification-banner govuk-notification-banner--success" role="alert" aria-labelledby="ran-t">
        <div class="govuk-notification-banner__header"><p class="govuk-notification-banner__title" id="ran-t">Ran just now</p></div>
        <div class="govuk-notification-banner__content"><p class="govuk-body govuk-!-margin-bottom-0">The newest draft is at the top of the run history.</p></div>
      </div>`
    : ''
}
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <span class="govuk-caption-l">${esc(a.id)} · ${statusTag(a)}</span>
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-2">${esc(a.name)}</h1>
    <p class="govuk-body-l">${esc(a.purpose)}</p>

    <div class="cortex-four">
      <div><strong>What it does</strong>${
        a.kind === 'workflow' ? `Runs ${a.steps.map((s) => esc(s.agentName)).join(' → ')}: ${esc(a.question)}` : a.kind === 'agent'
          ? `Asks <a class="govuk-link" href="/agent/${attr(a.agentId)}">${esc(a.agentName)}</a>: \u201c${esc(a.question)}\u201d`
          : `Re-runs approved method ${esc(a.methodId)}: \u201c${esc(a.question)}\u201d`
      } — ${esc(cadenceText(a))}.</div>
      <div><strong>Who is accountable</strong>${esc(a.owner?.name || '—')}${a.owner?.team ? `, ${esc(a.owner.team)}` : ''}</div>
      <div><strong>What it writes</strong>${esc(a.writes)}</div>
      <div><strong>What stops it · how it is undone</strong>${esc(a.stops)} ${esc(a.undo)}</div>
    </div>

    <h2 class="govuk-heading-m">Run history <span class="cortex-src">${a.runs.length} kept, newest first</span></h2>
    ${a.runs.length ? a.runs.map((r) => runBlock(a, r)).join('') : '<p class="govuk-body">No runs yet. The first is due at ' + esc(fmt(a.nextRunAt)) + '. Or run it now.</p>'}
  </div>

  <div class="govuk-grid-column-one-third">
    <div class="cortex-filters">
      <h2 class="govuk-heading-m">Controls</h2>
      <dl class="govuk-summary-list govuk-summary-list--no-border govuk-!-margin-bottom-2">
        <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Next run</dt><dd class="govuk-summary-list__value">${a.status === 'active' ? esc(fmt(a.nextRunAt)) : 'Paused'}</dd></div>
        <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Last run</dt><dd class="govuk-summary-list__value">${esc(fmt(a.lastRunAt))}</dd></div>
        <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Set up</dt><dd class="govuk-summary-list__value">${esc(fmt(a.createdAt))}</dd></div>
      </dl>
      <form method="post" action="/automate/${attr(a.id)}/run"><button class="govuk-button govuk-!-margin-bottom-2" type="submit">Run it now</button></form>
      ${
        a.status === 'active'
          ? `<form method="post" action="/automate/${attr(a.id)}/pause"><button class="govuk-button govuk-button--secondary govuk-!-margin-bottom-2" type="submit">Pause</button></form>`
          : `<form method="post" action="/automate/${attr(a.id)}/resume"><button class="govuk-button govuk-button--secondary govuk-!-margin-bottom-2" type="submit">Resume</button></form>`
      }
      <form method="post" action="/automate/${attr(a.id)}/delete"><button class="govuk-button govuk-button--warning govuk-!-margin-bottom-0" type="submit">Delete</button></form>
      ${isOwner ? '' : '<p class="govuk-body-s" style="margin-top:10px">You are not the accountable owner. Controls are shown in this phase; ownership rules come with the next.</p>'}
    </div>
  </div>
</div>`;
  return layout({ ...ctx, title: a.name, section: 'automate' }, content);
}
