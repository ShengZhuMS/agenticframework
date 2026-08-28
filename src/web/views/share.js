/**
 * Share your data.
 *
 * CAP-091  See what my team shares and how much it is used
 * CAP-092  Connect a source through the gateway rather than upload a file
 * CAP-093  Understand why there is no file picker
 * CAP-094  See where my registration sits in the gateway queue
 * CAP-095  Confirm my team owns an entry proposed from resource tags
 * CAP-097  Handle access requests to what I share, in one place
 * CAP-108  See what is registered and never called
 * CAP-109  See cost per use against usage
 * CAP-165  See what I own, its usage, cost and health in one place
 */

import { esc, attr, layout, visMark } from '../layout.js';

const num = (n) => Number(n || 0).toLocaleString('en-GB');

export function sharePage(ctx, { mine, proposed, requests, neverCalled, submitted, gateway }) {
  const content = `
${
  submitted
    ? `<div class="govuk-notification-banner govuk-notification-banner--success" role="alert" aria-labelledby="s-t">
         <div class="govuk-notification-banner__header">
           <p class="govuk-notification-banner__title" id="s-t">Request received</p>
         </div>
         <div class="govuk-notification-banner__content">
           <p class="govuk-body">
             Your gateway registration reference is <strong>${esc(submitted)}</strong>.
           </p>
           <p class="govuk-body govuk-!-margin-bottom-0">
             Nothing has been copied and nothing has moved. This registers a connection.
           </p>
         </div>
       </div>`
    : ''
}

<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-0">Share your data</h1>
    <p class="govuk-body-l">
      What ${esc(ctx.user.team)} makes available, who is asking for it, and how it is used.
    </p>
  </div>
</div>

<!-- CAP-093 — the callout that explains why there is no file picker -->
<div class="govuk-inset-text">
  <h2 class="govuk-heading-m">There is no file picker, and that is deliberate</h2>
  <p class="govuk-body">
    You are not uploading. <strong>Nothing is copied and nothing moves.</strong>
    You are registering a connection to data where it already lives, so that it can
    be found and — where you allow it — read in place.
  </p>
  <p class="govuk-body govuk-!-margin-bottom-0">
    Your team stays in control, the data stays current, and there is no second copy
    to go stale, drift out of step, or leak.
  </p>
</div>

<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">

    <h2 class="govuk-heading-m">What your team shares</h2>
    ${
      mine.length
        ? `<table class="govuk-table">
             <thead>
               <tr>
                 <th scope="col" class="govuk-table__header">Entry</th>
                 <th scope="col" class="govuk-table__header">Freshness</th>
                 <th scope="col" class="govuk-table__header govuk-table__header--numeric">Calls</th>
                 <th scope="col" class="govuk-table__header govuk-table__header--numeric">Teams</th>
                 <th scope="col" class="govuk-table__header">Health</th>
               </tr>
             </thead>
             <tbody>
               ${mine
                 .map(
                   (e) => `<tr class="govuk-table__row">
                     <td class="govuk-table__cell">
                       <a class="govuk-link" href="/entry/${attr(e.id)}">${esc(e.name)}</a>
                       <span class="cortex-src">${esc(e.cat)} · ${esc(ctx.clusterName(e.cluster))}</span>
                     </td>
                     <td class="govuk-table__cell">${esc(e.fresh)}</td>
                     <td class="govuk-table__cell govuk-table__cell--numeric">${esc(num(e.calls))}</td>
                     <td class="govuk-table__cell govuk-table__cell--numeric">${esc(e.consumers || 0)}</td>
                     <td class="govuk-table__cell">
                       <strong class="govuk-tag govuk-tag--${e.rag === 'g' ? 'green' : e.rag === 'a' ? 'orange' : 'red'}">
                         ${esc(e.err || '—')}
                       </strong>
                     </td>
                   </tr>`
                 )
                 .join('')}
             </tbody>
           </table>
           <p class="govuk-hint">Usage and health figures are illustrative.</p>`
        : '<p class="govuk-hint">Your team has not registered anything yet.</p>'
    }

    <!-- CAP-095 -->
    ${
      proposed.length
        ? `<h2 class="govuk-heading-m">Proposed as yours, never confirmed</h2>
           <p class="govuk-body">
             An agent proposed these from resource tags. Nobody has confirmed them.
             Confirming takes a moment and it is what makes the register trustworthy.
           </p>
           <table class="govuk-table">
             <tbody>
               ${proposed
                 .map(
                   (e) => `<tr class="govuk-table__row">
                     <td class="govuk-table__cell">
                       <a class="govuk-link" href="/entry/${attr(e.id)}">${esc(e.name)}</a>
                       <span class="cortex-src">${esc(ctx.clusterName(e.cluster))} · proposed from resource tags</span>
                     </td>
                     <td class="govuk-table__cell" style="text-align:right">
                       <a class="govuk-link" href="/entry/${attr(e.id)}/claim">Confirm it is ours</a>
                     </td>
                   </tr>`
                 )
                 .join('')}
             </tbody>
           </table>`
        : ''
    }

    <!-- CAP-097 -->
    <h2 class="govuk-heading-m">People asking for access</h2>
    ${
      requests.length
        ? `<table class="govuk-table">
             <thead>
               <tr>
                 <th scope="col" class="govuk-table__header">Who and what for</th>
                 <th scope="col" class="govuk-table__header">Entry</th>
                 <th scope="col" class="govuk-table__header">Waiting</th>
                 <th scope="col" class="govuk-table__header">Decision</th>
               </tr>
             </thead>
             <tbody>
               ${requests
                 .map(
                   (r) => `<tr class="govuk-table__row">
                     <td class="govuk-table__cell">
                       <strong>${esc(r.requester)}</strong>
                       <span class="cortex-src">${esc(r.purpose || 'No purpose given')}</span>
                     </td>
                     <td class="govuk-table__cell">${esc(r.entryName || r.entryId)}</td>
                     <td class="govuk-table__cell">${esc(r.waiting)}</td>
                     <td class="govuk-table__cell">
                       <form method="post" action="/share/requests/${attr(r.ref)}" style="display:inline">
                         <button class="govuk-link" name="decision" value="approve" type="submit"
                                 style="border:0;background:none;cursor:pointer;padding:0">Approve</button>
                       </form>
                       ·
                       <form method="post" action="/share/requests/${attr(r.ref)}" style="display:inline">
                         <button class="govuk-link" name="decision" value="decline" type="submit"
                                 style="border:0;background:none;cursor:pointer;padding:0">Decline</button>
                       </form>
                     </td>
                   </tr>`
                 )
                 .join('')}
             </tbody>
           </table>
           <p class="govuk-hint">
             Every request for data, a skill or an agent arrives here, in one format,
             whatever the underlying system holds it.
           </p>`
        : `<p class="govuk-hint">Nobody is waiting on you.</p>`
    }

    <!-- CAP-108 -->
    ${
      neverCalled.length
        ? `<h2 class="govuk-heading-m">Registered and never called</h2>
           <p class="govuk-body">
             ${esc(neverCalled.length)} entries have never been called. They are candidates for
             retirement, or a sign that nobody knows they exist.
           </p>
           <ul class="govuk-list govuk-list--bullet">
             ${neverCalled
               .map(
                 (e) => `<li>
                   <a class="govuk-link" href="/entry/${attr(e.id)}">${esc(e.name)}</a>
                   <span class="cortex-src">${esc(e.owner)}</span>
                 </li>`
               )
               .join('')}
           </ul>`
        : ''
    }
  </div>

  <!-- CAP-092, CAP-094 -->
  <div class="govuk-grid-column-one-third">
    <div class="cortex-filters">
      <h2 class="govuk-heading-m">Connect a source</h2>
      <form method="post" action="/share/connect">
        <div class="govuk-form-group">
          <label class="govuk-label govuk-label--s" for="system">Source system</label>
          <input class="govuk-input" id="system" name="system" type="text" placeholder="WIMS">
        </div>
        <div class="govuk-form-group">
          <label class="govuk-label govuk-label--s" for="object">Object or endpoint</label>
          <input class="govuk-input" id="object" name="object" type="text" placeholder="sampling_results">
        </div>
        <div class="govuk-form-group">
          <label class="govuk-label govuk-label--s" for="team">Owning team</label>
          <input class="govuk-input" id="team" name="team" type="text" value="${attr(ctx.user.team)}">
        </div>
        <button class="govuk-button govuk-!-margin-bottom-0" type="submit">Request registration</button>
      </form>
      <p class="govuk-body-s" style="margin-top:12px">
        This raises a gateway registration request. Nothing is copied and no data moves.
      </p>
    </div>

    <div class="cortex-filters">
      <h2 class="govuk-heading-m">The gateway queue</h2>
      ${
        gateway.total
          ? `<dl class="govuk-summary-list">
               <div class="govuk-summary-list__row">
                 <dt class="govuk-summary-list__key">Registrations waiting</dt>
                 <dd class="govuk-summary-list__value">${esc(gateway.total)}</dd>
               </div>
               <div class="govuk-summary-list__row">
                 <dt class="govuk-summary-list__key">Yours in the queue</dt>
                 <dd class="govuk-summary-list__value">${esc(gateway.mine)}</dd>
               </div>
               <div class="govuk-summary-list__row">
                 <dt class="govuk-summary-list__key">Reviewed by</dt>
                 <dd class="govuk-summary-list__value">AI Unit and CCoE</dd>
               </div>
             </dl>`
          : `<p class="govuk-hint">Nothing is waiting for gateway review.</p>`
      }
      <p class="govuk-body-s govuk-!-margin-bottom-0">
        There is no tiered pattern yet, so every connection gets the same review.
      </p>
    </div>
  </div>
</div>`;

  return layout({ ...ctx, title: 'Share your data', section: 'share' }, content);
}
