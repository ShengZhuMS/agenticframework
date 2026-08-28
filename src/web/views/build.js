/**
 * Build an agent.
 *
 * CAP-131  Assemble an agent from approved parts
 * CAP-132  Choose a model from the approved catalogue
 * CAP-133  Write instructions
 * CAP-134  Be told to search the marketplace before building
 * CAP-135  Attach only knowledge I can already see
 * CAP-136  Tick what the agent may do, and see what is not available this phase
 * CAP-137  See which assurance gates apply and why
 * CAP-138  See where the evidence for a gate is, and open it
 */

import { esc, attr, visMark, layout } from '../layout.js';
import { VIS } from '../../bff/services/visibility.js';
import { ACTIONS } from '../../bff/services/assurance.js';

function errorSummary(errors) {
  if (!errors?.length) return '';
  return `<div class="govuk-error-summary" role="alert" tabindex="-1">
    <h2 class="govuk-error-summary__title">There is a problem</h2>
    <ul class="govuk-list">
      ${errors
        .map((e) => `<li><a class="govuk-link" href="#${attr(e.field)}">${esc(e.message)}</a></li>`)
        .join('')}
    </ul>
  </div>`;
}

/** The gate table. Reasons matter more than statuses. */
export function gateTable(gates, { caption } = {}) {
  return `<table class="govuk-table">
    ${caption ? `<caption class="govuk-table__caption">${esc(caption)}</caption>` : ''}
    <thead>
      <tr>
        <th scope="col" class="govuk-table__header">Gate</th>
        <th scope="col" class="govuk-table__header">Status</th>
        <th scope="col" class="govuk-table__header">Why it applies to this agent</th>
        <th scope="col" class="govuk-table__header">Evidence</th>
      </tr>
    </thead>
    <tbody>
      ${gates
        .map(
          (g) => `<tr class="govuk-table__row">
            <td class="govuk-table__cell"><strong>${esc(g.name)}</strong></td>
            <td class="govuk-table__cell">
              <strong class="govuk-tag govuk-tag--${attr(g.tone)}">${esc(g.label)}</strong>
            </td>
            <td class="govuk-table__cell">${esc(g.reason)}</td>
            <td class="govuk-table__cell">
              ${
                g.evidence
                  ? `<a class="govuk-link" href="${attr(g.evidence)}">Open</a>`
                  : '<span aria-hidden="true">—</span><span class="govuk-skip-link">No evidence needed</span>'
              }
            </td>
          </tr>`
        )
        .join('')}
    </tbody>
  </table>`;
}

/* --------------------------------------------------------------- landing */

