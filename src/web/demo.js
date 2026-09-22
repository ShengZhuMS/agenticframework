import { esc, attr } from './layout.js';

export const DEMO_PROMPTS = {
  ask: 'Which inventory, delivery, quality, service performance and API usage sources can support a synthetic Novo operations briefing?',
  record: 'Find record SYN-17 in the attached knowledge source. Return its recorded metric value, source and reporting date. Do not calculate an estate-wide total.',
  request: 'Please review the synthetic operational capacity sample for a one-off Novo operations briefing. State its limitations and provide only an aggregate answer.',
  purpose: 'Prepare a synthetic, non-clinical demonstration briefing for a human reviewer; not an operational decision.',
  goal: 'Prepare a synthetic Novo operations briefing. First run the Usage, Supply and Quality analysts in parallel, then ask the Service analyst to incorporate those drafts with service evidence, then ask the Evidence reviewer to produce the final cited draft. Use at most five steps and do not publish or send anything.'
};

export function demoTip({ text, fields = {}, href, note = '' }) {
  return `<aside class="cortex-demo-tip" aria-label="Synthetic demo example">
    <p class="govuk-body-s"><strong>Try this synthetic demo:</strong> ${esc(text)}</p>
    ${note ? `<p class="govuk-hint">${esc(note)}</p>` : ''}
    ${href ? `<a class="govuk-link" href="${attr(href)}">Use this example</a>` : Object.keys(fields).length ? `<button type="button" class="govuk-button govuk-button--secondary" data-demo-fields="${attr(JSON.stringify(fields))}">Use this example</button>` : ''}
    <span class="govuk-body-s" data-demo-status role="status"></span>
  </aside>`;
}

export const DEMO_OPENAPI = {
  openapi: '3.0.3', info: { title: 'Synthetic demo catalogue health', version: '1.0.0' },
  paths: { '/purview': { get: { operationId: 'catalogueHealth', summary: 'Read actual catalogue health metadata',
    responses: { 200: { description: 'Catalogue health', content: { 'application/json': { schema: { type: 'object' } } } } } } } }
};

export function publishingDefaults(kind, protocol, { sources = [], agents = [], connectors = [] }) {
  if (kind === 'knowledge') return {
    sourceId: sources.find((source) => source.name === 'Demo - Inventory levels')?.id || '',
    name: 'Demo - Supply knowledge', tip: 'Publish the configured synthetic inventory source as reusable Foundry IQ knowledge. The existing index/base is reused where available.'
  };
  if (kind === 'api-mcp' && protocol === 'graphql') return {
    connector: connectors.find((connector) => connector.id === 'cortex-demo-graphql')?.id || '',
    sourceId: 'synthetic-operations-graphql', name: 'Demo - Operations GraphQL MCP',
    graphqlPath: 'graphql', graphqlQuery: '{ rows(first: 2) { id json } }',
    tip: 'Expose this fixed, read-only query over the seeded operations GraphQL API as an MCP tool. The backend returns actual indexed rows.'
  };
  if (kind === 'api-mcp') return {
    connector: connectors.find((connector) => connector.id === 'cortex-demo-api')?.id || '',
    sourceId: 'synthetic-catalogue-health', name: 'Demo - Catalogue health MCP',
    openapi: JSON.stringify(DEMO_OPENAPI, null, 2), tip: 'Publish the selected real catalogue-health GET operation as MCP. No source writes are included.'
  };
  if (kind === 'm365') return {
    sourceId: agents.find((agent) => agent.name === 'Demo - Service analyst')?.id || '',
    name: 'Novo demo operations', tip: 'Download a valid package for the seeded Service analyst. Installation and chat in Teams/Microsoft 365 require tenant approval and channel prerequisites.'
  };
  if (kind === 'external-agent') return {
    connector: connectors.find((connector) => connector.provider === 'databricks')?.id || '',
    sourceId: 'databricks-gpt-oss-20b', name: 'Demo - Databricks assistant',
    tip: 'Create a draft wrapper for the approved Databricks serving endpoint, then chat with it. Review assurance before publishing. Fabric and Studio have separate prerequisites.'
  };
  return {};
}
