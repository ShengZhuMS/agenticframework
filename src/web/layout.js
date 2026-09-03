/**
 * Page shell — GOV.UK Design System with a Defra masthead.
 *
 * WP1. Everything a page needs to sit inside: skip link, header, phase
 * banner, service navigation, persona switcher, footer.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIS } from '../bff/services/visibility.js';

/**
 * Prefer the official GOV.UK Design System assets when `npm install` has
 * vendored them (scripts/build-assets.js). Fall back to the bundled
 * stylesheet otherwise, so the app always renders — a missing build step
 * should degrade the typography, never the service.
 *
 * Resolved once at module load, not per request.
 */
const ASSET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'assets');
export const GOVUK_VENDORED = existsSync(path.join(ASSET_ROOT, 'vendor', 'govuk-frontend.min.css'));

export const NAV = [
  ['/marketplace', 'Marketplace', 'marketplace'],
  ['/ask', 'Ask a question', 'ask'],
  ['/build', 'Build an agent', 'build'],
  ['/share', 'Share your data', 'share'],
  ['/requests', 'Requests', 'requests'],
  ['/automate', 'Automate a task', 'automate']
];

/** Escape untrusted values for HTML. Every interpolation goes through this. */
export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function attr(s) {
  return esc(s);
}

/** The Royal Arms crown, as used in the GOV.UK header. */
const CROWN = `<svg class="govuk-header__crown" xmlns="http://www.w3.org/2000/svg" height="30" width="36" viewBox="0 0 132 97" fill="currentColor" focusable="false" aria-hidden="true">
<path d="M25 30.2c3.5 1.5 7.7-.2 9.1-3.7 1.5-3.6-.2-7.8-3.9-9.2-3.6-1.4-7.6.3-9.1 3.9-1.4 3.5.3 7.5 3.9 9zM9 39.5c3.6 1.5 7.8-.2 9.2-3.7 1.5-3.6-.2-7.8-3.9-9.1-3.6-1.5-7.6.2-9.1 3.8-1.4 3.5.3 7.5 3.8 9zM4.4 57.2c3.5 1.5 7.7-.2 9.1-3.8 1.5-3.6-.2-7.8-3.8-9.1-3.6-1.5-7.7.2-9.1 3.8-1.5 3.6.2 7.6 3.8 9.1zm38.3-21.4c3.5 1.5 7.7-.2 9.1-3.8 1.5-3.6-.2-7.8-3.8-9.1-3.6-1.5-7.7.2-9.1 3.8-1.5 3.6.2 7.6 3.8 9.1zm64.4-5.6c-3.6 1.5-7.8-.2-9.1-3.7-1.5-3.6.2-7.8 3.8-9.2 3.6-1.4 7.7.3 9.2 3.9 1.3 3.5-.4 7.5-3.9 9zm15.9 9.3c-3.6 1.5-7.7-.2-9.1-3.7-1.5-3.6.2-7.8 3.7-9.1 3.6-1.5 7.7.2 9.2 3.8 1.5 3.5-.3 7.5-3.8 9zm4.7 17.7c-3.6 1.5-7.8-.2-9.2-3.8-1.5-3.6.2-7.8 3.9-9.1 3.6-1.5 7.7.2 9.1 3.8 1.4 3.6-.3 7.6-3.8 9.1zM89.3 35.8c-3.6 1.5-7.8-.2-9.2-3.8-1.4-3.6.2-7.8 3.9-9.1 3.6-1.5 7.7.2 9.1 3.8 1.4 3.6-.3 7.6-3.8 9.1zM69.7 17.7l8.9 4.7V9.3l-8.9 2.8c-.2-.3-.5-.6-.9-.9L72.4 0H59.6l3.5 11.2c-.3.3-.6.5-.9.9l-8.8-2.8v13.1l8.8-4.7c.3.3.6.5.9.8l-5 15.4v.1c-.2.8-.4 1.6-.4 2.4 0 4.1 3.1 7.5 7 8.1h.2c.3 0 .7.1 1 .1.4 0 .7 0 1-.1h.2c4-.6 7.1-4 7.1-8.1 0-.8-.1-1.7-.4-2.4V34l-5.1-15.4c.4-.2.7-.5 1-.9zM66 92.8c16.9 0 32.8 1.1 47.1 3.2 4-16.9 8.9-26.7 14-33.5l-9.6-3.4c1 4.9 1.1 7.2 0 10.2-1.5-1.4-3-4.3-4.2-8.7L108.6 76c2.8-2 5-3.2 7.5-3.3-4.4 9.4-10 11.9-13.6 11.2-4.3-.8-6.3-4.6-5.6-7.9 1-4.7 5.7-5.9 8-.5 4.3-8.7-3-11.4-7.6-8.8 7.1-7.2 7.9-13.5 2.1-21.1-8 6.1-8.1 12.3-4.5 20.8-4.7-5.4-12.1-2.5-9.5 6.2 3.4-5.2 7.9-2 7.2 3.1-.6 4.3-6.4 7.8-13.5 7.2-10.3-.9-10.9-8-11.2-13.8 2.5-.5 7.1 1.8 11 7.3L80.2 60c-4.1 4.4-8 5.3-12.3 5.4 1.4-4.4 8-11.6 8-11.6H55.5s6.4 7.2 7.9 11.6c-4.2-.1-8-1-12.3-5.4l1.4 16.4c3.9-5.5 8.5-7.7 10.9-7.3-.3 5.8-.9 12.8-11.1 13.8-7.2.6-12.9-2.9-13.5-7.2-.8-5.1 3.7-8.3 7.1-3.1 2.6-8.7-4.8-11.6-9.4-6.2 3.5-8.5 3.4-14.7-4.5-20.8-5.9 7.6-5.1 13.9 2.1 21.1-4.7-2.6-11.9.1-7.7 8.8 2.3-5.5 7.1-4.2 8.1.5.7 3.3-1.3 7.1-5.7 7.9-3.5.7-9-1.8-13.5-11.2 2.5.1 4.7 1.3 7.5 3.3l-4.7-15.4c-1.2 4.4-2.7 7.2-4.3 8.7-1.1-3-.9-5.3 0-10.2l-9.5 3.4c5 6.9 9.9 16.7 14 33.5 14.8-2.1 30.8-3.2 47.7-3.2z"></path>
</svg>`;