export function buildLandingPage(ctx, { agentCount, myAgents }) {
  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-0">Build an agent</h1>
    <p class="govuk-body-l">
      Assemble an assistant from parts that are already approved. You do not write code.
    </p>
    <a class="govuk-button" href="/build/new" role="button">Start building</a>

    ${
      myAgents.length
        ? `<h2 class="govuk-heading-m">Agents you have built</h2>
           <dl class="govuk-summary-list">
             ${myAgents
               .map(
                 (a) => `<div class="govuk-summary-list__row">
                   <dt class="govuk-summary-list__key">
                     <a class="govuk-link" href="/agent/${attr(a.id)}">${esc(a.name)}</a>
                   </dt>
                   <dd class="govuk-summary-list__value">
                     ${
                       a._agent?.published
                         ? '<strong class="govuk-tag govuk-tag--green">Published</strong>'
                         : '<strong class="govuk-tag govuk-tag--grey">Not shared</strong>'
                     }
                   </dd>
                 </div>`
               )
               .join('')}
           </dl>`
        : ''
    }
  </div>

  <div class="govuk-grid-column-one-third">
    <div class="cortex-filters">
      <h2 class="govuk-heading-m">Search before you build</h2>
      <p class="govuk-body">
        <strong>${esc(agentCount)}</strong> agents are registered here.
      </p>
      <p class="govuk-body-s">
        Search before you build. An agent that already exists has already been
        through its assurance gates; yours has not.
      </p>
      <a class="govuk-button govuk-button--secondary" href="/marketplace?cat=Agent" role="button">
        Search agents first
      </a>

    </div>
  </div>
</div>`;
  return layout({ ...ctx, title: 'Build an agent', section: 'build' }, content);
}

/* ------------------------------------------------------------ build form */

export function buildFormPage(ctx, { models, knowledge, tools, form = {}, errors = [], gates }) {
  const sel = (k) => [].concat(form[k] || []).map(String);
  const selKnowledge = sel('knowledge');
  const selTools = sel('tools');
  const selActions = form.actions ? sel('actions') : ACTIONS.filter((a) => a.default).map((a) => a.id);

  const knowledgeItem = (e) => {
    const id = `k-${e.id}`;
    const checked = selKnowledge.includes(e.id);
    return `<div class="govuk-checkboxes__item">
      <input class="govuk-checkboxes__input" id="${attr(id)}" name="knowledge" type="checkbox"
             value="${attr(e.id)}"${checked ? ' checked' : ''}${e.attachable ? '' : ' disabled'}>
      <label class="govuk-checkboxes__label" for="${attr(id)}">
        ${esc(e.name)}
        <span class="cortex-src">
          ${esc(e.cat)} · ${esc(ctx.clusterName(e.cluster))} · ${esc(e.owner)} · ${esc(e.fresh)}
        </span>
        ${
          e.attachable
            ? ''
            : `<span class="cortex-src"><strong>${esc(VIS[e.vis]?.label || '')}</strong> — ${esc(e.reason)}
                 ${
                   e.vis === 'request'
                     ? `<br><a class="govuk-link" href="/entry/${attr(e.id)}">Request access to it</a>`
                     : ''
                 }
               </span>`
        }
      </label>
    </div>`;
  };

  const available = knowledge.filter((e) => e.attachable);
  const unavailable = knowledge.filter((e) => !e.attachable);

  const content = `
${errorSummary(errors)}

<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-0">Build an agent</h1>
    <p class="govuk-body-l">Five things. Nothing is shared until you share it.</p>
  </div>
</div>

<form method="post" action="/build/create">
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">

    <h2 class="govuk-heading-m">1. Name it</h2>
    <div class="govuk-form-group">
      <label class="govuk-label" for="name">What does it do?</label>
      <div class="govuk-hint">Say what it does, not what it is called internally.</div>
      <input class="govuk-input" id="name" name="name" type="text"
             value="${attr(form.name || '')}" placeholder="Waste carrier compliance assistant">
    </div>

    <h2 class="govuk-heading-m">2. Choose a model</h2>
    <div class="govuk-form-group">
      <fieldset class="govuk-fieldset">
        <legend class="govuk-fieldset__legend">From the approved catalogue</legend>
        <div class="govuk-radios">
          ${models
            .map(
              (m) => `<div class="govuk-radios__item">
                <input class="govuk-radios__input" id="m-${attr(m.id)}" name="model" type="radio"
                       value="${attr(m.id)}"${(form.model || models[0].id) === m.id ? ' checked' : ''}>
                <label class="govuk-radios__label" for="m-${attr(m.id)}">
                  ${esc(m.name)}
                  ${m.approved ? '' : ' <strong class="govuk-tag govuk-tag--orange">Needs review</strong>'}
                  <span class="cortex-src">${esc(m.note)}</span>
                </label>
              </div>`
            )
            .join('')}
        </div>
      </fieldset>
    </div>

    <h2 class="govuk-heading-m">3. Write instructions</h2>
    <div class="govuk-form-group">
      <label class="govuk-label" for="instructions">How should it behave?</label>
      <div class="govuk-hint">
        Good instructions say: name your sources and their freshness, say what you
        could not reach, and do not guess. Cortex appends those house rules anyway,
        and shows you what it added.
      </div>
      <textarea class="govuk-textarea" id="instructions" name="instructions" rows="6"
        placeholder="Answer questions about waste carrier registrations and permit history. Cross-reference registrations against permit conditions. Flag where a registration has lapsed.">${esc(form.instructions || '')}</textarea>
    </div>

    <h2 class="govuk-heading-m">4. Attach knowledge</h2>
    <div class="govuk-inset-text">
      <p class="govuk-body govuk-!-margin-bottom-0">
        <strong>An agent can never reach further than you can.</strong>
        Everything relevant is listed below. Anything you cannot see yourself is
        shown greyed out, with the reason — so you know it exists and why it is
        not available to you.
      </p>
    </div>

    <div class="govuk-form-group" id="knowledge">
      <fieldset class="govuk-fieldset">
        <legend class="govuk-fieldset__legend"><strong>Available to you (${esc(available.length)})</strong></legend>
        <div class="govuk-checkboxes govuk-checkboxes--small">
          ${available.map(knowledgeItem).join('') || '<p class="govuk-hint">Nothing is available to you yet.</p>'}
        </div>
      </fieldset>
    </div>

    ${
      unavailable.length
        ? `<div class="govuk-form-group">
             <fieldset class="govuk-fieldset">
               <legend class="govuk-fieldset__legend">
                 <strong>Not available to you (${esc(unavailable.length)})</strong>
               </legend>
               <div class="govuk-checkboxes govuk-checkboxes--small">
                 ${unavailable.map(knowledgeItem).join('')}
               </div>
             </fieldset>
           </div>`
        : ''
    }

    <h2 class="govuk-heading-m">5. Tick what it may do</h2>
    <div class="govuk-form-group" id="actions">
      <fieldset class="govuk-fieldset">
        <legend class="govuk-fieldset__legend">Permitted actions</legend>
        <div class="govuk-checkboxes govuk-checkboxes--small">
          ${ACTIONS.map((a) => {
            const id = `a-${a.id}`;
            const checked = a.available && selActions.includes(a.id);
            return `<div class="govuk-checkboxes__item">
              <input class="govuk-checkboxes__input" id="${attr(id)}" name="actions" type="checkbox"
                     value="${attr(a.id)}"${checked ? ' checked' : ''}${a.available ? '' : ' disabled'}>
              <label class="govuk-checkboxes__label" for="${attr(id)}">
                ${esc(a.label)}
                ${a.available ? '' : ' <strong class="govuk-tag govuk-tag--grey">Not this phase</strong>'}
                <span class="cortex-src">${esc(a.hint)}</span>
              </label>
            </div>`;
          }).join('')}
        </div>
      </fieldset>
    </div>

    <button class="govuk-button" type="submit">Create it</button>
    <p class="govuk-body-s">
      Creating it does not share it. You test it first, and share it only if you want to.
    </p>
  </div>

  <!-- ------------------------------------------------------ tools + gates -->
  <div class="govuk-grid-column-one-third">
    <div class="cortex-filters">
      <h2 class="govuk-heading-m">Tools it may call</h2>
      <p class="govuk-body-s">
        MCP servers registered in API Management. These are how the agent reaches
        anything beyond its attached knowledge.
      </p>
      <div class="govuk-checkboxes govuk-checkboxes--small">
        ${
          tools.length
            ? tools
                .map((t) => {
                  const id = `t-${t.id}`;
                  return `<div class="govuk-checkboxes__item">
                    <input class="govuk-checkboxes__input" id="${attr(id)}" name="tools" type="checkbox"
                           value="${attr(t.id)}"${selTools.includes(t.id) ? ' checked' : ''}${t.attachable ? '' : ' disabled'}>
                    <label class="govuk-checkboxes__label" for="${attr(id)}">
                      ${esc(t.name)}
                      <span class="cortex-src">${
                        t.attachable ? esc(t.cat) + ' · MCP' : esc(t.reason)
                      }</span>
                    </label>
                  </div>`;
                })
                .join('')
            : '<p class="govuk-hint">No MCP servers registered yet.</p>'
        }
      </div>
    </div>

    <div class="cortex-filters">
      <h2 class="govuk-heading-m">Assurance</h2>
      <p class="govuk-body-s">
        Which gates apply depends on what it reads and what it does. You will see
        them once it is created — before sharing rather than after somebody asks.
      </p>
      <p class="govuk-body-s govuk-!-margin-bottom-0">
        <a class="govuk-link" href="/build/assurance">What are the seven gates?</a>
      </p>
    </div>
  </div>
</div>
</form>`;

  return layout({ ...ctx, title: 'Build an agent', section: 'build' }, content);
}

/* ------------------------------------------------------- gates reference */

export function assuranceReferencePage(ctx, { gates }) {
  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-full">
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-0">Assurance gates</h1>
    <p class="govuk-body-l">
      Which gates apply to what you are building, and why each one applies.
    </p>
    <p class="govuk-body">
      Gates are computed from what an agent reads and what it may do. Change the
      knowledge or the actions and the gates change with them — they are not a
      checklist somebody maintains by hand.
    </p>
    ${gateTable(gates, { caption: 'For an agent that reads and summarises, with no personal data' })}
    <p class="govuk-body">
      Gates that are complete, not required or not applicable show a dash. Gates that
      are outstanding carry a link to where the evidence goes.
    </p>
  </div>
</div>`;
  return layout({ ...ctx, title: 'Assurance gates', section: 'build' }, content);
}
