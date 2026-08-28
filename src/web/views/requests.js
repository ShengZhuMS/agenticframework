/**
 * Requests — the working lifecycle.
 *
 * CAP-052  Raise a request
 * CAP-053  State what I need in my own words rather than filling a form
 * CAP-054  Say what it is for, so the holder can judge what to release
 * CAP-055  Have a holder proposed for me rather than knowing the org chart
 * CAP-056  Say whether I need it once or on a cadence
 * CAP-061  Track my requests and see where each one is
 * CAP-063  See the released answer with its method and boundary
 * CAP-069  See requests waiting on me
 * CAP-070  See a candidate answer prepared inside my own permissions
 * CAP-071  Check the method before the answer
 * CAP-073  Add a caveat that travels with the answer
 * CAP-074  Release an answer to one requester
 * CAP-076  Release and approve the method so it recurs
 * CAP-079  Decline with a reason
 */

import { esc, attr, layout } from '../layout.js';
import { STATUS } from '../../bff/services/requests.js';

const when = (iso) =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

function tag(status) {
  const s = STATUS[status] || STATUS.raised;
  return `<strong class="govuk-tag govuk-tag--${attr(s.tone)}">${esc(s.label)}</strong>`;
}

function tabs(active) {
  const items = [
    ['mine', 'My requests'],
    ['waiting', 'Waiting on me'],
    ['new', 'Ask for something']
  ];
  return `<nav class="cortex-nav" aria-label="Requests" style="margin-bottom:25px">
    <ul class="cortex-nav__list">
      ${items
        .map(
          ([id, label]) =>
            `<li class="cortex-nav__item"><a href="/requests?view=${attr(id)}"${
              active === id ? ' aria-current="page"' : ''
            }>${esc(label)}</a></li>`
        )
        .join('')}
    </ul>
  </nav>`;
}

/* --------------------------------------------------------------- raise */

function newRequestForm(ctx, { question, holders }) {
  return `
<h2 class="govuk-heading-m">Ask for something you cannot reach yourself</h2>
<form method="post" action="/requests/new">
  <div class="govuk-form-group">
    <label class="govuk-label govuk-label--s" for="question">What do you need to know?</label>
    <div class="govuk-hint">
      Ask it the way you would ask a colleague. You do not need to know who holds it.
    </div>
    <input class="govuk-input" id="question" name="question" type="text"
           value="${attr(question || '')}"
           placeholder="Average days sick per employee, by directorate">
  </div>
  ${
    holders && holders.length
      ? `<div class="govuk-form-group">
           <fieldset class="govuk-fieldset">
             <legend class="govuk-fieldset__legend"><strong>Who should answer this?</strong></legend>
             <div class="govuk-hint" style="font-size:16px">
               Proposed from what each team holds, so you do not have to know the org chart.
             </div>
             <div class="govuk-radios govuk-radios--small">
               ${holders
                 .map(
                   (h, i) => `<div class="govuk-radios__item">
                     <input class="govuk-radios__input" id="h-${attr(h.entryId)}" name="holderEntryId"
                            type="radio" value="${attr(h.entryId)}"${i === 0 ? ' checked' : ''}>
                     <label class="govuk-radios__label" for="h-${attr(h.entryId)}">
                       ${esc(h.owner)}
                       <span class="cortex-src">
                         Holds ${esc(h.entryName)}${h.minAgg ? ` · answers grouped to ${esc(h.minAgg)}` : ''}
                       </span>
                     </label>
                   </div>`
                 )
                 .join('')}
             </div>
           </fieldset>
         </div>`
      : question
        ? `<div class="govuk-inset-text">
             <p class="govuk-body govuk-!-margin-bottom-0">
               Nothing registered can answer that, and no holder was proposed. Submitting
               it still records the request — an unanswerable question is useful
               information about a gap in the register.
             </p>
           </div>`
        : ''
  }
  <div class="govuk-form-group">
    <label class="govuk-label govuk-label--s" for="purpose">What is it for?</label>
    <div class="govuk-hint">The holder uses this to judge what they can release.</div>
    <textarea class="govuk-textarea" id="purpose" name="purpose" rows="3"></textarea>
  </div>
  <div class="govuk-form-group">
    <fieldset class="govuk-fieldset">
      <legend class="govuk-fieldset__legend"><strong>How often do you need it?</strong></legend>
      <div class="govuk-radios govuk-radios--small">
        <div class="govuk-radios__item">
          <input class="govuk-radios__input" id="c-once" name="cadence" type="radio" value="once" checked>
          <label class="govuk-radios__label" for="c-once">Once</label>
        </div>
        <div class="govuk-radios__item">
          <input class="govuk-radios__input" id="c-month" name="cadence" type="radio" value="monthly">
          <label class="govuk-radios__label" for="c-month">Every month
            <span class="cortex-src">If the holder approves the method, it issues without them.</span>
          </label>
        </div>
      </div>
    </fieldset>
  </div>
  <button class="govuk-button" type="submit">Send the request</button>
</form>

${
  !question
    ? `<div class="govuk-inset-text">
         <h3 class="govuk-heading-s">Why this exists</h3>
         <p class="govuk-body">
           You are often entitled to an answer without being entitled to the data
           behind it. Your agent inherits your access, so it cannot reach the records
           either — and today that means an email, a spreadsheet and a week.
         </p>
         <p class="govuk-body govuk-!-margin-bottom-0">
           Here, the holder's agent drafts an answer from data <em>they</em> can reach,
           records how it did it, and a person reviews and releases it. Nobody sees
           anything they could not see before.
         </p>
       </div>`
    : ''
}`;
}

