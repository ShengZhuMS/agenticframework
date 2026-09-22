import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex, index, USERS } from './fixtures.js';
import { configureStateBlob, primeState } from '../src/bff/state/store.js';
import { validateMetadata, validateOpenApi, registerArtefact, queryArtefact, artefactsFor, proxyArtefact, agentInvocationBody } from '../src/bff/services/artefacts.js';
import { connectorUrl, connectors, invokeConnector } from '../src/bff/adapters/connectors.js';
import { channelMetadata, publishChannels } from '../src/bff/adapters/channels.js';
import { lineageFor } from '../src/web/views/lineage.js';

let restore, originalSearch, originalImport, originalMcp, env;
const user = USERS.analyst;
const metadata = () => ({ kind: 'graphql', name: 'Synthetic rows', description: 'Read-only synthetic records',
  purpose: 'Demonstration', owner: 'Demo team', contact: 'demo@example.test', domain: index.domains[0].id,
  version: '1.0.0', sensitivity: 'Internal', licence: 'Internal', limitations: 'Synthetic only',
  confirm: 'yes', sourceId: 'synthetic-source' });
beforeEach(async () => {
  restore = await loadIndex();
  env = process.env.CORTEX_CONNECTORS;
  process.env.CORTEX_CONNECTORS = JSON.stringify([{ id: 'demo', provider: 'openapi', baseUrl: 'https://source.example.test/api', auth: 'anonymous' }]);
  configureStateBlob({ account: 'stub', backend: { list: async () => [], get: async () => '{}', put: async () => {} } });
  await primeState();
  index.upsert({ id: 'synthetic-source', name: 'Synthetic source', cat: 'Data', cluster: index.domains[0].id,
    searchIndex: 'cortex-synthetic', sens: 'Official', allowedGroups: ['all-staff'], access: 'Open to all staff' });
  originalSearch = index.search;
  originalImport = index.apim.importOpenApi;
  originalMcp = index.apim.createMcpServer;
  index.search = { indexStats: async () => ({ documents: 2 }), search: async () => [{ id: 'one', value: 'synthetic' }] };
  index.apim.importOpenApi = async () => ({});
  index.apim.createMcpServer = async ({ id }) => ({ url: `https://gateway.test/${id}/mcp` });
});
afterEach(() => {
  index.search = originalSearch; index.apim.importOpenApi = originalImport; index.apim.createMcpServer = originalMcp;
  if (env === undefined) delete process.env.CORTEX_CONNECTORS; else process.env.CORTEX_CONNECTORS = env;
  restore();
});

test('publishes real GraphQL transport over selected indexed data with complete metadata', async () => {
  const r = await registerArtefact(metadata(), user, 'https://cortex.test');
  assert.equal(r.state, 'published');
  assert.equal(r.ownerId, user.id);
  assert.deepEqual(r.dependencies, ['synthetic-source']);
  assert.equal(index.get(r.id)._artefact.contact, 'demo@example.test');
  const result = await queryArtefact(r, { query: '{ rows(first: 2) { id json } }' });
  assert.equal(result.errors, undefined);
  assert.equal(JSON.parse(result.data.rows[0].json).value, 'synthetic');
  assert.equal(artefactsFor({ id: 'other' }).length, 0);
  const bad = await queryArtefact(r, { query: '{ rows(first: 51) { id } }' });
  assert.match(bad.errors[0].message, /between 1 and 50/);
});

test('invalid ownership, metadata and unknown source cannot publish', async () => {
  for (const change of [{ confirm: '' }, { version: 'latest' }, { domain: 'missing' }, { contact: '' }]) {
    assert.throws(() => validateMetadata({ ...metadata(), ...change }, user));
  }
  await assert.rejects(registerArtefact({ ...metadata(), sourceId: 'missing' }, user, 'https://cortex.test'), /accessible/);
  assert.throws(() => validateMetadata(metadata(), {}), /Sign in/);
});

