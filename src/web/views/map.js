/**
 * The estate as a map.
 *
 * CAP-032  Switch between list and map
 * CAP-033  See the estate as a map of clusters and dependencies
 * CAP-034  See entries that belong to no cluster
 * CAP-035  See how many cross-cluster dependencies exist
 * CAP-036  Browse by cluster and see its owner and contents
 * CAP-037  See how much of the estate is connected against what is believed
 * CAP-038  See coverage by category and how the estimate was made
 *
 * Drawn as inline SVG with a text alternative underneath, because a picture
 * that only works for sighted mouse users fails the accessibility gate that
 * this same product tells people to care about.
 */

import { esc, attr, layout } from '../layout.js';

export function mapPage(ctx, { clusters, links, cross, coverage, counts, unclustered }) {
  const svg = `
<svg viewBox="0 0 1120 680" width="100%" height="auto" role="img"
     aria-labelledby="map-title map-desc" style="max-width:100%;border:1px solid #b1b4b6;background:#fff">
  <title id="map-title">Map of the Defra data estate by cluster</title>
  <desc id="map-desc">
    Nine clusters drawn as circles sized by how much each contains, with lines
    showing dependencies that cross between them. The same information is in the
    table below this image.
  </desc>
  ${links
    .map((l) => {
      const A = clusters.find((c) => c.id === l.from);
      const B = clusters.find((c) => c.id === l.to);
      if (!A || !B) return '';
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      return `<line x1="${(A.x + ux * A.r).toFixed(1)}" y1="${(A.y + uy * A.r).toFixed(1)}"
                    x2="${(B.x - ux * B.r).toFixed(1)}" y2="${(B.y - uy * B.r).toFixed(1)}"
                    stroke="#505a5f" stroke-width="2" stroke-dasharray="4 3" />`;
    })
    .join('')}
  ${clusters
    .map(
      (c) => `<g>
        <circle cx="${c.x}" cy="${c.y}" r="${c.r}" fill="#f3f2f1" stroke="#0b0c0c" stroke-width="2" />
        <text x="${c.x}" y="${c.y - 8}" text-anchor="middle" font-size="15" font-weight="700" fill="#0b0c0c">${esc(
          c.name.length > 20 ? c.name.slice(0, 19) + '…' : c.name
        )}</text>
        <text x="${c.x}" y="${c.y + 12}" text-anchor="middle" font-size="22" font-weight="700" fill="#505a5f">${esc(
          counts[c.id] || 0
        )}</text>
        <text x="${c.x}" y="${c.y + 30}" text-anchor="middle" font-size="12" fill="#505a5f">registered</text>
      </g>`
    )
    .join('')}
</svg>`;

  const content = `
<div class="govuk-grid-row">
  <div class="govuk-grid-column-two-thirds">
    <h1 class="govuk-heading-xl govuk-!-margin-bottom-0">Map</h1>
    <p class="govuk-body-l">
      The same entries, arranged by cluster. Lines are dependencies that cross
      between clusters.
    </p>
  </div>
  <div class="govuk-grid-column-one-third">
    <p class="govuk-body" style="text-align:right;margin-top:20px">
      <a class="govuk-link" href="/marketplace">List</a> ·
      <strong>Map</strong>
    </p>
  </div>
</div>

<div class="cortex-stats">
  <div class="cortex-stat">
    <span class="cortex-stat__n">${esc(coverage.registered)}</span>
    <span class="cortex-stat__l">entries across ${esc(clusters.length)} clusters</span>
  </div>
  <div class="cortex-stat">
    <span class="cortex-stat__n">${esc(cross.unresolved)}</span>
    <span class="cortex-stat__l">dependencies pointing at systems that are not registered</span>
  </div>
  <div class="cortex-stat">
    <span class="cortex-stat__n">${esc(cross.count)}</span>
    <span class="cortex-stat__l">cross-cluster dependencies</span>
  </div>
</div>

${svg}

<p class="govuk-hint">
  Positions are arranged for legibility, not geography. Circle size reflects how
  much is registered in each domain.
</p>

<div class="govuk-inset-text">
  <p class="govuk-body govuk-!-margin-bottom-0">
    <strong>${esc(cross.count)} cross-cluster dependencies</strong> are visible here, and a further
    <strong>${esc(cross.unresolved)}</strong> point at systems that are not registered at all.
    Cross-cluster dependency is the programme measure that matters most: the count
    over time is the honest test of whether the department is joining up.
  </p>
</div>

<h2 class="govuk-heading-m">Every cluster</h2>
<table class="govuk-table">
  <caption class="govuk-table__caption">The text alternative to the map above.</caption>
  <thead>
    <tr>
      <th scope="col" class="govuk-table__header">Cluster</th>
      <th scope="col" class="govuk-table__header">Owner</th>
      <th scope="col" class="govuk-table__header govuk-table__header--numeric">Registered</th>
      <th scope="col" class="govuk-table__header">Depends on</th>
    </tr>
  </thead>
  <tbody>
    ${clusters
      .map((c) => {
        const out = [...new Set(links.filter((l) => l.from === c.id).map((l) => l.to))];
        const inn = [...new Set(links.filter((l) => l.to === c.id).map((l) => l.from))];
        const name = (id) => clusters.find((x) => x.id === id)?.name || id;
        return `<tr class="govuk-table__row">
          <td class="govuk-table__cell">
            <a class="govuk-link" href="/marketplace?cluster=${attr(c.id)}">${esc(c.name)}</a>
          </td>
          <td class="govuk-table__cell">
            ${esc(c.owner)}${c.owner === 'Not claimed' ? ' <strong class="govuk-tag govuk-tag--orange">Unclaimed</strong>' : ''}
          </td>
          <td class="govuk-table__cell govuk-table__cell--numeric">${esc(counts[c.id] || 0)}</td>
          <td class="govuk-table__cell">
            ${out.length ? esc(out.map(name).join(', ')) : '<span class="govuk-hint" style="display:inline">None recorded</span>'}
            ${inn.length ? `<span class="cortex-src">Depended on by: ${esc(inn.map(name).join(', '))}</span>` : ''}
          </td>
        </tr>`;
      })
      .join('')}
  </tbody>
</table>

${
  unclustered.length
    ? `<h2 class="govuk-heading-m">Belonging to no cluster</h2>
       <p class="govuk-body">${esc(unclustered.length)} entries have no cluster assigned.</p>
       <ul class="govuk-list govuk-list--bullet">
         ${unclustered
           .map(
             (e) => `<li><a class="govuk-link" href="/entry/${attr(e.id)}">${esc(e.name)}</a></li>`
           )
           .join('')}
       </ul>`
    : ''
}

<h2 class="govuk-heading-m">What is registered, by category</h2>
<p class="govuk-hint">
  This is a count of what is registered, not an estimate of what exists. How much
  of the estate remains unregistered is genuinely unknown, and saying so is more
  useful than a percentage nobody can produce evidence for.
</p>
<table class="govuk-table">
  <thead>
    <tr>
      <th scope="col" class="govuk-table__header">Category</th>
      <th scope="col" class="govuk-table__header govuk-table__header--numeric">Registered</th>
    </tr>
  </thead>
  <tbody>
    ${Object.entries(coverage.byCat || {})
      .map(
        ([cat, n]) => `<tr class="govuk-table__row">
          <td class="govuk-table__cell">
            <a class="govuk-link" href="/marketplace?cat=${attr(cat)}">${esc(cat)}</a>
          </td>
          <td class="govuk-table__cell govuk-table__cell--numeric">${esc(n)}</td>
        </tr>`
      )
      .join('')}
  </tbody>
</table>`;

  return layout({ ...ctx, title: 'Map', section: 'marketplace' }, content);
}