/* ---------------------------------------------------------- my requests */

function myRequests(ctx, { mine }) {
  if (!mine.length) {
    return `<h2 class="govuk-heading-m">My requests</h2>
      <p class="govuk-hint">You have not asked for anything yet.</p>
      <a class="govuk-button" href="/requests?view=new" role="button">Ask for something</a>`;
  }
  return `<h2 class="govuk-heading-m">My requests</h2>
    ${mine
      .map(
        (r) => `<div class="cortex-entry">
      <div class="cortex-entry__head">
        <div style="flex:1 1 440px">
          <h3 class="cortex-entry__title">
            <a class="govuk-link" href="/requests/${attr(r.ref)}">${esc(r.question)}</a>
          </h3>
          <p class="cortex-entry__meta">
            ${esc(r.ref)} · to ${esc(r.holder)} · raised ${esc(when(r.raisedAt))}
          </p>
          ${
            r.status === 'released'
              ? `<p class="cortex-entry__desc">${esc(String(r.released.answer).slice(0, 200))}</p>`
              : ''
          }
        </div>
        <div style="flex:0 0 200px">${tag(r.status)}</div>
      </div>
    </div>`
      )
      .join('')}`;
}

/* --------------------------------------------------------- waiting on me */

function waitingOnMe(ctx, { waiting }) {
  if (!waiting.length) {
    return `<h2 class="govuk-heading-m">Waiting on me</h2>
      <p class="govuk-hint">Nobody is waiting on you.</p>`;
  }
  return `<h2 class="govuk-heading-m">Waiting on me</h2>
    <p class="govuk-body">
      You can reach the data behind these. Cortex has drafted what it could, inside
      your access — review the method before the answer.
    </p>
    ${waiting
      .map(
        (r) => `<div class="cortex-entry">
      <div class="cortex-entry__head">
        <div style="flex:1 1 440px">
          <h3 class="cortex-entry__title">
            <a class="govuk-link" href="/requests/${attr(r.ref)}">${esc(r.question)}</a>
          </h3>
          <p class="cortex-entry__meta">
            ${esc(r.ref)} · from ${esc(r.requester)} · ${esc(when(r.raisedAt))}
          </p>
          <p class="cortex-entry__desc"><strong>For:</strong> ${esc(r.purpose || 'No purpose given')}</p>
        </div>
        <div style="flex:0 0 200px">
          ${tag(r.status)}
          <p class="govuk-body-s" style="margin-top:8px">
            <a class="govuk-link" href="/requests/${attr(r.ref)}">
              ${r.status === 'drafted' ? 'Review the draft' : 'Open it'}
            </a>
          </p>
        </div>
      </div>
    </div>`
      )
      .join('')}`;
}

