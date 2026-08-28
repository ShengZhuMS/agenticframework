/**
 * Requests — the walkthrough (WP17).
 *
 * This is deliberately NOT a working implementation. It is the four screens
 * of the deck's worked example, clickable, presented honestly as what the
 * investment buys.
 *
 * The reasoning: Requests carries the strongest narrative in the whole source
 * — seven handoffs to produce one number, collapsed to one — and it is also
 * the most expensive thing in the backlog to build properly, because it needs
 * a request lifecycle, a method registry, versioned approvals, a recurrence
 * engine and a release workflow. Showing the destination costs a day.
 * Building it costs a quarter. So: show the destination, and say so.
 */

import { esc, attr, layout } from '../layout.js';

const AS_IS = [
  ['Manager asks', 'Tells the management information team.'],
  ['Request goes out', 'By email, spreadsheet or form.'],
  ['Responder digs', 'Logs in, runs a report, finds the data.'],
  ['Responder replies', 'The answer comes back by email.'],
  ['Paste and collate', 'Into a spreadsheet with all the others.'],
  ['Feeds a dashboard', 'The spreadsheet is connected to Power BI.'],
  ['Manager reads', 'Looks at the dashboard.']
];

const TO_BE = [
  ['Manager asks', 'Tells the management information team.'],
  ['The team checks', 'What can we already reach ourselves?'],
  ['Request goes to Cortex', 'The ask is made once, in one place.'],
  [
    'Responder agent drafts first',
    'Before the responder opens the form, their agent has read the request, drafted an answer from the data it can reach, and recorded the method.'
  ],
  ['Responder releases', 'Reviews the method and the answer, then releases it.'],
  ['Dashboard updates', 'The response feeds the dashboard.']
];

function steps(list, { highlight } = {}) {
  return `<ol class="govuk-list" style="counter-reset:s">
    ${list
      .map(
        ([t, d], i) => `<li style="display:flex;gap:15px;padding:12px 0;border-bottom:1px solid #b1b4b6${
          highlight === i ? ';background:#fff7bf;padding-left:10px' : ''
        }">
          <span style="font-size:28px;font-weight:700;color:#505a5f;min-width:44px">${String(i + 1).padStart(2, '0')}</span>
          <span>
            <strong>${esc(t)}</strong>
            <span class="cortex-src">${esc(d)}</span>
          </span>
        </li>`
      )
      .join('')}
  </ol>`;
}