/**
 * Who is signed in, and what that means for what they can see.
 *
 * Group membership is the whole governance model, so it is shown rather than
 * hidden: a user who cannot see something needs to be able to work out why,
 * and "you are in these groups" is the answer to almost every such question.
 */
function identityBar(ctx) {
  if (!ctx.user) return '';
  const groups = (ctx.user.groups || []).filter((g) => !/^[0-9a-f-]{36}$/i.test(g));
  return `
<div class="cortex-identity">
  <div class="govuk-width-container cortex-identity__inner">
    <span class="cortex-identity__who">
      Signed in as <strong>${esc(ctx.user.name)}</strong>
    </span>
    <span class="cortex-identity__meta">
      ${esc(ctx.user.team)} · cleared to ${esc(ctx.user.clearance)}
      ${groups.length ? ` · ${esc(groups.length)} group${groups.length > 1 ? 's' : ''}` : ' · no groups'}
    </span>
    <a class="govuk-link cortex-identity__link" href="/profile">What can I see?</a>
    <a class="govuk-link cortex-identity__link" href="/.auth/logout">Sign out</a>
  </div>
</div>`;
}

function nav(active) {
  return `
<nav class="cortex-nav" aria-label="Sections">
  <div class="govuk-width-container">
    <ul class="cortex-nav__list">
      ${NAV.map(
        ([href, label, id]) =>
          `<li class="cortex-nav__item"><a href="${attr(href)}"${
            id === active ? ' aria-current="page"' : ''
          }>${esc(label)}</a></li>`
      ).join('')}
      <li class="cortex-nav__item cortex-nav__item--right"><a href="/help"${
        active === 'help' ? ' aria-current="page"' : ''
      }>Help</a></li>
    </ul>
  </div>
</nav>`;
}

