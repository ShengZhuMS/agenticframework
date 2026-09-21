import { esc, attr } from '../layout.js';
import { randomUUID } from 'node:crypto';

const kinds = {
  'external-agent': 'Databricks, Fabric or Microsoft 365 agent',
  graphql: 'Data product as a GraphQL API',
  'api-mcp': 'Existing API as MCP tools',
  m365: 'Agent to Teams and Microsoft 365 Copilot'
};

export function publishingPanel(ctx, { kind = 'external-agent', connectors = [], records = [], entries = [] } = {}) {
  if (!Object.hasOwn(kinds, kind)) kind = 'external-agent';
  const field = (name, label, max = 500, value = '', hint = '') => `<div class="govuk-form-group">
    <label class="govuk-label" for="pub-${name}">${label}</label>${hint ? `<p class="govuk-hint">${hint}</p>` : ''}
    <input class="govuk-input" id="pub-${name}" name="${name}" maxlength="${max}" value="${attr(value)}" required></div>`;
  const select = (name, label, values) => `<div class="govuk-form-group"><label class="govuk-label" for="pub-${name}">${label}</label>
    <select class="govuk-select" id="pub-${name}" name="${name}" required><option value="">Choose...</option>${values.map(([id, text]) => `<option value="${attr(id)}">${esc(text)}</option>`).join('')}</select></div>`;
  const sources = entries.filter((e) => kind === 'graphql' ? e.cat === 'Data' && e.searchIndex :
    e.cat === 'Agent' && (e._agent?.definition?.builtById === ctx.user.id || ctx.user.groups?.includes('cortex-redteam')));
  return `<section class="cx-publish" aria-labelledby="publish-title">
    <h2 id="publish-title" class="govuk-heading-l">Publish a reusable artefact</h2>
    <p class="govuk-body">Register ownership, purpose, access and lineage, then publish through managed platform services. Credentials stay in administrator-managed connectors, never in this form.</p>
    ${kind === 'external-agent' ? '<p class="govuk-inset-text">Source connectivity is checked before creating gateway resources or assessments; model and data permissions are also required at invocation. A configured connector does not prove tenant feature availability. Copilot Studio supports application-authenticated Direct Engine connections where the environment enables S2S, or a secured Direct Line channel.</p>' : ''}
    <nav aria-label="Publication types" class="cx-publish-types">${Object.entries(kinds).map(([id, label]) =>
      `<a class="govuk-button ${id === kind ? '' : 'govuk-button--secondary'}" href="/share?kind=${id}" ${id === kind ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <form method="post" action="/share/publish" class="cx-publish-form">
      <input type="hidden" name="kind" value="${kind}">
      <input type="hidden" name="requestId" value="${randomUUID()}">
      <h3 class="govuk-heading-m">${kinds[kind]}</h3>
      ${kind === 'external-agent' || kind === 'api-mcp' ? select('connector', 'Approved source connector',
        connectors.filter((c) => kind === 'api-mcp' ? c.provider === 'openapi' : c.provider !== 'openapi').map((c) => [c.id, `${c.name || c.id} (${c.provider})`])) : ''}
      ${kind === 'graphql' || kind === 'm365' ? select('sourceId', 'Source artefact', sources.map((e) => [e.id, e.name])) :
        field('sourceId', 'Source identifier', 300, '', kind === 'api-mcp' ? 'Your source system or API identifier.' : 'Databricks: serving endpoint name. Fabric: workspace-id/data-agent-id. Microsoft 365: the published agent schema name or ID bound to the administrator-configured connector.')}
      ${field('name', 'Artefact name', kind === 'm365' ? 30 : 80)}
      ${field('description', 'Description and capability', 2000)}
      ${field('purpose', 'Business purpose', kind === 'm365' ? 80 : 1000)}
      ${field('owner', 'Accountable owner/team', kind === 'm365' ? 32 : 100, ctx.user.team || '')}
      ${field('contact', 'Support contact', 200, ctx.user.email || '')}
      ${select('domain', 'Governance domain', (ctx.clusters || []).map((c) => [c.id, c.name]))}
      ${field('version', 'Artefact/package version', 30, '1.0.0')}
      ${select('sensitivity', 'Information classification', [['Public', 'Public'], ['Internal', 'Internal'], ['Confidential', 'Confidential']])}
      ${field('licence', 'Licence and permitted use', 200, 'Internal synthetic demonstration only')}
      ${field('limitations', 'Limitations and acceptable use', 1000, 'Read-only synthetic data; human review required')}
      <div class="govuk-form-group"><label class="govuk-label" for="pub-dependencies">Other dependencies (optional registered IDs, comma separated)</label>
        <input class="govuk-input" id="pub-dependencies" name="dependencies" maxlength="2000"></div>
      ${kind === 'api-mcp' ? `<div class="govuk-form-group"><label class="govuk-label" for="pub-openapi">OpenAPI 3.0 JSON</label>
        <p class="govuk-hint">Include 1-20 selected JSON operations with unique operationId values. Remove servers and bundle external references. The configured connector controls the destination. GET is the default.</p>
        <textarea class="govuk-textarea" id="pub-openapi" name="openapi" rows="10" maxlength="256000" required></textarea></div>
        <p><label><input type="checkbox" name="allowWrites" value="yes"> I explicitly approve the declared POST, PUT, PATCH or DELETE operations. These may change the source system when invoked; only synthetic sandbox operations are permitted here.</label></p>` : ''}
      ${kind === 'graphql' ? '<p class="govuk-inset-text">Publishes a read-only GraphQL query over the selected product\'s existing Search index, not its original source database. Queries return at most 50 rows, with the row content encoded in the json field. A gateway subscription is required.</p>' : ''}
      ${kind === 'm365' ? `${field('developerWebsiteUrl', 'Publisher website (HTTPS)', 500)}
        ${field('privacyUrl', 'Privacy notice (HTTPS)', 500)}${field('termsOfUseUrl', 'Terms of use (HTTPS)', 500)}
        <p class="govuk-inset-text">A new native assessment must pass before channel publishing. Cortex then creates a dedicated Bot Service and submits the agent package for tenant administrator approval. It does not install for everyone or convert the source into a Copilot Studio implementation.</p>
        <p><label><input type="checkbox" name="channelConsent" value="yes" required> I approve submission to the tenant catalogue; administrator approval remains required.</label></p>` : ''}
      ${kind === 'external-agent' ? '<p class="govuk-inset-text">Creates a Foundry wrapper around the source agent and automatically assesses that wrapper before marketplace publication. The original agent remains in its source platform. Source configuration changes require reassessment.</p>' : ''}
      <p><label><input type="checkbox" name="confirm" value="yes" required> I am authorised to share this artefact and confirm its source permissions, metadata and synthetic demonstration use. Connected agents must be read-only.</label></p>
      <button class="govuk-button" type="submit">${kind === 'external-agent' || kind === 'm365' ? 'Assess and publish' : 'Publish artefact'}</button>
    </form>
    <h3 class="govuk-heading-m">Your publishing records</h3>
    ${records.length ? `<table class="govuk-table"><thead><tr><th>Name</th><th>Status</th><th>Evidence and endpoints</th></tr></thead><tbody>${records.map((r) => `<tr>
      <td>${esc(r.name)}<span class="cortex-src">${esc(r.version)} · ${esc(r.kind)}</span></td>
      <td>${esc(r.state)}${r.error ? `<p class="govuk-error-message">${esc(r.error)}</p>` : ''}</td>
      <td>${r.agentId ? `<a class="govuk-link" href="/agent/${attr(r.agentId)}/redteam">Assessment and publication status</a>` : `<a class="govuk-link" href="/entry/${attr(r.id)}">Artefact and lineage</a>`}
      ${r.state === 'published' ? `<code class="cx-endpoint">${esc(r.kind === 'graphql' ? r.apiUrl + '/graphql' : r.mcpUrl)}</code>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="govuk-hint">No publishing records for your account yet.</p>'}
  </section>`;
}
