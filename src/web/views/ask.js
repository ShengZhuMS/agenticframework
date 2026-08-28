/**
 * Ask a question.
 *
 * The provenance panel is the point of this screen. An answer without its
 * working is a rumour with a confidence score.
 */

import { esc, attr, layout, visMark } from '../layout.js';

function sourceList(sources, ctx) {
  if (!sources.length) return '';
  return `
<h3 class="govuk-heading-s">Sources used</h3>
<dl class="govuk-summary-list">
  ${sources
    .map(
      (s) => `<div class="govuk-summary-list__row">
        <dt class="govuk-summary-list__key">
          <a class="govuk-link" href="/entry/${attr(s.id)}${ctx.personaQS()}">${esc(s.name)}</a>
          <span class="cortex-src">${esc(s.owner)} · ${esc(s.freshness)} · ${esc(s.sensitivity)}</span>
        </dt>
        <dd class="govuk-summary-list__value">${esc(s.used)}</dd>
      </div>`
    )
    .join('')}
</dl>`;
}

function couldNotReachList(items, ctx) {
  if (!items.length) return '';
  return `
<h3 class="govuk-heading-s">What it could not reach</h3>
<p class="govuk-body-s">
  These matched your question but were not used. An answer built from some of the
  relevant sources is a different answer, so Cortex names them rather than
  quietly answering from less.
</p>
<dl class="govuk-summary-list">
  ${items
    .map(
      (c) => `<div class="govuk-summary-list__row">
        <dt class="govuk-summary-list__key">
          <a class="govuk-link" href="/entry/${attr(c.id)}${ctx.personaQS()}">${esc(c.name)}</a>
          <span class="cortex-src">${esc(c.reason)}</span>
        </dt>
        <dd class="govuk-summary-list__value">
          ${visMark(c.state)}
          <p class="govuk-body-s" style="margin:6px 0 0">
            <a class="govuk-link" href="/entry/${attr(c.id)}${ctx.personaQS()}">${esc(c.next || 'Open')}</a>
          </p>
        </dd>
      </div>`
    )
    .join('')}
</dl>`;
}

function personRoute(items, ctx) {
  if (!items.length) return '';
  return `
<div class="govuk-inset-text">
  <h3 class="govuk-heading-s">Somebody can answer this for you</h3>
  <p class="govuk-body">
    You are not allowed the data behind these, but the team that holds it can
    compute an answer without the data ever leaving their access.
  </p>
  ${items
    .map(
      (a) => `<h4 class="govuk-heading-s govuk-!-margin-bottom-0">${esc(a.name)}</h4>
        <p class="govuk-body-s">Held by ${esc(a.owner)}.</p>
        ${
          a.askable.length
            ? `<ul class="govuk-list govuk-list--bullet">${a.askable.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>`
            : ''
        }
        ${a.minAgg ? `<p class="govuk-body-s"><strong>Minimum aggregation:</strong> ${esc(a.minAgg)}</p>` : ''}`
    )
    .join('')}
  <a class="govuk-button govuk-!-margin-bottom-0" href="/requests${ctx.personaQS()}" role="button">Request an answer</a>
</div>`;
}

function answerBlock(a, ctx) {
  return `
<div style="border-left:5px solid #1d70b8;padding-left:15px;margin:20px 0">
  <p class="govuk-body-s" style="color:#505a5f;margin-bottom:6px">You asked</p>
  <p class="govuk-body"><strong>${esc(a.question)}</strong></p>
</div>

<p class="govuk-body" style="white-space:pre-wrap">${esc(a.text)}</p>

<div class="govuk-inset-text">
  <h3 class="govuk-heading-s govuk-!-margin-bottom-0">Where this answer came from</h3>
  <p class="govuk-body-s">
    Searched ${esc(a.searched)} registered entries · ${esc(a.matched)} mentioned your terms ·
    ${esc(a.sources.length)} used · confidence <strong>${esc(a.confidence)}</strong>
  </p>
  ${sourceList(a.sources, ctx)}
  ${couldNotReachList(a.couldNotReach, ctx)}
</div>

${personRoute(a.answerableByPerson, ctx)}`;
}

export function askPage(ctx, { thread, history, threadId }) {
  const hist = (group, items) =>
    items.length
      ? `<h3 class="govuk-heading-s">${esc(group)}</h3>
         <ul class="govuk-list">
           ${items
             .map(
               (t) =>
                 `<li><a class="govuk-link" href="/ask?thread=${attr(t.id)}${ctx.personaQS('&')}">${esc(
                   String(t.title || 'Untitled').slice(0, 60)
                 )}</a></li>`
             )
             .join('')}
         </ul>`
      : '';

  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-one-third">
    <div class="cortex-filters">
      <h2 class="govuk-heading-m">Your questions</h2>
      ${
        history.total
          ? hist('Today', history.today) + hist('Yesterday', history.yesterday) + hist('Earlier', history.earlier)
          : '<p class="govuk-hint">Nothing yet.</p>'
      }
      ${
        threadId
          ? `<p class="govuk-body-s govuk-!-margin-bottom-0">
               <a class="govuk-link" href="/ask${ctx.personaQS()}">Start a new question</a>
             </p>`
          : ''
      }
    </div>
  </div>

  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-0">Ask a question</h1>
    <p class="govuk-body-l">
      Type it the way you would ask a colleague. You do not need to know which
      system holds the answer.
    </p>

    ${
      !thread
        ? `<div class="govuk-inset-text">
             <p class="govuk-body govuk-!-margin-bottom-0">
               Every answer shows its working: the sources used, how fresh each one was,
               and — the part worth reading — <strong>what it could not reach</strong>.
             </p>
           </div>`
        : ''
    }

    <form method="post" action="/ask${ctx.personaQS()}">
      ${threadId ? `<input type="hidden" name="thread" value="${attr(threadId)}">` : ''}
      <div class="govuk-form-group">
        <label class="govuk-label govuk-label--s" for="q">
          ${thread ? 'Follow up in this thread' : 'Your question'}
        </label>
        <input class="govuk-input" id="q" name="q" type="text"
               placeholder="How many waste carrier registrations lapsed in the last quarter?">
      </div>
      <button class="govuk-button" type="submit">${thread ? 'Ask a follow-up' : 'Ask'}</button>
    </form>

    ${thread ? thread.turns.map((t) => answerBlock(t, ctx)).join('<hr class="govuk-section-break govuk-section-break--visible govuk-section-break--l">') : ''}

    ${
      !thread
        ? `<h2 class="govuk-heading-m">Try one of these</h2>
           <ul class="govuk-list govuk-list--spaced">
             <li><a class="govuk-link" href="/ask?q=${encodeURIComponent('Which waste carrier registrations lapsed?')}${ctx.personaQS('&')}">Which waste carrier registrations lapsed?</a></li>
             <li><a class="govuk-link" href="/ask?q=${encodeURIComponent('What water quality data do we hold?')}${ctx.personaQS('&')}">What water quality data do we hold?</a></li>
             <li><a class="govuk-link" href="/ask?q=${encodeURIComponent('Average days sick per employee')}${ctx.personaQS('&')}">Average days sick per employee</a>
               <span class="cortex-src">Shows the "allowed the answer, not allowed the data" route</span></li>
             <li><a class="govuk-link" href="/ask?q=${encodeURIComponent('Badger population trends')}${ctx.personaQS('&')}">Badger population trends</a>
               <span class="cortex-src">Shows the working when nothing is found</span></li>
           </ul>`
        : ''
    }
  </div>
</div>`;

  return layout({ ...ctx, title: 'Ask a question', section: 'ask' }, content);
}
