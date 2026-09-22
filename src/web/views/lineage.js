import { esc, attr, layout } from '../layout.js';
import { attachableFor } from '../../bff/services/visibility.js';

export function lineageFor(entry, entries, user) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  const resolve = (id) => byId.get(id) || byName.get(String(id).toLowerCase());
  const dependencies = (e) => [...new Set([...(e.deps || []), ...(e._agent?.definition?.knowledge || []), ...(e._agent?.definition?.tools || [])])];
  const upstream = dependencies(entry).map(resolve).filter((e) => e && attachableFor(e, user).attachable);
  const downstream = entries.filter((e) => e.id !== entry.id && attachableFor(e, user).attachable && dependencies(e).some((id) => resolve(id)?.id === entry.id));
  return { upstream: [...new Map(upstream.map((e) => [e.id, e])).values()], downstream,
    unresolved: dependencies(entry).filter((id) => !resolve(id)).length };
}

export function lineagePage(ctx, { entry, entries }) {
  const graph = lineageFor(entry, entries, ctx.user);
  const colour = (e) => e.cat === 'Agent' ? '#6845a5' : e.cat === 'Data' ? '#007f73' : '#0067b8';
  const height = Math.max(360, Math.max(Math.min(graph.upstream.length, 8), Math.min(graph.downstream.length, 8)) * 110 + 70);
  const center = height / 2;
  const node = (e, x, y, focus = false) => `<a href="/entry/${attr(e.id)}${focus ? '' : '/lineage'}" aria-label="${attr(e.name)}">
    <circle cx="${x}" cy="${y}" r="${focus ? 48 : 26}" fill="${colour(e)}"/>
    <text x="${x}" y="${y + 5}" text-anchor="middle" fill="white" font-size="13">${esc(e.cat)}</text>
    <text x="${x}" y="${y + (focus ? 70 : 46)}" text-anchor="middle" fill="#17324d" font-size="14">${esc(e.name.slice(0, 30))}</text><title>${esc(e.name)}</title></a>`;
  const column = (values, x, incoming) => values.slice(0, 8).map((e, i) => {
    const y = 60 + i * 110;
    return `<path d="M${incoming ? x + 28 : 500} ${incoming ? y : center} C340 ${incoming ? y : center},560 ${incoming ? center : y},${incoming ? 400 : x - 30} ${incoming ? center : y}" stroke="#8095aa" fill="none" stroke-width="2" marker-end="url(#lineage-arrow)"/>${node(e, x, y)}`;
  }).join('');
  const list = (label, values) => `<section><h2 class="govuk-heading-m">${label} (${values.length})</h2>${values.length
    ? `<ul class="govuk-list">${values.map((e) => `<li><a class="govuk-link" href="/entry/${attr(e.id)}/lineage">${esc(e.name)}</a> - ${esc(e.cat)}</li>`).join('')}</ul>`
    : '<p class="govuk-hint">No accessible relationships recorded.</p>'}</section>`;
  return layout({ ...ctx, title: `Lineage - ${entry.name}`, section: 'marketplace' }, `
    <a class="govuk-back-link" href="/entry/${attr(entry.id)}">Back to artefact</a>
    <h1 class="govuk-heading-xl">${esc(entry.name)}: lineage</h1>
    <p class="govuk-body">Recorded inputs flow from left to right into this artefact, then into its consumers. This is declared catalogue lineage, not inferred execution tracing. Only accessible relationships are shown.</p>
    <div class="cx-map-scroll" tabindex="0" role="region" aria-label="Artefact lineage diagram">
      <svg class="cx-estate-map" viewBox="0 0 900 ${height}" role="img" aria-labelledby="lineage-title"><title id="lineage-title">Inputs, ${esc(entry.name)}, and downstream consumers</title>
        <defs><marker id="lineage-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#8095aa"/></marker></defs>
        ${column(graph.upstream, 160, true)}${column(graph.downstream, 740, false)}${node(entry, 450, center, true)}
      </svg></div>
    <p class="govuk-hint">Teal: data. Blue: API/tool. Purple: agent. Up to eight nodes per side appear in the diagram; the complete accessible relationship list follows. Unresolved references: ${graph.unresolved}.</p>
    <div class="cx-lineage-lists">${list('Inputs and dependencies', graph.upstream)}${list('Used by', graph.downstream)}</div>`);
}
