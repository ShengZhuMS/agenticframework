import { esc, attr } from '../layout.js';
import { randomUUID } from 'node:crypto';
import { demoTip, publishingDefaults } from '../demo.js';

const kinds = {
  knowledge: 'Build Foundry IQ from Data Source',
  'api-mcp': 'Existing REST / GraphQL API as MCP tools',
  'external-agent': 'Existing agent',
  m365: 'Agent to Teams and Microsoft 365 Copilot'
};

export function publishingPanel(ctx, { kind = 'knowledge', protocol = 'rest', connectors = [], records = [], entries = [], sources = [], knowledgeJobs = [] } = {}) {
  if (!Object.hasOwn(kinds, kind) && kind !== 'graphql') kind = 'knowledge';
  const agents = entries.filter((entry) => entry.cat === 'Agent' && (entry._agent?.definition?.builtById === ctx.user.id || ctx.user.groups?.includes('cortex-redteam')));
  const defaults = publishingDefaults(kind, protocol, { sources, agents, connectors });
  const field = (name, label, value = '', max = 500, required = false) => `<div class="govuk-form-group"><label class="govuk-label" for="pub-${name}">${label}</label>
    <input class="govuk-input" id="pub-${name}" name="${name}" maxlength="${max}" value="${attr(value || defaults[name] || '')}" ${required ? 'required' : ''}></div>`;
  const select = (name, label, values) => `<div class="govuk-form-group"><label class="govuk-label" for="pub-${name}">${label}</label>
    <select class="govuk-select" id="pub-${name}" name="${name}" required><option value="">Choose...</option>${values.map(([id, text]) => `<option value="${attr(id)}" ${defaults[name] === id ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></div>`;
  const sourceFields = kind === 'knowledge' ? select('sourceId', 'Configured source data product', sources.map((entry) => [entry.id, entry.name])) :
    kind === 'm365' ? select('sourceId', 'Your agent', agents.map((entry) => [entry.id, entry.name])) :
    kind === 'graphql' ? select('sourceId', 'Indexed data product', entries.filter((entry) => entry.cat === 'Data' && entry.searchIndex).map((entry) => [entry.id, entry.name])) :
    select('connector', 'Approved connector', connectors.filter((connector) => kind === 'api-mcp' ? connector.provider === 'openapi' : connector.provider !== 'openapi').map((connector) => [connector.id, `${connector.name || connector.id} (${connector.provider})`])) +
      field('sourceId', kind === 'api-mcp' ? 'API identifier' : 'Source agent identifier', '', 300, true);
  return `<section class="cx-publish" aria-labelledby="publish-title">
    <h2 id="publish-title" class="govuk-heading-l">Publish a reusable artefact</h2>
    <p class="govuk-body">Choose a source and give it a name. Ownership defaults to your team; credentials stay in approved connectors.</p>
    <nav aria-label="Publication types" class="cx-publish-types">${Object.entries(kinds).map(([id, label]) => `<a class="govuk-button ${id === kind ? '' : 'govuk-button--secondary'}" href="/share?kind=${id}" ${id === kind ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <form method="post" action="/share/publish">
      ${demoTip({ text: defaults.tip || 'Review the source and metadata before publishing.', note: 'Synthetic example values are prefilled. Required source/connector options remain blank if bootstrap prerequisites are missing. Consent is never preselected.' })}
      <input type="hidden" name="kind" value="${kind}"><input type="hidden" name="requestId" value="${randomUUID()}">
      ${kind === 'external-agent' ? '<input type="hidden" name="assessmentMode" value="draft"><p class="govuk-hint">Creates a usable draft wrapper without automatically starting the currently capacity-blocked native red-team service. Review its assurance before publishing from the agent page.</p>' : ''}
      ${sourceFields}
      ${field('name', 'Artefact name', '', kind === 'm365' ? 30 : 80, kind !== 'knowledge')}
      ${kind === 'knowledge' ? `<p class="govuk-inset-text">Uses the configured ADLS Gen2 / Blob-backed CSV data product. Creates or updates its data source, index and indexer; after successful ingestion, creates a Search knowledge source, knowledge base and Foundry managed-identity MCP connection. Derived data is copied into Search. Semantic retrieval must already be enabled; no paid tier is enabled automatically. When the administrator enables a knowledge planning model, retrieval uses that existing deployment and incurs model usage.</p>
        <details class="govuk-details"><summary>Other AI Search connectors and prerequisites</summary><p class="govuk-body">Azure SQL, Cosmos DB, other Blob formats and supported preview sources require separate connector setup, credentials/managed-identity access, schemas and network routes. They are not implemented by this configured-source flow. <a href="https://learn.microsoft.com/en-us/azure/search/search-indexer-overview">See the current supported indexer catalogue</a>.</p></details>` : ''}
      ${kind === 'api-mcp' ? `<p class="govuk-body"><a href="/share?kind=api-mcp&amp;protocol=rest">OpenAPI REST</a> | <a href="/share?kind=api-mcp&amp;protocol=graphql">GraphQL</a></p>
        <input type="hidden" name="protocol" value="${protocol === 'graphql' ? 'graphql' : 'rest'}">
        ${protocol === 'graphql' ? `${field('graphqlPath', 'GraphQL path inside the configured connector (optional)', '', 300)}
          <label class="govuk-label" for="pub-query">Approved read-only GraphQL query</label>
          <textarea class="govuk-textarea" id="pub-query" name="graphqlQuery" rows="4" maxlength="12000" required>${esc(defaults.graphqlQuery || '')}</textarea>
          <p class="govuk-hint">One query, optionally with variables. The MCP caller supplies variables only; it cannot replace the query or submit mutations.</p>` :
          `<label class="govuk-label" for="pub-openapi">OpenAPI 3.0 JSON</label><textarea class="govuk-textarea" id="pub-openapi" name="openapi" rows="5" maxlength="256000" required>${esc(defaults.openapi || '')}</textarea>
          <p class="govuk-hint">Select 1-20 GET operations; remove servers and bundle external references. The connector controls the destination.</p>
          <details class="govuk-details"><summary>Sandbox write operations</summary><label><input type="checkbox" name="allowWrites" value="yes"> I explicitly approve the declared non-GET operations and their source-system side effects.</label></details>`}` : ''}
      ${kind !== 'knowledge' ? `<details class="govuk-details"><summary>Advanced metadata (optional)</summary>
        ${field('description', 'Description', '', 2000)}${field('purpose', 'Business purpose', '', 1000)}
        ${field('owner', 'Accountable owner', ctx.user.team || ctx.user.name, 100)}${field('contact', 'Support contact', ctx.user.email || '', 200)}
        <label class="govuk-label" for="pub-domain">Governance domain (defaults to source or first configured domain)</label>
        <select class="govuk-select" id="pub-domain" name="domain"><option value="">Use default</option>${(ctx.clusters || []).map((domain) => `<option value="${attr(domain.id)}">${esc(domain.name)}</option>`).join('')}</select>
        ${field('version', 'Version', '1.0.0', 30)}${field('licence', 'Permitted use', 'Internal synthetic demonstration only', 200)}
        ${field('limitations', 'Limitations', 'Read-only synthetic data; human review required', 1000)}${field('dependencies', 'Other dependency IDs, comma separated', '', 2000)}
      </details><label class="govuk-label" for="pub-sensitivity">Classification</label><select class="govuk-select" name="sensitivity" id="pub-sensitivity"><option>Internal</option><option>Public</option><option>Confidential</option></select>` : ''}
      ${kind === 'm365' ? `<p class="govuk-inset-text">Prepare a Teams/Microsoft 365 app package for a native Foundry agent. Tenant installation, Bot Service configuration and consent are separate prerequisites, not implied by downloading a package.</p>
        <details class="govuk-details"><summary>Publisher links (defaults to this app)</summary>${field('developerWebsiteUrl', 'Publisher website (HTTPS)')}${field('privacyUrl', 'Privacy notice (HTTPS)')}${field('termsOfUseUrl', 'Terms of use (HTTPS)')}</details>` : ''}
      <p><label><input type="checkbox" name="confirm" value="yes" required> I am authorised to share this source and confirm its audience, permissions and synthetic/read-only demo suitability. ${kind === 'm365' ? 'Package generation does not install the app.' : 'I approve the described Azure usage and resource configuration.'}</label></p>
      <button class="govuk-button" type="submit">${kind === 'm365' ? 'Prepare app package' : kind === 'knowledge' ? 'Build knowledge source' : kind === 'external-agent' ? 'Create draft wrapper' : 'Publish artefact'}</button>
      ${kind === 'm365' ? `<details class="govuk-details"><summary>Advanced: native channel submission</summary>
        <p class="govuk-body">Creates a Bot Service, pins the reviewed version and submits to the tenant catalogue after a new passing native assessment. Azure usage and administrator approval apply; this is not required to download the package.</p>
        <label><input type="checkbox" name="channelConsent" value="yes"> I approve the billable assessment, Bot Service provisioning and submission for tenant approval.</label>
        <button class="govuk-button govuk-button--secondary" name="channelMode" value="native">Assess and submit to tenant</button></details>` : ''}
    </form>
    ${knowledgeJobs.length ? `<h3 class="govuk-heading-m">Knowledge publishing progress</h3>${knowledgeJobs.map((job) => `<article class="govuk-inset-text"><h4 class="govuk-heading-s">${esc(job.name)}: ${esc(job.status)}</h4>
      ${job.error ? `<p class="govuk-error-message">${esc(job.error)}</p>` : ''}
      ${job.status === 'published' ? `<a href="/entry/${attr(job.entryId)}">Open knowledge artefact</a><p class="govuk-hint">${esc(job.documents)} indexed documents; verify retrieval with the intended agent identity.</p>` : ''}
      ${job.indexing ? `<form method="post" action="/share/knowledge/${attr(job.id)}/refresh"><button class="govuk-button govuk-button--secondary">${job.status === 'published' ? 'Refresh knowledge connection' : 'Check ingestion and finish publication'}</button></form>` : '<p>Resolve the prerequisite and resubmit this source to retry setup.</p>'}</article>`).join('')}` : ''}
    <h3 class="govuk-heading-m">Your publishing records</h3>
    ${records.length ? `<table class="govuk-table"><thead><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Evidence</th></tr></thead><tbody>${records.map((record) => `<tr><th scope="row">${esc(record.name)}</th><td>${esc(record.state)}${record.error ? `<p class="govuk-error-message">${esc(record.error)}</p>` : ''}</td><td>${record.agentId ? `<a href="/agent/${attr(record.agentId)}/redteam">Assessment and publication</a>` : `<a href="/entry/${attr(record.id)}">Artefact and lineage</a>`}</td></tr>`).join('')}</tbody></table>` : '<p class="govuk-hint">No publishing records yet.</p>'}
  </section>`;
}
