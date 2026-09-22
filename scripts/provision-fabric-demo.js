import { connectors, connectorRequest, invokeConnector } from '../src/bff/adapters/connectors.js';

const connector = connectors().find((c) => c.provider === 'fabric');
if (!connector?.workspaceId) throw new Error('Run Set-CortexIntegrations.ps1 and load deployed configuration first.');
const management = process.argv.includes('--operator') ? { ...connector, clientId: undefined, secretEnv: undefined } : connector;
const path = `v1/workspaces/${connector.workspaceId}/dataAgents`;
const name = 'Data Cortex synthetic catalogue guide';
const listing = await connectorRequest(management, path);
let agent = listing.value?.find((a) => a.displayName === name);
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ workspaceId: connector.workspaceId, agent: agent?.id || null, action: agent ? 'reuse-owned-demo' : 'create-synthetic-agent', note: 'No source business data will be attached. The agent describes a synthetic catalogue only.' }));
} else {
  if (!agent) agent = await connectorRequest(management, path, { method: 'POST', body: { artifactType: 'LLMPlugin', displayName: name, description: 'Synthetic Data Cortex integration acceptance agent; no business data attached.' } });
  if (!agent?.id) throw new Error('Fabric did not return the new data agent ID. Check the workspace before retrying.');
  console.log(`Synthetic Fabric agent: ${connector.workspaceId}/${agent.id}`);
  await connectorRequest(management, `${path}/${agent.id}/staging/settings`, {
    method: 'PATCH', body: { aiInstructions: 'You are a synthetic catalogue guide for Data Cortex. Explain that Purview supplies governed context, Foundry hosts agents and API Management publishes reusable capabilities. No business data sources are attached. Do not invent query results. Always label examples as synthetic.' }
  });
  await connectorRequest(management, `${path}/${agent.id}/staging/publish`, {
    method: 'POST', body: { publishedDescription: 'Synthetic catalogue guide for integration demonstrations. No real business data or write actions.' }
  });
  const answer = await invokeConnector(connector, `${connector.workspaceId}/${agent.id}`, 'What services form Data Cortex? Explain that this is a synthetic demonstration with no business data attached.');
  console.log(answer.answer);
}
