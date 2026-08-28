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
        That is ${esc(coverage.percent)}% of the estate we believe exists.
        <span class="cortex-illus">Illustrative</span>
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