export function requestsPage(ctx, { view, mine, waiting, holders, question }) {
  const body =
    view === 'new'
      ? newRequestForm(ctx, { question, holders })
      : view === 'waiting'
        ? waitingOnMe(ctx, { waiting })
        : myRequests(ctx, { mine });

  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-0">Requests</h1>
    <p class="govuk-body-l">
      For when you are allowed the answer but not the data behind it.
    </p>
  </div>
</div>

${tabs(view)}

<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">${body}</div>
  <div class="govuk-grid-column-one-third">
    <div class="cortex-filters">
      <h2 class="govuk-heading-m">How this works</h2>
      <ol class="govuk-list govuk-list--number govuk-list--spaced" style="font-size:16px">
        <li>You ask, once, in one place.</li>
        <li>Cortex proposes who holds the data.</li>
        <li><strong>Their agent drafts an answer from data they can reach</strong>, and records the method.</li>
        <li>They review the method and the answer, then release it.</li>
      </ol>
      <hr class="govuk-section-break govuk-section-break--visible govuk-section-break--m">
      <p class="govuk-body-s govuk-!-margin-bottom-0">
        None of the controls move. Nobody sees data they could not see before, and
        a person still decides whether the answer should be given at all.
      </p>
    </div>
  </div>
</div>`;

  return layout({ ...ctx, title: 'Requests', section: 'requests' }, content);
}

/* --------------------------------------------------------- one request */

export function requestDetailPage(ctx, { request: r, isHolder }) {
  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <span class="govuk-caption-l">${esc(r.ref)} · raised ${esc(when(r.raisedAt))}</span>
    <h1 class="govuk-heading-l govuk-!-margin-bottom-0">${esc(r.question)}</h1>
    <p class="govuk-body">${tag(r.status)}</p>

    <dl class="govuk-summary-list">
      <div class="govuk-summary-list__row">
        <dt class="govuk-summary-list__key">Asked by</dt>
        <dd class="govuk-summary-list__value">${esc(r.requester)}</dd>
      </div>
      <div class="govuk-summary-list__row">
        <dt class="govuk-summary-list__key">What for</dt>
        <dd class="govuk-summary-list__value">${esc(r.purpose || 'Not stated')}</dd>
      </div>
      <div class="govuk-summary-list__row">
        <dt class="govuk-summary-list__key">Held by</dt>
        <dd class="govuk-summary-list__value">${esc(r.holder)}
          ${r.holderEntryName ? `<span class="cortex-src">${esc(r.holderEntryName)}</span>` : ''}</dd>
      </div>
      ${
        r.minAgg
          ? `<div class="govuk-summary-list__row">
               <dt class="govuk-summary-list__key">Minimum aggregation</dt>
               <dd class="govuk-summary-list__value">${esc(r.minAgg)}
                 <span class="cortex-src">Enforced on any answer, not a caveat to remember.</span></dd>
             </div>`
          : ''
      }
      <div class="govuk-summary-list__row">
        <dt class="govuk-summary-list__key">Cadence</dt>
        <dd class="govuk-summary-list__value">${esc(r.cadence)}</dd>
      </div>
    </dl>

    ${
      r.status === 'released'
        ? `<h2 class="govuk-heading-m">The answer</h2>
           <div style="border-left:5px solid #00703c;padding-left:15px;margin-bottom:20px">
             <p class="govuk-body" style="white-space:pre-wrap">${esc(r.released.answer)}</p>
           </div>
           ${
             r.released.caveat
               ? `<div class="govuk-warning-text">
                    <span class="govuk-warning-text__icon" aria-hidden="true">!</span>
                    <strong class="govuk-warning-text__text">
                      <span class="govuk-skip-link">Warning</span>${esc(r.released.caveat)}
                    </strong>
                  </div>`
               : ''
           }
           <h3 class="govuk-heading-s">How it was worked out</h3>
           <pre style="white-space:pre-wrap;font-family:inherit;font-size:16px;background:#f3f2f1;padding:15px">${esc(
             r.released.method || 'No method recorded.'
           )}</pre>
           <p class="govuk-hint">
             Released by ${esc(r.released.releasedBy)} on ${esc(when(r.released.releasedAt))}.
             The method travels with the answer, so it can be checked.
           </p>`
        : ''
    }

    ${
      r.status === 'declined'
        ? `<h2 class="govuk-heading-m">Declined</h2>
           <p class="govuk-body">${esc(r.declined.reason)}</p>
           ${r.declined.offered ? `<p class="govuk-body"><strong>Offered instead:</strong> ${esc(r.declined.offered)}</p>` : ''}`
        : ''
    }

    ${
      isHolder && r.status !== 'released' && r.status !== 'declined'
        ? holderPanel(r)
        : ''
    }

    <h2 class="govuk-heading-m">History</h2>
    <ol class="govuk-list">
      ${r.history
        .map(
          (h) => `<li style="padding:8px 0;border-bottom:1px solid #b1b4b6">
            <strong>${esc(h.what)}</strong>
            <span class="cortex-src">${esc(h.by)} · ${esc(when(h.at))}</span>
          </li>`
        )
        .join('')}
    </ol>

    <p class="govuk-body"><a class="govuk-link" href="/requests">Back to requests</a></p>
  </div>
</div>`;

  return layout({ ...ctx, title: r.ref, section: 'requests' }, content);
}