test('an unavailable Studio source stops before gateway resources or assessments are created', async () => {
  process.env.CORTEX_CONNECTORS = JSON.stringify([{ id: 'studio', provider: 'm365', protocol: 'direct-engine',
    agentId: 'cortex_SyntheticGuide', baseUrl: 'https://synthetic.00.environment.api.powerplatform.com', auth: 'anonymous' }]);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('App-only S2S access is not enabled for this environment.', { status: 405 });
  index.apim.importOpenApi = async () => assert.fail('must not create gateway resources');
  try {
    await assert.rejects(registerArtefact({ ...metadata(), kind: 'external-agent', connector: 'studio',
      sourceId: 'cortex_SyntheticGuide' }, user, 'https://cortex.test'), /Microsoft must enable/);
    assert.equal(artefactsFor(user).length, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('OpenAPI publication rejects external references, destinations and write methods', () => {
  const spec = { openapi: '3.0.3', info: { title: 'API', version: '1.0.0' }, paths: { '/items/{id}': { get: { operationId: 'getItem', responses: { 200: { description: 'ok' } } } } } };
  assert.equal(validateOpenApi(JSON.stringify(spec)).operations.length, 1);
  assert.throws(() => validateOpenApi(JSON.stringify({ ...spec, servers: [{ url: 'https://elsewhere.test' }] })), /servers/);
  assert.throws(() => validateOpenApi(JSON.stringify({ ...spec, components: { schemas: { Item: { $ref: 'https://elsewhere.test/schema' } } } })), /External/);
  const writeSpec = JSON.stringify({ ...spec, paths: { '/items': { delete: { operationId: 'delete' } } } });
  assert.throws(() => validateOpenApi(writeSpec), /Read-only/);
  assert.equal(validateOpenApi(writeSpec, { allowWrites: true }).operations[0].method, 'delete');
});

test('connector requests cannot escape administrator-approved origins and prefixes', () => {
  const c = connectors()[0];
  assert.equal(connectorUrl(c, 'items').href, 'https://source.example.test/api/items');
  for (const value of ['https://elsewhere.test/', '../secrets', '%2e%2e/secrets', '\\\\elsewhere.test']) assert.throws(() => connectorUrl(c, value));
});

test('APIM single-question MCP projection and JSON HTTP callers share one canonical body', () => {
  assert.deepEqual(agentInvocationBody('Reply only SYNTHETIC'), { question: 'Reply only SYNTHETIC' });
  assert.deepEqual(agentInvocationBody('"Reply only SYNTHETIC"'), { question: 'Reply only SYNTHETIC' });
  assert.deepEqual(agentInvocationBody('{"question":"Reply only SYNTHETIC"}'), { question: 'Reply only SYNTHETIC' });
});

test('API proxy only invokes declared methods and paths', async () => {
  const r = { kind: 'api-mcp', state: 'published', connector: 'demo', operations: [{ path: '/items/{id}', method: 'get' }] };
  await assert.rejects(proxyArtefact(r, 'DELETE', '/items/one', ''), /not selected/);
  await assert.rejects(proxyArtefact(r, 'GET', '/admin', ''), /not selected/);
});

test('Databricks adapter invokes an approved serving endpoint and surfaces failures', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://dbx.test/serving-endpoints/demo/invocations');
    assert.equal(init.redirect, 'error');
    assert.equal(JSON.parse(init.body).messages[0].content, 'synthetic');
    return Response.json({ choices: [{ message: { content: 'Synthetic answer' } }] });
  };
  try {
    const answer = await invokeConnector({ id: 'dbx', provider: 'databricks', baseUrl: 'https://dbx.test', auth: 'anonymous' }, 'demo', 'synthetic');
    assert.equal(answer.answer, 'Synthetic answer');
  } finally { globalThis.fetch = previous; }
});

test('Microsoft 365 publishing requires complete publisher metadata and explicit submission consent', () => {
  const form = { ...metadata(), developerWebsiteUrl: 'https://example.test', privacyUrl: 'https://example.test/privacy', termsOfUseUrl: 'https://example.test/terms', channelConsent: 'yes' };
  assert.equal(channelMetadata(form).publishScope, 'Tenant');
  assert.throws(() => channelMetadata({ ...form, channelConsent: '' }), /Confirm submission/);
  assert.throws(() => channelMetadata({ ...form, privacyUrl: 'http://example.test' }), /HTTPS/);
});

test('channel publishing refuses legacy agents before creating any bot', async () => {
  const old = process.env.AZURE_TENANT_ID;
  process.env.AZURE_TENANT_ID = '11111111-1111-1111-1111-111111111111';
  try { await assert.rejects(publishChannels({ getAgent: async () => ({}) }, 'legacy', '1', {}, async () => {}), /unique instance identity/); }
  finally { if (old === undefined) delete process.env.AZURE_TENANT_ID; else process.env.AZURE_TENANT_ID = old; }
});

test('lineage resolves IDs and names, removes duplicate edges and reports missing references', () => {
  const source = index.get('synthetic-source');
  const focus = { ...source, id: 'focus', name: 'Focus', cat: 'Agent', deps: [source.id, source.name, 'unknown'] };
  const consumer = { ...source, id: 'consumer', name: 'Consumer', deps: ['focus'] };
  const graph = lineageFor(focus, [source, focus, consumer], user);
  assert.deepEqual(graph.upstream.map((e) => e.id), [source.id]);
  assert.deepEqual(graph.downstream.map((e) => e.id), ['consumer']);
  assert.equal(graph.unresolved, 1);
});
