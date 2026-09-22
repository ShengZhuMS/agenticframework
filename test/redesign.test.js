import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex, index, USERS } from './fixtures.js';
import { discoveryTarget } from '../src/bff/services/discovery.js';
import { guideAnswer } from '../src/bff/services/guide.js';
import * as auto from '../src/bff/services/automations.js';
import { ensureResponsibleAI, evidenceGates, evidenceFingerprint, UI_REVISION, saveAccessibility, MANUAL_CHECKS } from '../src/bff/services/evidence.js';
import { gatesFor } from '../src/bff/services/assurance.js';
import { configureStateBlob, primeState } from '../src/bff/state/store.js';
import { graphqlApiSpec, demoMetadata } from '../src/bff/services/artefacts.js';
import { startKnowledge, finishKnowledge } from '../src/bff/services/knowledge-publishing.js';
import { channelPackage } from '../src/bff/services/channel-package.js';
import { channelMetadata } from '../src/bff/adapters/channels.js';
import { unzipSync, strFromU8 } from 'fflate';
import { explainError } from '../src/bff/services/explain.js';
import { DEMO_JOURNEY, blueprintForm } from '../src/bff/services/demo-blueprints.js';
import config from '../src/bff/config.js';

let restore;
const user = USERS.analyst;
before(async () => { restore = await loadIndex(); });
after(() => restore());
beforeEach(async () => {
  configureStateBlob({ account: 'stub', backend: { list: async () => [], get: async () => '{}', put: async () => {} } });
  await primeState();
  auto.clearAutomations();
  for (const id of ['plan-agent', 'review-agent', 'join-agent']) index.upsert({
    id, name: id, cat: 'Agent', allowedGroups: ['all-staff'], _source: { id, system: 'foundry' },
    _agent: { version: '1', definition: { builtById: user.id, model: 'stub', instructions: 'Read and cite', actions: ['read', 'summarise'] } }
  });
});

test('single entry input classifies questions, preserves keyword search and respects override', () => {
  assert.equal(discoveryTarget('How do I find API usage').path, '/ask');
  assert.equal(discoveryTarget('API usage').path, '/cortex');
  assert.equal(discoveryTarget('how to', 'search').path, '/cortex');
  assert.equal(discoveryTarget('API usage', 'ask').path, '/ask');
  assert.throws(() => discoveryTarget(''), /Enter/);
  assert.throws(() => discoveryTarget('hello', 'bad'), /Choose/);
});

test('guide uses curated context only, retains citations and surfaces model failure', async () => {
  const result = await guideAnswer('How do I use Cortex?', { foundry: { complete: async (request) => {
    assert.match(request.instructions, /No tools/);
    assert.ok(!request.input.includes('stub-apim-key'));
    return { text: 'Start from the front door. [start]' };
  } } });
  assert.equal(result.sources[0].id, 'start');
  await assert.rejects(guideAnswer('Help', { foundry: { complete: async () => { throw new Error('offline'); } } }), /offline/);
});

test('progressive editor adds parallel and next stages, caps width and total, and can remove', () => {
  let form = { stepCount: 1, stepAgent1: 'plan-agent', stepInstruction1: 'Plan', stepStage1: 1 };
  form = auto.editSteps(form, 'parallel:1');
  form = auto.editSteps(form, 'parallel:1');
  assert.throws(() => auto.editSteps(form, 'parallel:1'), /Three/);
  form = auto.editSteps(form, 'next:1');
  assert.equal(form.stepStage4, 2);
  form = auto.editSteps(form, 'next:4');
  assert.equal(form.stepCount, 5);
  assert.throws(() => auto.editSteps(form, 'next:5'), /Five/);
  form = auto.editSteps(form, 'remove:4');
  assert.equal(form.stepStage4, 2);
});

test('parallel calls overlap and the join receives every successful branch in order', async () => {
  const definition = { name: 'Parallel', kind: 'workflow', question: 'Analyse', purpose: 'Review', cadence: 'daily',
    owner: user, steps: [{ agentId: 'plan-agent', instruction: 'Plan', stage: 1 }, { agentId: 'review-agent', instruction: 'Review', stage: 1 }, { agentId: 'join-agent', instruction: 'Combine', stage: 2 }] };
  const automation = auto.create(definition);
  let active = 0, max = 0;
  const run = await auto.runNow(automation.id, { user, foundry: { respond: async ({ agentName, input }) => {
    active++; max = Math.max(max, active);
    if (agentName === 'join-agent') { assert.match(input, /plan-agent/); assert.match(input, /review-agent/); assert.equal(active, 1); }
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return { text: `${agentName} result` };
  } } });
  assert.equal(max, 2); assert.equal(run.status, 'ok'); assert.equal(run.steps.length, 3);
});