export function requestsPage(ctx, { view }) {
  const nav = `
<nav aria-label="Walkthrough" style="margin-bottom:25px;border-bottom:1px solid #b1b4b6">
  <ul class="cortex-nav__list">
    ${[
      ['problem', 'The problem'],
      ['as-is', 'How it works today'],
      ['to-be', 'What Cortex changes'],
      ['safe', 'Why this is safe'],
      ['better', 'Even better if']
    ]
      .map(
        ([id, label]) =>
          `<li class="cortex-nav__item">
            <a href="/requests?view=${attr(id)}${ctx.personaQS('&')}"${view === id ? ' aria-current="page"' : ''}>${esc(label)}</a>
          </li>`
      )
      .join('')}
  </ul>
</nav>`;

  const views = {
    problem: `
      <h2 class="govuk-heading-l">Allowed the answer. Not allowed the data.</h2>
      <p class="govuk-body-l">
        The entitlement and the access do not match, and an agent inherits the access.
      </p>
      ${steps([
        ['The ask', 'A manager wants average days sick per employee.'],
        ['The entitlement', 'They are allowed to have that answer.'],
        ['The data', 'They are not allowed the individual sickness records behind it.'],
        ['The agent', 'Their AI inherits their access rights, so it cannot reach the records either.']
      ])}
      <h3 class="govuk-heading-m">Two failures</h3>
      <div class="govuk-grid-row">
        <div class="govuk-grid-column-one-half" style="width:50%;padding:0 15px">
          <h4 class="govuk-heading-s">No answer</h4>
          <p class="govuk-body">Their AI cannot give them a number they are entitled to have.</p>
        </div>
        <div class="govuk-grid-column-one-half" style="width:50%;padding:0 15px">
          <h4 class="govuk-heading-s">No quality assurance</h4>
          <p class="govuk-body">
            Even with access, the requestor is not expert enough in the data to check
            how the number was reached.
          </p>
        </div>
      </div>
      <div class="govuk-inset-text">
        <p class="govuk-body govuk-!-margin-bottom-0">
          You can see this state in the marketplace today. Any entry marked
          <strong>Answerable by a person</strong> is exactly this problem, rendered as
          a visibility state rather than a dead end.
        </p>
      </div>
      <a class="govuk-button govuk-button--secondary" href="/marketplace?vis=person${ctx.personaQS('&')}" role="button">
        Show me those entries
      </a>`,

    'as-is': `
      <h2 class="govuk-heading-l">Seven handoffs to produce one number</h2>
      <p class="govuk-body-l">This is today.</p>
      ${steps(AS_IS)}
      <h3 class="govuk-heading-m">What this costs</h3>
      <ul class="govuk-list govuk-list--bullet govuk-list--spaced">
        <li><strong>A veneer of digitisation.</strong> There is a dashboard, but the pipeline behind it is email.</li>
        <li><strong>A high cost to change.</strong> Every new question restarts the whole chain.</li>
        <li><strong>Many failure modes.</strong> Seven handoffs are seven places for a number to go wrong silently.</li>
      </ul>`,

    'to-be': `
      <h2 class="govuk-heading-l">The same request, answered before it is opened</h2>
      <p class="govuk-body-l">
        Nothing about who holds the data changes. One step moves.
      </p>
      ${steps(TO_BE, { highlight: 3 })}
      <div class="govuk-inset-text">
        <p class="govuk-body">
          <strong>One step.</strong> The work happens before the responder opens the
          request — and the method comes with the answer.
        </p>
        <p class="govuk-body govuk-!-margin-bottom-0">
          The responder still holds the data. The responder still runs the query.
          The responder still decides. What changes is that they are reviewing a
          draft rather than starting from a blank form.
        </p>
      </div>`,

    safe: `
      <h2 class="govuk-heading-l">None of the controls move. Only the drafting does.</h2>
      ${steps([
        [
          'Access management unchanged',
          'Nobody sees data they could not see before. The responder still holds it and still runs the query.'
        ],
        [
          'Quality is approved',
          'The method is recorded with the answer, and reviewed before anything is released.'
        ],
        [
          'Appropriateness is managed',
          'A person still decides whether this answer should be given at all.'
        ]
      ])}
      <p class="govuk-body-l">
        The answer is released by the person who was always accountable for it.
      </p>`,

    better: `
      <h2 class="govuk-heading-l">Each answer makes the next one cheaper</h2>
      <p class="govuk-body-l">The same request, asked twice, should not cost twice.</p>
      ${steps([
        ['Repeat it', 'The requestor sets the request to repeat, and it is issued automatically.'],
        ['Approve the method', 'The responder approves the method for a period. Answers then go out without them.'],
        [
          'Answer once, serve many',
          'Set a response to be available on request across the organisation. The next person asking already has it.'
        ],
        ['Owners see demand', 'Data owners can see what is being asked of them, and publish a live version instead.']
      ])}
      <blockquote style="border-left:5px solid #00703c;padding-left:20px;margin:25px 0">
        <p class="govuk-body-l" style="margin-bottom:8px">
          "If we published live sick days by directorate, prorated for contracted
          hours, that would prevent 80% of your requests. Would you like me to build
          it for you?"
        </p>
        <p class="govuk-body-s">Cortex, to a data owner. Illustrative, not measured.</p>
      </blockquote>
      <h3 class="govuk-heading-m">The virtuous cycle</h3>
      <p class="govuk-body">
        Remove the friction, and requests increase because asking now works. Owners
        see what is wanted and publish a live version. Manual collection shrinks and
        published data grows.
      </p>`
  };

  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-0">Requests</h1>
    <p class="govuk-body-l">
      Where "allowed the answer, not allowed the data" gets resolved.
    </p>
  </div>
</div>

<div class="govuk-inset-text">
  <p class="govuk-body">
    <strong>This is a walkthrough, not a working section.</strong> Requests is the
    strongest case in the whole proposal and the most expensive part to build
    properly — it needs a request lifecycle, a method registry, versioned approvals,
    a recurrence engine and a release workflow.
  </p>
  <p class="govuk-body govuk-!-margin-bottom-0">
    Everything else you have seen in Cortex is real and running. This is what the
    next phase buys.
  </p>
</div>

${nav}

<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    ${views[view] || views.problem}
  </div>
</div>

<hr class="govuk-section-break govuk-section-break--visible govuk-section-break--l">

<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h2 class="govuk-heading-m">The same shape, everywhere</h2>
    <p class="govuk-body">
      Build it once for management information and the pattern then serves any
      request where the answer is allowed and the data is not.
    </p>
    <ul class="govuk-list govuk-list--bullet">
      <li>Freedom of information</li>
      <li>Prime Minister's questions</li>
      <li>Spend Review 27</li>
      <li>Outcome reporting</li>
      <li>Financial requests</li>
    </ul>
    <p class="govuk-body">
      Each of these is a request, a responder who holds the data, and an answer that
      has to survive being checked.
    </p>
  </div>
</div>`;

  return layout({ ...ctx, title: 'Requests', section: 'requests' }, content);
}
