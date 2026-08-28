/**
 * The entry page — the full entry standard.
 *
 * CAP-039  Open one entry and read the full entry standard
 * CAP-040  See where each field came from and who maintains it
 * CAP-041  See known limitations before using something
 * CAP-042  See lineage and dependencies, and follow them
 * CAP-043  See the licence and who it covers
 * CAP-044  See use, cost per use and health over 90 days
 * CAP-045  See quality flags on an entry
 * CAP-046  See the minimum aggregation enforced on an entry
 * CAP-047  Claim an entry from its own page
 * CAP-048  Report a correction on an entry
 * CAP-016  See what can be asked of data I cannot see
 * CAP-017  See a holder's release record before asking
 * CAP-020  Watch an entry for change
 * CAP-022  Request access to an entry
 *
 * Two columns, deliberately. The left is written to be read by a person
 * deciding whether to use this thing. The right is the standard, every
 * mandatory field, each one saying where it came from and who keeps it up
 * to date. A field an agent derived and no human has checked says so, so a
 * reader can judge how much to trust it.
 */

import { esc, attr, visMark, layout } from '../layout.js';
import { VIS } from '../../bff/services/visibility.js';

const num = (n) => Number(n || 0).toLocaleString('en-GB');

const RAG = {
  g: ['green', 'Healthy'],
  a: ['orange', 'Watch'],
  r: ['red', 'Degraded']
};

const FLAG_TEXT = {
  'zero use': 'Registered but never called',
  stale: 'Not refreshed within its stated freshness',
  unowned: 'No confirmed owner',
  duplicate: 'Possible duplicate of another entry',
  'licence blocked': 'Licence blocks some of the people who want it'
};

function flags(e) {
  if (!e.flags?.length) return '';
  return (
    `<p class="govuk-body-s" style="margin-bottom:10px">` +
    e.flags
      .map(
        (f) =>
          `<strong class="govuk-tag govuk-tag--orange" style="margin-right:6px">${esc(f)}</strong>`
      )
      .join('') +
    `</p>`
  );
}

/** One row of the entry standard: value plus where it came from. */
function row(field, value, source, by) {
  return `<div class="govuk-summary-list__row">
    <dt class="govuk-summary-list__key">${esc(field)}<span class="cortex-src">${esc(source)} · maintained by ${esc(by)}</span></dt>
    <dd class="govuk-summary-list__value">${value}</dd>
  </div>`;
}

