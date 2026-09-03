/**
 * Marketplace — the homepage.
 *
 * CAP-010  Land on what exists rather than an empty search box
 * CAP-015  See the visibility state and what to do next about it
 * CAP-023  Search the marketplace by name, owner or cluster
 * CAP-024  Search from any page
 * CAP-025  Filter what exists by category
 * CAP-026  Filter by cluster
 * CAP-027  Filter by quality flag
 * CAP-028  Sort the register by any column
 * CAP-029  Clear the search and filters
 * CAP-030  See the most-used things in each category without searching
 * CAP-031  See how many entries match, and that the count is illustrative
 * CAP-035  See how many cross-cluster dependencies exist
 * CAP-037  See how much of the estate is connected against what is believed to exist
 * CAP-045  See quality flags on an entry
 */

import { esc, attr, visMark, layout } from '../layout.js';
import { VIS, VIS_ORDER } from '../../bff/services/visibility.js';

const CATS = [
  ['Data', 'Sources connected through the gateway'],
  ['Skill', 'One callable thing that does one job'],
  ['Agent', 'An assistant someone has built and shared'],
  ['App', 'An existing application, registered so you can find it']
];

export const QUALITY_FLAGS = [
  ['zero use', 'Registered but never called'],
  ['stale', 'Not refreshed within its stated freshness'],
  ['unowned', 'No confirmed owner'],
  ['duplicate', 'Possible duplicate of another entry'],
  ['licence blocked', 'Licence blocks people who want it']
];

const SORTS = [
  ['name', 'Name'],
  ['-calls', 'Most used'],
  ['calls', 'Least used'],
  ['owner', 'Owner'],
  ['cat', 'Category'],
  ['fresh', 'Freshness'],
  ['vis', 'What you can do with it']
];

function checkbox(name, value, label, checked, hint) {
  const id = `${name}-${value}`.replace(/[^a-z0-9-]/gi, '');
  return `<div class="govuk-checkboxes__item">
    <input class="govuk-checkboxes__input" id="${attr(id)}" name="${attr(name)}" type="checkbox" value="${attr(value)}"${checked ? ' checked' : ''}>
    <label class="govuk-checkboxes__label" for="${attr(id)}">${esc(label)}${
      hint ? `<span class="cortex-src">${esc(hint)}</span>` : ''
    }</label>
  </div>`;
}

function entryCard(e, ctx) {
  const cluster = ctx.clusterName(e.cluster);
  return `<div class="cortex-entry">
    <div class="cortex-entry__head">
      <div style="flex:1 1 440px">
        <h3 class="cortex-entry__title">
          <a class="govuk-link" href="/entry/${attr(e.id)}">${esc(e.name)}</a>
        </h3>
        <p class="cortex-entry__meta">
          ${esc(e.cat)} · ${esc(cluster)} · ${esc(e.owner)}${
            e.ownerState === 'proposed' ? ' <strong>(owner proposed, not confirmed)</strong>' : ''
          }
        </p>
        ${
          e.flags?.length
            ? `<p style="margin:0 0 8px">${e.flags
                .map(
                  (f) =>
                    `<strong class="govuk-tag govuk-tag--orange" style="margin-right:6px">${esc(f)}</strong>`
                )
                .join('')}</p>`
            : ''
        }
        <p class="cortex-entry__desc">${esc(e.desc)}</p>
        <div class="cortex-entry__foot">
          <span>Updated: ${esc(e.fresh)}</span>
          <span>${esc(e.sens)}</span>
          ${e.calls ? `<span>${Number(e.calls).toLocaleString('en-GB')} calls</span>` : ''}
          ${e._endpoints?.mcp ? '<span><strong>MCP</strong> endpoint</span>' : ''}
          ${e.catalogueStatus && e.catalogueStatus !== 'Published' ? '<span><strong class="govuk-tag govuk-tag--grey">Draft in Purview</strong></span>' : ''}
        </div>
      </div>
      <div style="flex:0 0 230px">
        ${visMark(e.vis)}
        <p class="cortex-src" style="margin-top:6px">${esc(e.visReason || '')}</p>
        <p class="govuk-body-s" style="margin-top:8px;margin-bottom:0">
          <a class="govuk-link" href="/entry/${attr(e.id)}">${esc(VIS[e.vis]?.next || 'Open')}</a>
        </p>
      </div>
    </div>
  </div>`;
}

/** CAP-030 — the most-used thing in each category, without searching for it. */
function mostUsed(byCat, ctx) {
  const cards = Object.entries(byCat || {})
    .filter(([, e]) => e)
    .map(
      ([cat, e]) => `
      <div class="cortex-stat" style="flex:1 1 220px">
        <span class="govuk-caption-m" style="font-size:16px">${esc(cat)}</span>
        <p class="govuk-body" style="margin:4px 0 2px">
          <a class="govuk-link" href="/entry/${attr(e.id)}"><strong>${esc(e.name)}</strong></a>
        </p>
        <span class="cortex-stat__l">${Number(e.calls || 0).toLocaleString('en-GB')} calls</span>
      </div>`
    )
    .join('');
  if (!cards) return '';
  return `<h2 class="govuk-heading-m">Most used in each category</h2>
    <div class="cortex-stats">${cards}</div>`;
}