test('a failed parallel branch waits for its sibling and never runs the join', async () => {
  const a = auto.create({ name: 'Failure', kind: 'workflow', cadence: 'daily', owner: user, steps: [
    { agentId: 'plan-agent', stage: 1 }, { agentId: 'review-agent', stage: 1 }, { agentId: 'join-agent', stage: 2 }
  ] });
  const called = [];
  const run = await auto.runNow(a.id, { user, foundry: { respond: async ({ agentName }) => {
    called.push(agentName);
    if (agentName === 'plan-agent') throw new Error('Tool denied');
    await new Promise((resolve) => setTimeout(resolve, 10)); return { text: 'Sibling finished' };
  } } });
  assert.equal(run.status, 'failed'); assert.deepEqual(called, ['plan-agent', 'review-agent']);
  assert.equal(run.steps[1].status, 'ok');
});

test('AI proposal is validated and never creates or executes an automation', async () => {
  const form = await auto.suggestWorkflow('Review data', user, { foundry: { complete: async () => ({ text: JSON.stringify({
    name: 'Review', purpose: 'Human review', steps: [{ agentId: 'plan-agent', instruction: 'Review', stage: 1 }]
  }) }) } });
  assert.equal(form.stepCount, 1); assert.equal(auto.list().length, 0);
  await assert.rejects(auto.suggestWorkflow('Review', user, { foundry: { complete: async () => ({ text: '{"steps":[{"agentId":"missing","instruction":"x","stage":1}]}' }) } }), /correction/);
});

test('RAI reports are automatic, cached and refreshed after a material change', () => {
  const entry = index.get('plan-agent');
  const report = ensureResponsibleAI(entry);
  assert.equal(report.checks.length, 6);
  assert.equal(report.jurisdiction, 'Not assessed');
  assert.equal(ensureResponsibleAI(index.get(entry.id)), report);
  const changed = { ...entry, _agent: { ...entry._agent, version: '2' } };
  assert.notEqual(ensureResponsibleAI(changed).fingerprint, report.fingerprint);
  const gates = evidenceGates(changed, gatesFor(changed._agent.definition));
  assert.equal(gates.find((gate) => gate.id === 'redteam').label, 'Not run');
});

test('accessibility reports reject stale evidence and distinguish manual from automated checks', () => {
  const entry = index.get('plan-agent');
  const identity = { fingerprint: evidenceFingerprint(entry), uiRevision: UI_REVISION };
  assert.throws(() => saveAccessibility(entry, user, { ...identity, uiRevision: 'old' }), /changed/);
  saveAccessibility(entry, user, { ...identity, automatic: { version: 'axe', passes: 10, violations: [], incomplete: [] } });
  let latest = index.get(entry.id);
  assert.equal(evidenceGates(latest, gatesFor(latest._agent.definition)).find((gate) => gate.id === 'a11y').label, 'Manual review required');
  saveAccessibility(latest, user, { ...identity, ...Object.fromEntries(MANUAL_CHECKS.map(([id]) => [id, 'yes'])) });
  latest = index.get(entry.id);
  assert.equal(evidenceGates(latest, gatesFor(latest._agent.definition)).find((gate) => gate.id === 'a11y').label, 'Recorded checks passed');
});

test('GraphQL MCP exposes fixed query templates, not mutations or arbitrary endpoints', () => {
  const spec = graphqlApiSpec('query($id: ID!) { item(id: $id) { name } }', 'graphql');
  assert.equal(spec.operations[0].method, 'post');
  assert.equal(spec.spec.paths['/query'].post.operationId, 'query');
  assert.throws(() => graphqlApiSpec('mutation { deleteAll }'), /mutations/);
  assert.throws(() => graphqlApiSpec('{ a } query B { b }'), /exactly one/);
  assert.throws(() => graphqlApiSpec('{ a }', '../admin'), /relative/);
  assert.equal(demoMetadata({ name: 'Demo' }, user).version, '1.0.0');
});

test('knowledge publication waits for ingestion, then persists an actual KB and Foundry connection', async () => {
  const job = await startKnowledge({ sourceId: 'p-water-quality', name: 'Knowledge', confirm: 'yes' }, user, { build: async () => ({
    index: 'test-index', indexer: 'test-indexer', run: { started: false }
  }) });
  const search = { indexerStatus: async () => ({ lastRun: null }) };
  await finishKnowledge(job.id, user, { search });
  assert.equal(job.status, 'indexing');
  search.indexerStatus = async () => ({ lastRun: { status: 'success', failed: 0, ended: new Date().toISOString() } });
  search.indexStats = async () => ({ documents: 5 });
  search.ensureKnowledgeBase = async ({ name }) => ({ name, sourceName: 'knowledge-source', mcp: 'https://search.stub/knowledgebases/test/mcp' });
  await finishKnowledge(job.id, user, { search, connect: async () => ({ id: 'connection-id' }) });
  assert.equal(job.status, 'published');
  assert.equal(index.get(job.entryId)._knowledge.connectionId, 'connection-id');
  assert.deepEqual(index.get(job.entryId).allowedGroups, index.get('p-water-quality').allowedGroups);
});