export function entryPage(ctx, { entry: e, cluster, requested }) {
  const deps = (e.deps || []).length
    ? e.deps
        .map((d) => {
          const t = ctx.findByName(d);
          return t
            ? `<a class="govuk-link" href="/entry/${attr(t.id)}${ctx.personaQS()}">${esc(t.name)}</a>`
            : esc(d);
        })
        .join(', ')
    : `<span class="govuk-hint" style="display:inline">None recorded. An empty dependency list is a gap, not proof of independence.</span>`;

  const [ragTone, ragLabel] = RAG[e.rag] || RAG.g;

  /* ---------------------------------------------------- the action panel */
  let actions = '';
  if (e.vis === 'available') {
    actions = `
      <a class="govuk-button" href="/build?knowledge=${attr(e.id)}${ctx.personaQS('&')}" role="button">Build an agent with it</a>
      <a class="govuk-button govuk-button--secondary" href="/ask?entry=${attr(e.id)}${ctx.personaQS('&')}" role="button">Use it in a question</a>`;
  } else if (e.vis === 'request') {
    actions = requested
      ? `<div class="govuk-panel">
           <h2 class="govuk-panel__title">Request sent</h2>
           <div class="govuk-panel__body">Your reference<br><strong>${esc(requested)}</strong></div>
         </div>
         <p class="govuk-body-s">It is with ${esc(e.owner)}. Track it under Requests.</p>`
      : `<form method="post" action="/entry/${attr(e.id)}/request${ctx.personaQS()}">
           <div class="govuk-form-group">
             <label class="govuk-label govuk-label--s" for="purpose">What do you need it for?</label>
             <div class="govuk-hint" style="font-size:16px">${esc(e.owner)} uses this to judge what to release. Write plainly.</div>
             <textarea class="govuk-textarea" id="purpose" name="purpose" rows="3" required></textarea>
           </div>
           <div class="govuk-form-group">
             <fieldset class="govuk-fieldset">
               <legend class="govuk-fieldset__legend"><strong>How often do you need it?</strong></legend>
               <div class="govuk-radios govuk-radios--small">
                 <div class="govuk-radios__item">
                   <input class="govuk-radios__input" id="cad-once" name="cadence" type="radio" value="once" checked>
                   <label class="govuk-radios__label" for="cad-once">Once</label>
                 </div>
                 <div class="govuk-radios__item">
                   <input class="govuk-radios__input" id="cad-rep" name="cadence" type="radio" value="repeating">
                   <label class="govuk-radios__label" for="cad-rep">On a repeating basis</label>
                 </div>
               </div>
             </fieldset>
           </div>
           <button class="govuk-button" type="submit">Request access</button>
         </form>`;
  } else if (e.vis === 'person') {
    actions = `
      <p class="govuk-body-s">You cannot have the data. ${esc(e.owner)} can answer from it, without the data leaving their access.</p>
      <a class="govuk-button" href="/requests${ctx.personaQS()}" role="button">Request an answer</a>`;
  } else {
    actions = `<p class="govuk-body"><strong>${esc(VIS[e.vis]?.next)}</strong></p>
      ${
        e.vis === 'licence'
          ? `<p class="govuk-body-s">This is a commercial question, not a technical one. Contact ${esc(e.owner)}.</p>`
          : e.vis === 'notcleared'
            ? `<p class="govuk-body-s">Connected through the gateway. The clearance decision sits with the AI Unit.</p>`
            : `<p class="govuk-body-s">There is no route to this in your current role. Cortex tells you plainly rather than letting you waste time.</p>`
      }`;
  }

  const content = `
${
  requested
    ? `<div class="govuk-notification-banner govuk-notification-banner--success" role="alert" aria-labelledby="nb-title">
         <div class="govuk-notification-banner__header"><p class="govuk-notification-banner__title" id="nb-title">Success</p></div>
         <div class="govuk-notification-banner__content">
           <p class="govuk-body">Your access request <strong>${esc(requested)}</strong> has gone to ${esc(e.owner)}.</p>
         </div>
       </div>`
    : ''
}

<div class="govuk-grid-row">
  <div class="govuk-grid-column-full">
    <span class="govuk-caption-l">${esc(e.cat)} · ${esc(cluster?.name || e.cluster)} · ${esc(cluster?.owner || '')}</span>
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-0">${esc(e.name)}</h1>
    <p class="govuk-body-l">${esc(e.desc)}</p>
    ${flags(e)}
    <div style="margin-bottom:20px">${visMark(e.vis)}</div>
  </div>
</div>

<div class="govuk-grid-row">
  <!-- ---------------------------------------------------- readable column -->
  <div class="govuk-grid-column-two-thirds">

    <h2 class="govuk-heading-m">Known limitations</h2>
    ${
      e.limits
        ? `<div class="govuk-warning-text">
             <span class="govuk-warning-text__icon" aria-hidden="true">!</span>
             <strong class="govuk-warning-text__text"><span class="govuk-skip-link">Warning</span>${esc(e.limits)}</strong>
           </div>`
        : `<p class="govuk-hint">None recorded. An empty limitations field is a gap, not a clean bill of health.</p>`
    }

    <h2 class="govuk-heading-m">Lineage and dependencies</h2>
    <p class="govuk-body">${deps}</p>

    <h2 class="govuk-heading-m">Licence, and who is covered</h2>
    <p class="govuk-body">${esc(e.licence)}</p>

    ${
      e.askable?.length
        ? `<h2 class="govuk-heading-m">What can be asked of it</h2>
           <p class="govuk-body">You cannot see this data. You can have an answer computed over it by the team that can, without the data ever leaving their access.</p>
           <ul class="govuk-list govuk-list--bullet govuk-list--spaced">
             ${e.askable.map((q) => `<li>${esc(q)}</li>`).join('')}
           </ul>`
        : ''
    }

    ${
      e.minAgg
        ? `<h2 class="govuk-heading-m">Minimum aggregation</h2>
           <p class="govuk-body">${esc(e.minAgg)}</p>
           <p class="govuk-hint">This is a property of the entry, enforced on every answer. It is not a caveat somebody has to remember to apply.</p>`
        : ''
    }

    ${
      e.holderStats
        ? `<h2 class="govuk-heading-m">This holder's release record</h2>
           <p class="govuk-body">
             ${esc(e.holderStats.released)} released of ${esc(e.holderStats.requests)} asked,
             ${esc(e.holderStats.declined)} declined. Median ${esc(e.holderStats.median)}.
           </p>
           <p class="govuk-hint">Shown before you ask, so you know what to expect.</p>`
        : ''
    }

    <h2 class="govuk-heading-m">Use over the last 90 days</h2>
    <div class="cortex-stats">
      <div class="cortex-stat">
        <span class="cortex-stat__n">${esc(num(e.calls))}</span>
        <span class="cortex-stat__l">calls, from ${esc(e.consumers || 0)} distinct consumers
          <span class="cortex-illus">Illustrative</span></span>
      </div>
      <div class="cortex-stat">
        <span class="cortex-stat__n">${esc(e.cpu || '—')}</span>
        <span class="cortex-stat__l">per use. Absolute spend is deliberately not shown.
          <span class="cortex-illus">Illustrative</span></span>
      </div>
      <div class="cortex-stat">
        <span class="cortex-stat__n">${esc(e.err || '—')}</span>
        <span class="cortex-stat__l">errors · ${esc(e.lat || '—')} median latency ·
          <strong class="govuk-tag govuk-tag--${attr(ragTone)}">${esc(ragLabel)}</strong>
          <span class="cortex-illus">Illustrative</span></span>
      </div>
    </div>

    <h2 class="govuk-heading-m">The entry standard</h2>
    <p class="govuk-hint">
      Every mandatory field, its source, and who maintains it. Owner is the only
      field a human must supply, and only once.
    </p>
    <dl class="govuk-summary-list">
      ${row('Name', esc(e.name), 'Source system', 'agent')}
      ${row('Category', esc(e.cat), 'Derived', 'agent')}
      ${row('Description', 'Populated', 'Generated from schema, lineage and classification', 'agent')}
      ${row(
        'Owner',
        e.ownerState === 'proposed'
          ? `${esc(e.owner)}
             <strong class="govuk-tag govuk-tag--orange" style="margin-left:8px">Proposed, never confirmed</strong>
             <p class="govuk-body-s" style="margin:8px 0 0">
               <a class="govuk-link" href="/entry/${attr(e.id)}/claim${ctx.personaQS()}">Claim this entry</a>
             </p>`
          : esc(e.owner),
        e._ownerDerived
          ? 'Derived from the cluster, not stated by the entry'
          : 'Proposed from resource tags',
        e.ownerState === 'confirmed' ? 'a human, once' : 'nobody yet'
      )}
      ${row('Cluster', esc(cluster?.name || e.cluster), 'Assigned', 'a human')}
      ${row('Freshness', esc(e.fresh), 'Lineage', 'agent')}
      ${row('Sensitivity', esc(e.sens), 'Purview classification', 'agent')}
      ${row('Access route', esc(e.access), 'Derived from the permissions model', 'agent')}
      ${row('Visibility state', `${esc(VIS[e.vis]?.label)}<span class="cortex-src">${esc(e.visReason || '')}</span>`, 'Derived', 'agent')}
      ${row('Licence model', esc(String(e.licence || '').split('—')[0].trim()), 'Commercial record', 'a human, then agent')}
      ${row('Usage', `${esc(num(e.calls))} calls, ${esc(e.consumers || 0)} consumers`, 'Gateway telemetry', 'agent')}
      ${row('Cost per use', esc(e.cpu || '—'), 'Gateway telemetry and cost data', 'agent')}
      ${row('Health', `${esc(e.err || '—')} errors, ${esc(e.lat || '—')}`, 'Monitoring', 'agent')}
      ${row('Carbon, estimated', esc(e.carbon || '—'), 'Proxied from consumption', 'agent')}
      ${row('Location', esc(e.location || '—'), 'Source', 'agent')}
      ${e.minAgg ? row('Minimum aggregation', esc(e.minAgg), 'Property of the source', 'enforcement, not a caveat') : ''}
      ${
        e.holderStats
          ? row(
              'Release record',
              `${esc(e.holderStats.released)} released of ${esc(e.holderStats.requests)} asked, ${esc(e.holderStats.declined)} declined. Median ${esc(e.holderStats.median)}.`,
              "From the holder's decisions",
              'agent'
            )
          : ''
      }
      ${
        e._endpoints?.mcp
          ? row('MCP endpoint', `<code style="font-size:15px;word-break:break-all">${esc(e._endpoints.mcp)}</code>`, 'API Management', 'agent')
          : ''
      }
      ${row(
        'Correction route',
        e.ownerState === 'proposed'
          ? '<span class="govuk-hint" style="display:inline">Unverified — no confirmed owner</span>'
          : 'To the owner named above',
        'Derived from owner',
        'agent'
      )}
    </dl>

    <h2 class="govuk-heading-m">Something wrong with this entry?</h2>
    <form method="post" action="/entry/${attr(e.id)}/correction${ctx.personaQS()}">
      <div class="govuk-form-group">
        <label class="govuk-label" for="correction">What is wrong?</label>
        <div class="govuk-hint" style="font-size:16px">
          ${
            e.ownerState === 'proposed'
              ? 'This entry has no confirmed owner, so corrections go to the cluster owner instead.'
              : `This goes to ${esc(e.owner)}, not to Cortex.`
          }
        </div>
        <textarea class="govuk-textarea" id="correction" name="correction" rows="3"></textarea>
      </div>
      <button class="govuk-button govuk-button--secondary" type="submit">Report a correction</button>
    </form>
  </div>

  <!-- ------------------------------------------------------ action column -->
  <div class="govuk-grid-column-one-third">
    <div class="cortex-filters">
      <h2 class="govuk-heading-m">Can you use this?</h2>
      ${visMark(e.vis)}
      <p class="govuk-body-s" style="margin-top:10px">${esc(e.visReason || '')}</p>
      <hr class="govuk-section-break govuk-section-break--visible govuk-section-break--m">
      ${actions}
      <hr class="govuk-section-break govuk-section-break--visible govuk-section-break--m">
      <form method="post" action="/entry/${attr(e.id)}/watch${ctx.personaQS()}">
        <button class="govuk-button govuk-button--secondary govuk-!-margin-bottom-0" type="submit">Watch this entry</button>
      </form>
      <p class="govuk-body-s" style="margin-top:10px">
        You will be told when its freshness, owner, licence or visibility changes.
      </p>
    </div>

    <p class="govuk-body-s">
      <a class="govuk-link" href="/marketplace${ctx.personaQS()}">Back to the marketplace</a>
    </p>
    <p class="govuk-body-s">
      <a class="govuk-link" href="/marketplace?cluster=${attr(e.cluster)}${ctx.personaQS('&')}">
        Everything in ${esc(cluster?.name || e.cluster)}
      </a>
    </p>
  </div>
</div>`;

  return layout({ ...ctx, title: e.name, section: 'marketplace' }, content);
}

/** CAP-049 — be told when an entry does not exist, and what to do about it. */
export function entryNotFoundPage(ctx, { id }) {
  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl">That entry is not registered</h1>
    <p class="govuk-body-l">
      Nothing in the register matches <strong>${esc(id)}</strong>.
    </p>
    <p class="govuk-body">
      That may mean it does not exist. It may also mean it exists and nobody has
      registered it — which is the more common of the two, and the more useful
      thing to know.
    </p>
    <a class="govuk-button" href="/share${ctx.personaQS()}" role="button">Tell us about something that is missing</a>
    <p class="govuk-body"><a class="govuk-link" href="/marketplace${ctx.personaQS()}">Search the marketplace</a></p>
  </div>
</div>`;
  return layout({ ...ctx, title: 'Entry not registered', section: 'marketplace' }, content);
}

export default entryPage;
