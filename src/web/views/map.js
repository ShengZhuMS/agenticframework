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

const palette = ['#0067b8', '#007f73', '#6845a5', '#9a4f00', '#a42668', '#395b80'];
export function domainColour(id) {
  const hash = [...String(id)].reduce((sum, ch) => ((sum * 31) + ch.charCodeAt(0)) >>> 0, 0);
  return palette[hash % palette.length];
}

export function layoutDomains(domains, counts) {
  const sorted = [...domains].sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id));
  const columns = Math.min(4, Math.max(1, sorted.length));
  const width = columns * 280;
  const height = Math.max(240, Math.ceil(sorted.length / columns) * 240);
  const maximum = Math.max(1, ...sorted.map((c) => counts[c.id] || 0));
  return {
    width, height,
    clusters: sorted.map((c, i) => ({
      ...c,
      x: (i % columns) * 280 + 140,
      y: Math.floor(i / columns) * 240 + 120,
      r: 32 + 40 * Math.sqrt((counts[c.id] || 0) / maximum),
      colour: domainColour(c.id)
    }))
  };
}

export function mapPage(ctx, { clusters: domains, links, cross, coverage, counts, unclustered, errors = {} }) {
  // Purview returns metadata, not the coordinates the retired seed pack supplied.
  const { clusters, width, height } = layoutDomains(domains, counts);
  const svg = `
<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
     aria-labelledby="map-title map-desc" class="cx-estate-map">
  <title id="map-title">Map of the data estate by governance domain</title>
  <desc id="map-desc">
    ${clusters.length} domains drawn as circles sized by how much each contains, with lines
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
      (c) => `<a href="/cortex?cluster=${attr(encodeURIComponent(c.id))}" aria-label="${attr(c.name)}: ${counts[c.id] || 0} registered entries"><g>
        <title>${esc(c.name)}</title>
        <circle cx="${c.x}" cy="${c.y}" r="${c.r + 7}" fill="${c.colour}" opacity=".10"/>
        <circle cx="${c.x}" cy="${c.y}" r="${c.r}" fill="${c.colour}" stroke="white" stroke-width="3" />
        <text x="${c.x}" y="${c.y + 7}" text-anchor="middle" font-size="26" font-weight="700" fill="white">${esc(
          counts[c.id] || 0
        )}</text>
        <text x="${c.x}" y="${c.y + 94}" text-anchor="middle" font-size="15" font-weight="700" fill="#17324d">${esc(c.name.length > 30 ? c.name.slice(0, 29) + '…' : c.name)}</text>
      </g></a>`
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
      <a class="govuk-link" href="/cortex">List</a> ·
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

${Object.keys(errors).length ? '<div class="govuk-inset-text" role="status">Some connected services could not refresh. This map may be incomplete or show previously loaded metadata. See <a class="govuk-link" href="/help">service health</a>.</div>' : ''}
${clusters.length ? `<div class="cx-map-scroll" tabindex="0" role="region" aria-label="Governance domain map; scroll horizontally on smaller screens">${svg}</div>` : '<p class="govuk-body" role="status">No governance domains are available yet. Check Purview service health or bootstrap the catalogue. Entries without a domain are listed below.</p>'}

<p class="govuk-hint">
  Positions are arranged for legibility, not geography. Circle size reflects how
  much is registered in each domain. Colour distinguishes domains, not risk or compliance. Select a circle to browse its artefacts; open an artefact's lineage to trace its connections.
</p>

<div class="govuk-inset-text">
  <p class="govuk-body govuk-!-margin-bottom-0">
    <strong>${esc(cross.count)} cross-cluster dependencies</strong> are visible here, and a further
    <strong>${esc(cross.unresolved)}</strong> point at systems that are not registered at all.
    Cross-cluster dependency is the programme measure that matters most: the count
    over time helps show whether teams are connecting their reusable assets.
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
            <a class="govuk-link" href="/cortex?cluster=${attr(c.id)}">${esc(c.name)}</a>
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
            <a class="govuk-link" href="/cortex?cat=${attr(cat)}">${esc(cat)}</a>
          </td>
          <td class="govuk-table__cell govuk-table__cell--numeric">${esc(n)}</td>
        </tr>`
      )
      .join('')}
  </tbody>
</table>`;

  return layout({ ...ctx, title: 'Map', section: 'marketplace' }, content);
}