/** The six visibility marks — shape plus text label, never colour alone. */
export function visMark(state, { withLabel = true } = {}) {
  const meta = VIS[state];
  if (!meta) return '';
  return `<span class="cortex-vis">
    <span class="cortex-vis__mark cortex-vis__mark--${attr(meta.mark)}" aria-hidden="true"></span>
    ${withLabel ? `<span>${esc(meta.label)}</span>` : ''}
  </span>`;
}

export function layout(ctx, content) {
  const title = ctx.title ? `${ctx.title} — Cortex` : 'Cortex';
  return `<!DOCTYPE html>
<html lang="en" class="govuk-template">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0c0c">
<meta name="description" content="Cortex — one place to find what Defra already has, build something with it, and share what you build.">
${
  GOVUK_VENDORED
    ? '<link rel="stylesheet" href="/assets/vendor/govuk-frontend.min.css">'
    : ''
}<link rel="stylesheet" href="/assets/cortex.css">
</head>
<body class="govuk-template__body${GOVUK_VENDORED ? ' js-enabled govuk-frontend-supported' : ''}">
<a href="#main-content" class="govuk-skip-link">Skip to main content</a>

<header class="govuk-header" role="banner">
  <div class="govuk-width-container govuk-header__container">
    <div class="govuk-header__logo">
      <a href="/" class="govuk-header__link--homepage">
        ${CROWN}
        <span>GOV.UK</span>
      </a>
    </div>
    <div class="govuk-header__product">
      <b>Cortex</b>
      <span>Data Driven Defra</span>
    </div>
    <div class="govuk-header__org">Department for Environment, Food &amp; Rural Affairs</div>
    <form class="govuk-header__search" method="get" action="/marketplace" role="search">
      <label class="govuk-skip-link" for="site-search">Search the marketplace</label>
      <input id="site-search" type="search" name="q" placeholder="Search" value="${attr(ctx.query?.q || '')}">
      <button type="submit">Search</button>
    </form>
  </div>
</header>

${nav(ctx.section)}
${identityBar(ctx)}

<div class="govuk-width-container">
  <div class="govuk-phase-banner">
    <p class="govuk-phase-banner__content">
      <strong class="govuk-tag">Alpha</strong>
      <span>This is a prototype created by CCoE for SIT. For technical queries and bug reporting, please contact the sheng.zhu@defra.gov.uk</span>
    </p>
  </div>

  <main class="govuk-main-wrapper" id="main-content" role="main" tabindex="-1">
    ${content}

    <div class="cortex-feedback">
      <form method="post" action="/feedback">
        <input type="hidden" name="page" value="${attr(ctx.path)}">
        <span>Was this page useful?</span>
        <button class="govuk-link" style="border:0;background:none;cursor:pointer;padding:0 4px" name="useful" value="yes" type="submit">Yes</button>
        <button class="govuk-link" style="border:0;background:none;cursor:pointer;padding:0 4px" name="useful" value="no" type="submit">No</button>
      </form>
    </div>
  </main>
</div>

<footer class="govuk-footer" role="contentinfo">
  <div class="govuk-width-container">
    <div class="govuk-footer__meta">
      <div>
        <ul class="govuk-footer__inline-list">
          <li><a class="govuk-link" href="/help">Help</a></li>
          <li><a class="govuk-link" href="/help/accessibility">Accessibility statement</a></li>
          <li><a class="govuk-link" href="/help/privacy">Privacy</a></li>
        </ul>
        <p class="govuk-body-s govuk-!-margin-bottom-0">
          Cortex connects to data where it lives. Nothing is copied and nothing moves.
        </p>
      </div>
      <div>
        <p class="govuk-body-s govuk-!-margin-bottom-0">
          Register last refreshed ${esc(ctx.lastRefresh || 'not yet')}
        </p>
      </div>
    </div>
  </div>
</footer>
</body>
</html>`;
}

export default layout;