export function marketplacePage(
  ctx,
  { entries, filters, total, coverage, cross, byCatMostUsed, showMostUsed }
) {
  const selCats = filters.cats || [];
  const selClusters = filters.clusters || [];
  const selVis = filters.visStates || [];
  const selFlags = filters.flags || [];
  const isFiltered =
    filters.q || selCats.length || selClusters.length || selVis.length || selFlags.length;

  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-0">Marketplace</h1>
    <p class="govuk-body-l">What Defra already has: data, skills, agents and apps you can find, use and build with.</p>
  </div>
  <div class="govuk-grid-column-one-third">
    <p class="govuk-body" style="text-align:right;margin-top:20px">
      <strong>List</strong> ·
      <a class="govuk-link" href="/marketplace/map">Map</a>
    </p>
  </div>
</div>

<div class="cortex-stats">
  <div class="cortex-stat">
    <span class="cortex-stat__n">${esc(total)}</span>
    <span class="cortex-stat__l">entries registered</span>
  </div>
  <div class="cortex-stat">
    <span class="cortex-stat__n">${esc(Object.keys(coverage.byDomain || {}).length)}</span>
    <span class="cortex-stat__l">governance domains with something registered in them</span>
  </div>
  <div class="cortex-stat">
    <span class="cortex-stat__n">${esc(cross.count)}</span>
    <span class="cortex-stat__l">cross-cluster dependencies, counted from the register itself.
      The count over time is the honest test of whether the programme is working.</span>
  </div>
</div>

${
  cross.unresolved
    ? `<div class="govuk-inset-text">
         <p class="govuk-body govuk-!-margin-bottom-0">
           A further <strong>${esc(cross.unresolved)}</strong> dependencies point at systems
           that are not in the register at all. Those are the connections nobody can
           currently see, and closing that gap is what registering the rest of the
           estate buys you.
         </p>
       </div>`
    : ''
}

${showMostUsed ? mostUsed(byCatMostUsed, ctx) : ''}

<form method="get" action="/marketplace">
${ctx.query?.persona ? `<input type="hidden" name="persona" value="${attr(ctx.query.persona)}">` : ''}
<div class="govuk-grid-row">
  <div class="govuk-grid-column-one-third">
    <div class="cortex-filters">
      <h2 class="govuk-heading-m">Filter</h2>

      <div class="govuk-form-group">
        <label class="govuk-label govuk-label--s" for="q">Search</label>
        <div class="govuk-hint" style="font-size:16px">Name, description, owner or cluster</div>
        <input class="govuk-input" id="q" name="q" type="search" value="${attr(filters.q || '')}">
      </div>

      <div class="cortex-filters__group">
        <fieldset class="govuk-fieldset">
          <legend class="govuk-fieldset__legend"><strong>Category</strong></legend>
          <div class="govuk-checkboxes govuk-checkboxes--small">
            ${CATS.map(([c, hint]) => checkbox('cat', c, c, selCats.includes(c), hint)).join('')}
          </div>
        </fieldset>
      </div>

      <div class="cortex-filters__group">
        <fieldset class="govuk-fieldset">
          <legend class="govuk-fieldset__legend"><strong>Cluster</strong></legend>
          <div class="govuk-checkboxes govuk-checkboxes--small">
            ${ctx.clusters
              .map((c) => checkbox('cluster', c.id, c.name, selClusters.includes(c.id), c.owner))
              .join('')}
          </div>
        </fieldset>
      </div>

      <div class="cortex-filters__group">
        <fieldset class="govuk-fieldset">
          <legend class="govuk-fieldset__legend"><strong>What you can do with it</strong></legend>
          <div class="govuk-checkboxes govuk-checkboxes--small">
            ${VIS_ORDER.map((v) => checkbox('vis', v, VIS[v].label, selVis.includes(v))).join('')}
          </div>
        </fieldset>
      </div>

      <div class="cortex-filters__group">
        <fieldset class="govuk-fieldset">
          <legend class="govuk-fieldset__legend"><strong>Quality flag</strong></legend>
          <div class="govuk-checkboxes govuk-checkboxes--small">
            ${QUALITY_FLAGS.map(([f, hint]) =>
              checkbox('flag', f, f, selFlags.includes(f), hint)
            ).join('')}
          </div>
        </fieldset>
      </div>

      <button class="govuk-button govuk-!-margin-bottom-0" type="submit">Apply filters</button>
      ${
        isFiltered
          ? `<p class="govuk-body-s" style="margin-top:12px;margin-bottom:0">
               <a class="govuk-link" href="/marketplace">Clear the search and filters</a>
             </p>`
          : ''
      }
    </div>
  </div>

  <div class="govuk-grid-column-two-thirds">
    <div class="cortex-results-head">
      <h2 class="govuk-heading-m govuk-!-margin-bottom-0">
        ${esc(entries.length)}${entries.length === total ? '' : ` of ${esc(total)}`} entries
      </h2>
      <div>
        <label class="govuk-label" style="display:inline;font-size:16px" for="sort">Sort by</label>
        <select class="govuk-select" id="sort" name="sort" style="width:auto" onchange="this.form.submit()">
          ${SORTS.map(
            ([v, l]) =>
              `<option value="${attr(v)}"${filters.sort === v ? ' selected' : ''}>${esc(l)}</option>`
          ).join('')}
        </select>
        <noscript><button class="govuk-button govuk-button--secondary govuk-!-margin-bottom-0" type="submit">Sort</button></noscript>
      </div>
    </div>

    ${
      entries.length
        ? entries.map((e) => entryCard(e, ctx)).join('')
        : `<div class="govuk-inset-text">
             <h3 class="govuk-heading-s">Nothing matches those filters</h3>
             <p class="govuk-body">
               That may mean it does not exist. It may also mean it exists and nobody
               has registered it — which is the more common of the two.
             </p>
             <p class="govuk-body govuk-!-margin-bottom-0">
               <a class="govuk-link" href="/marketplace">Clear the filters</a>
               or <a class="govuk-link" href="/share">tell us about something that is missing</a>
             </p>
           </div>`
    }
  </div>
</div>
</form>`;

  return layout({ ...ctx, title: 'Marketplace', section: 'marketplace' }, content);
}

export default marketplacePage;
