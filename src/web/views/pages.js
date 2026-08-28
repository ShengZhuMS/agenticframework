/**
 * Start page, a minimal entry page, help, and honest placeholders for the
 * sections that later work packages build out.
 *
 * The placeholders name their work package rather than pretending to be
 * finished. A demo that says "this is next" is stronger than a dead link.
 */

import { esc, attr, visMark, layout } from '../layout.js';
import { VIS } from '../../bff/services/visibility.js';

export function startPage(ctx, { stats, coverage }) {
  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl">Cortex</h1>
    <p class="govuk-body-l">
      One place to find what Defra already has, build something with it,
      and share what you build.
    </p>
    <p class="govuk-body">
      Purview, API Management and Foundry are already live in the landing zone.
      Cortex is the front door to them, and the connections between them.
    </p>
    <a class="govuk-button" href="/marketplace" role="button">Start now</a>

    <h2 class="govuk-heading-m">Before you start</h2>
    <ul class="govuk-list govuk-list--bullet">
      <li><strong>Nothing is copied.</strong> Cortex connects to data where it lives. There is no upload and no file picker.</li>
      <li><strong>Your access does not change.</strong> You will never see data you could not already see, and an agent you build can never reach further than you can.</li>
      <li><strong>What you build becomes a part others can build with.</strong> That is the point.</li>
    </ul>
  </div>
  <div class="govuk-grid-column-one-third">
    <div class="cortex-filters">
      <h2 class="govuk-heading-m">The register today</h2>
      <p class="govuk-body">
        <strong style="font-size:36px">${esc(stats.entries)}</strong><br>
        entries registered
      </p>
      <p class="govuk-body-s">
        ${Object.entries(stats.byCat)
          .map(([k, v]) => `${esc(v)} ${esc(k.toLowerCase())}`)
          .join(' · ')}
      </p>
      <p class="govuk-body-s">
        Across ${esc(Object.keys(coverage.byDomain || {}).length)} governance domains.
      </p>
    </div>
  </div>
</div>`;
  return layout({ ...ctx, title: 'Start', section: null }, content);
}

export function placeholderPage(ctx, { heading, section, lede, wp, bullets = [] }) {
  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-0">${esc(heading)}</h1>
    <p class="govuk-body-l">${esc(lede)}</p>

    <div class="govuk-inset-text">
      <p class="govuk-body govuk-!-margin-bottom-0">
        <strong>Not built yet.</strong> This section is ${esc(wp)} in the build plan.
        The shell, navigation and register underneath it are working now.
      </p>
    </div>

    ${
      bullets.length
        ? `<h2 class="govuk-heading-m">What this will do</h2>
           <ul class="govuk-list govuk-list--bullet govuk-list--spaced">
             ${bullets.map((b) => `<li>${esc(b)}</li>`).join('')}
           </ul>`
        : ''
    }

    <a class="govuk-button govuk-button--secondary" href="/marketplace" role="button">Back to the marketplace</a>
  </div>
</div>`;
  return layout({ ...ctx, title: heading, section }, content);
}

export function helpPage(ctx, { stats, health }) {
  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl">Help</h1>

    <h2 class="govuk-heading-m">What Cortex can do today</h2>
    <ul class="govuk-list govuk-list--bullet govuk-list--spaced">
      <li>Show you what exists across ${esc(stats.clusters)} clusters, with an honest statement of who can use each thing.</li>
      <li>Show you the full entry standard for anything registered, including where each field came from and who maintains it.</li>
    </ul>

    <h2 class="govuk-heading-m">What it cannot do yet</h2>
    <ul class="govuk-list govuk-list--bullet govuk-list--spaced">
      <li>It cannot write to a source system, and no agent built in it can.</li>
      <li>It cannot send anything outside Defra.</li>
      <li>It does not hold data. If something is not connected, Cortex cannot reach it.</li>
      <li>The estate shown is a thin slice, deliberately.</li>
    </ul>

    <h2 class="govuk-heading-m">Service status</h2>
    <dl class="govuk-summary-list">
      ${Object.entries(health)
        .map(
          ([k, v]) =>
            `<div class="govuk-summary-list__row">
              <dt class="govuk-summary-list__key">${esc(k)}</dt>
              <dd class="govuk-summary-list__value">
                <strong class="govuk-tag govuk-tag--${v.ok ? 'green' : 'red'}">${v.ok ? 'Working' : 'Unavailable'}</strong>
                <span class="cortex-src">${esc(v.mode || '')}${v.error ? ' — ' + esc(v.error) : ''}</span>
              </dd>
            </div>`
        )
        .join('')}
    </dl>
  </div>
</div>`;
  return layout({ ...ctx, title: 'Help', section: 'help' }, content);
}

export function errorPage(ctx, { code, heading, message }) {
  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl">${esc(heading)}</h1>
    <p class="govuk-body-l">${esc(message)}</p>
    <p class="govuk-body"><a class="govuk-link" href="/marketplace">Go to the marketplace</a></p>
  </div>
</div>`;
  return layout({ ...ctx, title: heading, section: null }, content);
}

