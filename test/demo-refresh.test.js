import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { bootstrapKnowledge } from '../scripts/bootstrap-knowledge.js';
import { generateProduct, SAMPLE_PRODUCTS } from '../scripts/sample-data.js';
import { publishingDefaults } from '../src/web/demo.js';
import { demoWorkflowForm } from '../scripts/bootstrap-demo.js';
import { DEMO_JOURNEY } from '../src/bff/services/demo-blueprints.js';
import { workflowStages, computeNextRun, handoffSources } from '../src/bff/services/automations.js';
import { createFoundryAdapter } from '../src/bff/adapters/foundry.js';
import { runtimeToolOptions } from '../src/bff/services/agents.js';

test('About source remains byte-identical to the approved original Novo page', () => {
  const content = readFileSync(new URL('../src/web/views/about.js', import.meta.url));
  assert.equal(createHash('sha256').update(content).digest('hex'), '43f42a42f2599de9cacb0ed8590bdeccd934e28bc0a024c5ef6f79e4b924a354');
});

test('knowledge bootstrap links verified resources using the actual raw Purview response contract', async () => {
  const writes = [], counters = { updated: 0, failed: 0 };
  const product = { id: 'cx-demo-inventory', name: 'Demo - Inventory levels' };
  const raw = { id: 'catalogue-guid', name: product.name, managedAttributes: [{ name: 'cortexDataFolder', value: product.id }], contacts: { owner: [{ id: 'owner' }] } };
  const result = await bootstrapKnowledge({
    products: [product], counters, log: { step() {}, ok() {}, fail() {} },
    listAllDataProducts: async () => [raw],
    purviewFetch: async (path, options) => { if (options) { writes.push(options.body); return options.body; } return raw; },
    search: {
      indexStats: async () => ({ documents: SAMPLE_PRODUCTS[product.id].rows }),
      ensureKnowledgeBase: async ({ name }) => ({ name, sourceName: `${name}-source`, mcp: 'https://search.example/mcp', reasoning: 'low' })
    },
    connect: async () => ({ id: 'connection-id' })
  });
  assert.equal(result.connected, 1);
  assert.equal(counters.failed, 0);
  assert.deepEqual(writes[0].contacts, raw.contacts);
  assert.equal(writes[0].managedAttributes.find((item) => item.name === 'cortexKnowledgeConnection').value, 'connection-id');
});

test('unverified or stale row counts do not receive a catalogue knowledge link', async () => {
  const counters = { updated: 0, failed: 0 };
  await bootstrapKnowledge({
    products: [{ id: 'cx-demo-inventory', name: 'Demo' }], counters,
    log: { step() {}, ok() {}, fail() {} }, listAllDataProducts: async () => [{ id: 'id', name: 'Demo' }],
    purviewFetch: async () => assert.fail('must not publish metadata'),
    search: { indexStats: async () => ({ documents: 1 }), ensureKnowledgeBase: async () => assert.fail('must not create a base') }
  });
  assert.equal(counters.failed, 1);
});

test('demo samples have a current explicit reporting window and integral request counts', () => {
  const lines = generateProduct('cx-demo-api-usage', {}, { rows: 30 }).csv.trim().split('\n').slice(1).map((line) => line.split(','));
  assert.ok(lines.every((row) => row[1] >= '2026-09-01' && row[1] <= '2026-09-21'));
  assert.ok(lines.every((row) => Number.isInteger(Number(row[4]))));
});

test('the request demo declares a real holder-supported question without widening source access', () => {
  const products = JSON.parse(readFileSync(new URL('../bootstrap/data-products.json', import.meta.url), 'utf8'));
  const capacity = products.find((product) => product.id === 'cx-demo-capacity');
  assert.ok(capacity.askable.some((question) => question.includes('operational capacity')));
  assert.deepEqual(capacity.allowedGroups, ['operations']);
  assert.equal(capacity.owner, 'Operations team');
});

test('publishing defaults resolve actual available resources rather than invented identifiers', () => {
  assert.equal(publishingDefaults('knowledge', '', { sources: [] }).sourceId, '');
  const values = publishingDefaults('knowledge', '', { sources: [{ id: 'real-id', name: 'Demo - Inventory levels' }] });
  assert.equal(values.sourceId, 'real-id');
  assert.equal(publishingDefaults('api-mcp', 'graphql', { connectors: [] }).connector, '');
  assert.match(publishingDefaults('api-mcp', 'graphql', { connectors: [{ id: 'cortex-demo-graphql' }] }).graphqlQuery, /rows\(first: 2\)/);
});

test('the five-agent demo uses three parallel branches and manual runs only', () => {
  const agents = DEMO_JOURNEY.agents.map((agent, i) => ({ name: agent.name, id: `agent-${i}` }));
  const form = demoWorkflowForm(agents);
  const steps = Array.from({ length: 5 }, (_, i) => ({ stage: form[`stepStage${i + 1}`] }));
  assert.deepEqual(workflowStages(steps).map((stage) => stage.length), [3, 1, 1]);
  assert.equal(form.cadence, 'manual');
  assert.equal(computeNextRun({ cadence: 'manual' }), null);
});

test('external wrappers must actually delegate instead of returning a generic model answer', async () => {
  assert.deepEqual(runtimeToolOptions({ _agent: { definition: { artefactId: 'source-wrapper' } } }), { requireToolUse: true });
  assert.deepEqual(runtimeToolOptions({ _agent: { definition: {} } }), {});
  const foundry = createFoundryAdapter();
  const bodies = [];
  foundry._post = async (body) => {
    bodies.push(body);
    return { status: 'completed', output: [{ type: 'mcp_call', server_label: 'source_agent', name: 'invoke', output: '{"answer":"Source answer"}' }, { type: 'message', content: [{ text: 'Source answer' }] }] };
  };
  const result = await foundry.respond({ agentName: 'wrapper', input: 'Hello', requireToolUse: true });
  assert.equal(bodies[0].tool_choice, 'required');
  assert.equal(result.toolCalls.some((call) => call.kind === 'call'), true);
  foundry._post = async () => ({ output: [{ type: 'message', content: [{ text: 'Generic answer' }] }] });
  await assert.rejects(foundry.respond({ agentName: 'wrapper', input: 'Hello', requireToolUse: true }), /not invoked/);
});

test('workflow handoffs preserve structured citations and report any truncation', () => {
  const source = { name: 'Inventory', url: 'https://example.test/source' };
  const evidence = JSON.parse(handoffSources([source, source]));
  assert.deepEqual(evidence, { citations: [source], omitted: 0 });
  const bounded = handoffSources(Array.from({ length: 100 }, (_, i) => ({ name: `Source ${i}`, url: `https://example.test/${i}/` + 'x'.repeat(500) })));
  assert.ok(JSON.parse(bounded).omitted > 0);
  assert.ok(bounded.length < 12100);
});
