// Privileged operator acceptance runner. Run inside the app container, never as a public route.
import { randomUUID } from 'node:crypto';
import config from '../src/bff/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const userId = process.argv.find((a) => a.startsWith('--user-id='))?.split('=')[1];
if (!/^[0-9a-f-]{36}$/i.test(userId || '')) throw new Error('Supply the approving operator object ID with --user-id.');
const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
const headers = { 'x-ms-client-principal-id': userId, 'x-ms-client-principal-name': 'cortex-acceptance@example.test' };
const entries = await (await fetch(`${base}/api/entries`, { headers })).json();
const source = entries.find((e) => e.name === 'Demo - Service performance');
if (!source) throw new Error('The neutral synthetic service-performance product is required.');
const kind = process.argv.includes('--agent') ? 'external-agent' : process.argv.includes('--graphql') ? 'graphql' : 'api-mcp';
const names = { graphql: 'Acceptance - synthetic GraphQL', 'api-mcp': 'Acceptance - catalogue health API', 'external-agent': 'Acceptance - Databricks agent' };
let entry = entries.find((e) => e.name === names[kind] && (kind !== 'external-agent' || e.cat === 'Agent'));
if (!entry && !process.argv.includes('--apply')) throw new Error('This acceptance artefact does not exist. Use --apply to create it explicitly.');
if (!entry) {
  const form = {
    kind, name: names[kind], description: 'Synthetic read-only integration acceptance artefact', purpose: 'Verify managed artefact publication',
    owner: 'Data Cortex acceptance', contact: 'demo@example.test', domain: source.cluster, version: '1.0.0',
    sensitivity: 'Internal', licence: 'Internal synthetic demonstration', limitations: 'Synthetic or service health metadata only',
    sourceId: kind === 'graphql' ? source.id : kind === 'external-agent' ? 'databricks-gpt-oss-20b' : 'synthetic-catalogue-health',
    connector: kind === 'external-agent' ? 'databricks' : 'cortex-demo-api', confirm: 'yes', requestId: randomUUID()
  };
  if (kind === 'api-mcp') form.openapi = JSON.stringify({ openapi: '3.0.3', info: { title: form.name, version: '1.0.0' },
    paths: { '/purview': { get: { operationId: 'catalogueHealth', summary: 'Read catalogue health metadata',
      responses: { 200: { description: 'Service health', content: { 'application/json': { schema: { type: 'object' } } } } } } } } });
  const response = await fetch(`${base}/share/publish`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form), redirect: 'manual', signal: AbortSignal.timeout(240000)
  });
  if (response.status !== 303) throw new Error(`Publication HTTP ${response.status}: ${(await response.text()).replace(/<[^>]+>/g, ' ').slice(-1800)}`);
  console.log(`Publication accepted: ${response.headers.get('location')}`);
  const refreshed = await (await fetch(`${base}/api/entries`, { headers })).json();
  entry = refreshed.find((e) => e.name === form.name && (kind !== 'external-agent' || e.cat === 'Agent'));
}
if (!entry) throw new Error('The published/draft artefact did not appear in the register.');
if (kind === 'external-agent') {
  console.log(`Native assessment requested for ${entry.id}; publication must remain blocked until it passes.`);
} else if (kind === 'graphql') {
  const response = await fetch(`${config.apim.gatewayUrl}/${entry.id}/graphql`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': config.apim.subscriptionKey },
    body: JSON.stringify({ query: '{ rows(first: 2) { id json } }' })
  });
  const result = await response.json();
  if (!response.ok || result.errors || result.data?.rows?.length !== 2) throw new Error(`GraphQL failed: ${JSON.stringify(result)}`);
  console.log('GraphQL through APIM returned two actual synthetic indexed rows.');
} else {
  const client = new Client({ name: 'cortex-acceptance', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(entry._endpoints.mcp), { requestInit: { headers: { 'Ocp-Apim-Subscription-Key': config.apim.subscriptionKey } } }));
    const tools = await client.listTools();
    if (!tools.tools.some((t) => t.name === 'catalogueHealth')) throw new Error('The published MCP tool was not listed.');
    const result = await client.callTool({ name: 'catalogueHealth', arguments: {} });
    if (result.isError) throw new Error('The published MCP tool returned an error.');
    const payloads = result.content.filter((c) => c.type === 'text').map((c) => JSON.parse(c.text));
    if (!payloads.some((p) => p.ok === true) || payloads.some((p) => p.error)) throw new Error('MCP transport succeeded but the health operation did not return a successful service result.');
    console.log('Published MCP tool listed and invoked through APIM.');
  } finally { await client.close(); }
}