/**
 * "What can I see?" — the page that explains an empty-looking Marketplace.
 *
 * The most common support question in a group-driven access model is "why
 * can't I see anything?", and the answer is almost always that the groups
 * claim is missing or the person is in fewer groups than they expect. Showing
 * it plainly turns a mystery into a self-service answer.
 */
export function profilePage(ctx, { counts }) {
  const u = ctx.user;
  const realGroups = (u.groups || []).filter((g) => !/^[0-9a-f-]{36}$/i.test(g));
  const rawIds = (u.groups || []).filter((g) => /^[0-9a-f-]{36}$/i.test(g));

  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-0">What can I see?</h1>
    <p class="govuk-body-l">
      Your access comes from your Microsoft Entra group membership. Nothing in
      Cortex grants access on its own.
    </p>

    <dl class="govuk-summary-list">
      <div class="govuk-summary-list__row">
        <dt class="govuk-summary-list__key">Signed in as</dt>
        <dd class="govuk-summary-list__value">${esc(u.name)}${u.email ? `<span class="cortex-src">${esc(u.email)}</span>` : ''}</dd>
      </div>
      <div class="govuk-summary-list__row">
        <dt class="govuk-summary-list__key">Team</dt>
        <dd class="govuk-summary-list__value">${esc(u.team)}</dd>
      </div>
      <div class="govuk-summary-list__row">
        <dt class="govuk-summary-list__key">Clearance</dt>
        <dd class="govuk-summary-list__value">${esc(u.clearance)}
          <span class="cortex-src">From membership of the cleared group, not set here.</span></dd>
      </div>
      <div class="govuk-summary-list__row">
        <dt class="govuk-summary-list__key">Licences you are covered by</dt>
        <dd class="govuk-summary-list__value">${esc((u.licences || []).join(', ') || 'None')}</dd>
      </div>
    </dl>

    <h2 class="govuk-heading-m">Your groups</h2>
    ${
      realGroups.length
        ? `<ul class="govuk-list govuk-list--bullet">
             ${realGroups.map((g) => `<li>${esc(g)}</li>`).join('')}
           </ul>`
        : `<div class="govuk-warning-text">
             <span class="govuk-warning-text__icon" aria-hidden="true">!</span>
             <strong class="govuk-warning-text__text">
               <span class="govuk-skip-link">Warning</span>
               You appear to be in no named groups. If the Marketplace looks almost
               empty, this is why.
             </strong>
           </div>
           <p class="govuk-body">
             Either you are genuinely in no groups, or the sign-in app registration
             is not emitting a <strong>groups</strong> claim, or the group object ids
             it emits have not been mapped to names. All three are fixed in
             configuration, not in Cortex.
           </p>`
    }
    ${
      rawIds.length
        ? `<h3 class="govuk-heading-s">Unmapped group ids</h3>
           <p class="govuk-body-s">
             Entra sent ${esc(rawIds.length)} group ids with no name mapped to them.
             Access rules written against names will not match these. Map them with
             <code>CORTEX_GROUP_NAMES</code>.
           </p>
           <ul class="govuk-list govuk-list--bullet">
             ${rawIds.map((g) => `<li><code style="font-size:15px">${esc(g)}</code></li>`).join('')}
           </ul>`
        : ''
    }

    <h2 class="govuk-heading-m">What that gets you</h2>
    <table class="govuk-table">
      <thead>
        <tr>
          <th scope="col" class="govuk-table__header">State</th>
          <th scope="col" class="govuk-table__header govuk-table__header--numeric">Entries</th>
        </tr>
      </thead>
      <tbody>
        ${Object.entries(counts)
          .map(
            ([label, n]) => `<tr class="govuk-table__row">
              <td class="govuk-table__cell">${esc(label)}</td>
              <td class="govuk-table__cell govuk-table__cell--numeric">${esc(n)}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>
    <p class="govuk-body">
      <a class="govuk-link" href="/marketplace">Back to the marketplace</a>
    </p>
  </div>
</div>`;
  return layout({ ...ctx, title: 'What can I see?', section: null }, content);
}