/** What the holder sees: the method first, then the answer, then release. */
function holderPanel(r) {
  if (r.status === 'raised') {
    return `
<div class="govuk-inset-text">
  <h2 class="govuk-heading-m">Draft it</h2>
  <p class="govuk-body">
    Cortex will read what <strong>you</strong> can reach — never what the requester
    can reach — draft an answer, and record the method it used.
  </p>
  <form method="post" action="/requests/${attr(r.ref)}/draft">
    <button class="govuk-button govuk-!-margin-bottom-0" type="submit">Draft an answer</button>
  </form>
</div>`;
  }

  return `
<h2 class="govuk-heading-m">Check the method first</h2>
<pre style="white-space:pre-wrap;font-family:inherit;font-size:16px;background:#f3f2f1;padding:15px">${esc(
    r.draft?.method || 'No method recorded.'
  )}</pre>

<h2 class="govuk-heading-m">The drafted answer</h2>
${
  r.draft?.text
    ? ''
    : `<div class="govuk-warning-text">
         <span class="govuk-warning-text__icon" aria-hidden="true">!</span>
         <strong class="govuk-warning-text__text">
           <span class="govuk-skip-link">Warning</span>
           Nothing could be drafted${r.draftError ? ` — ${esc(r.draftError)}` : ''}. Write the answer yourself below.
         </strong>
       </div>`
}

<form method="post" action="/requests/${attr(r.ref)}/release">
  <div class="govuk-form-group">
    <label class="govuk-label govuk-label--s" for="answer">Answer</label>
    <div class="govuk-hint">Edit it. What you release is what the requester sees.</div>
    <textarea class="govuk-textarea" id="answer" name="answer" rows="6">${esc(r.draft?.text || '')}</textarea>
  </div>
  <div class="govuk-form-group">
    <label class="govuk-label govuk-label--s" for="caveat">Add a caveat</label>
    <div class="govuk-hint">Travels with the answer wherever it goes. Optional.</div>
    <input class="govuk-input" id="caveat" name="caveat" type="text">
  </div>
  <div class="govuk-form-group">
    <div class="govuk-checkboxes govuk-checkboxes--small">
      <div class="govuk-checkboxes__item">
        <input class="govuk-checkboxes__input" id="approve" name="approveMethod" type="checkbox" value="yes">
        <label class="govuk-checkboxes__label" for="approve">
          Approve this method
          <span class="cortex-src">
            The same question then answers without you. You can retire it at any time.
          </span>
        </label>
      </div>
    </div>
  </div>
  <button class="govuk-button" type="submit">Release it</button>
</form>

<details style="margin-bottom:20px">
  <summary class="govuk-link" style="cursor:pointer">Decline instead</summary>
  <form method="post" action="/requests/${attr(r.ref)}/decline" style="margin-top:15px">
    <div class="govuk-form-group">
      <label class="govuk-label govuk-label--s" for="reason">Why?</label>
      <input class="govuk-input" id="reason" name="reason" type="text">
    </div>
    <div class="govuk-form-group">
      <label class="govuk-label govuk-label--s" for="offered">Offer something instead</label>
      <div class="govuk-hint" style="font-size:16px">Optional.</div>
      <input class="govuk-input" id="offered" name="offered" type="text">
    </div>
    <button class="govuk-button govuk-button--warning" type="submit">Decline</button>
  </form>
</details>`;
}