test('channel ZIP includes valid icon dimensions and declares delivery unverified', () => {
  const entry = index.get('plan-agent');
  const metadata = channelMetadata({ name: 'Cortex demo', version: '1.0.0', purpose: 'Demo', description: 'Demo agent', owner: 'Demo team',
    developerWebsiteUrl: 'https://app.example', privacyUrl: 'https://app.example/privacy', termsOfUseUrl: 'https://app.example/terms' }, { requireConsent: false });
  const pack = channelPackage(entry, { instance_identity: { client_id: '00000000-0000-4000-8000-000000000001' } }, metadata, user, 'https://app.example');
  const files = unzipSync(pack.bytes);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  assert.equal(manifest.bots[0].botId, manifest.copilotAgents.customEngineAgents[0].id);
  assert.equal(Buffer.from(files['color.png']).readUInt32BE(16), 192);
  assert.equal(Buffer.from(files['outline.png']).readUInt32BE(16), 32);
  assert.match(strFromU8(files['INSTALLATION.txt']), /NOT VERIFIED/);
});

test('Search denial explains the failing service rather than blaming a popup', () => {
  const error = explainError(new Error('Foundry failed 400: Access denied. Check your permissions or managed identity access to the search service.'));
  assert.equal(error.heading, 'Foundry cannot access the Search index');
});

test('knowledge base pins stable minimal extractive MCP without a planning model', async () => {
  const original = index.search._fetch;
  const calls = [];
  index.search._fetch = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.startsWith('/indexes/')) return { semantic: { defaultConfiguration: 'default' } };
    if (path.startsWith('/knowledgebases/') && !options.method) return { knowledgeSources: [{ name: 'demo-source' }], retrievalReasoningEffort: { kind: 'minimal' } };
    return {};
  };
  try {
    const result = await index.search.ensureKnowledgeBase({ name: 'demo', indexName: 'index', description: 'Demo' });
    const put = calls.find((call) => call.path === '/knowledgebases/demo' && call.method === 'PUT');
    assert.equal(put.body.models, undefined);
    assert.equal(put.apiVersion, '2026-04-01');
    assert.match(result.mcp, /api-version=2026-04-01$/);
  } finally { index.search._fetch = original; }
});

test('demo blueprints resolve only available synthetic sources and never create agents', () => {
  const blueprint = DEMO_JOURNEY.agents[0];
  assert.throws(() => blueprintForm('0', []), /registered and accessible/);
  const form = blueprintForm('0', [{ name: blueprint.knowledge[0], id: 'source-id', attachable: true }]);
  assert.deepEqual(form.knowledge, ['source-id']);
  assert.equal(form.name, blueprint.name);
  assert.throws(() => blueprintForm('99', []), /listed/);
});

test('explicit planner configuration binds the existing model without credentials or new deployment', async () => {
  const original = index.search._fetch;
  const calls = [];
  config.search.knowledgeModelName = 'gpt-5-mini';
  config.search.knowledgeModelEndpoint = 'https://configured.openai.azure.com';
  index.search._fetch = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.startsWith('/indexes/')) return { semantic: { defaultConfiguration: 'default' } };
    return { knowledgeSources: [{ name: 'planned-source' }] };
  };
  try {
    const result = await index.search.ensureKnowledgeBase({ name: 'planned', indexName: 'index', description: 'Demo' });
    const body = calls.find((call) => call.path === '/knowledgebases/planned' && call.method === 'PUT').body;
    assert.equal(body.models[0].azureOpenAIParameters.deploymentId, config.foundry.model);
    assert.equal(body.models[0].azureOpenAIParameters.apiKey, undefined);
    assert.equal(result.reasoning, 'low');
    assert.match(result.mcp, /2026-08-01-preview$/);
  } finally {
    index.search._fetch = original;
    config.search.knowledgeModelName = ''; config.search.knowledgeModelEndpoint = '';
  }
});

test('rebuilds use the version collection rather than creating a conflicting agent', async () => {
  const original = index.foundry._fetch;
  const calls = [];
  index.foundry._fetch = async (path, request) => { calls.push({ path, ...request }); return { name: 'existing', version: '2' }; };
  try {
    await index.foundry.createAgent({ name: 'existing', model: 'gpt-5-mini', instructions: 'Preserved', createVersion: true });
    assert.equal(calls[0].path, '/agents/existing/versions');
    assert.equal(calls[0].body.name, undefined);
    assert.equal(calls[0].body.definition.instructions, 'Preserved');
    await index.foundry.createAgent({ name: 'new', instructions: 'New agent' });
    assert.equal(calls[1].path, '/agents');
    assert.equal(calls[1].body.name, 'new');
  } finally { index.foundry._fetch = original; }
});
