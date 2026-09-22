import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FoundryRedTeam } from '../src/bff/adapters/redteam.js';
import * as redteam from '../src/bff/services/redteam.js';
import { collection, configureState, configureStateBlob, primeState } from '../src/bff/state/store.js';
import index from '../src/bff/index/store.js';
import { redTeamPage } from '../src/web/views/redteam.js';

const user = { id: 'builder-1', name: 'Demo builder', groups: ['all-staff'] };
const entry = { id: 'rt-agent', name: 'Demo agent', cat: 'Agent', _source: { id: 'native-name' }, _agent: { definition: { builtById: user.id } } };
const cfg = { projectEndpoint: 'https://stub.services.ai.azure.com/api/projects/demo', model: 'evaluator', scope: 'https://ai.azure.com/.default' };
const foundry = { getAgent: async () => ({ versions: { latest: { version: '7' } } }) };
const fakeAdapter = () => ({
  createEvaluation: async () => ({ id: 'eval-1' }),
  createTaxonomy: async () => ({ id: 'azureai://taxonomy/versions/1', taxonomyCategories: [{ id: 'boundary', name: 'Synthetic boundary', subCategories: [] }] }),
  enableTaxonomy: async () => ({ id: 'azureai://taxonomy/versions/2', taxonomyCategories: [{ subCategories: [{ enabled: true }] }] }),
  start: async () => ({ id: 'run-1', status: 'queued' }),
  getRun: async () => ({ status: 'completed' }),
  outputItems: async () => [{ id: 'item-1' }]
});

beforeEach(async () => {
  configureStateBlob({ account: 'stub', container: 'state', backend: {
    list: async () => [], get: async () => '{}', put: async () => {}
  } });
  await primeState();
  index.upsert(entry);
});

test('native API requests use versioned agent, evaluators, taxonomy and bounded strategies', async () => {
  const calls = [];
  const adapter = new FoundryRedTeam(cfg, {
    tokenFn: async (scope) => { assert.equal(scope, cfg.scope); return 'stub'; },
    fetchFn: async (url, init) => {
      calls.push({ url, ...init, body: JSON.parse(init.body || '{}') });
      return Response.json({ id: 'native-id' });
    }
  });
  await adapter.createEvaluation('test');
  const target = { type: 'azure_ai_agent', name: 'native-name', version: '7' };
  await adapter.createTaxonomy('taxonomy', target);
  await adapter.start({ id: 'rt-test', evalId: 'eval-1', taxonomy: { id: 'azureai://taxonomy' }, target });
  assert.ok(calls.every((c) => c.url.searchParams.get('api-version') === '2025-11-15-preview'));
  assert.equal(calls[0].body.testing_criteria.length, 3);
  assert.equal(calls[0].body.testing_criteria[1].initialization_parameters.deployment_name, 'evaluator');
  assert.deepEqual(calls[1].body.taxonomyInput.target, target);
  assert.equal(calls[2].body.data_source.target.version, '7');
  assert.equal(calls[2].body.data_source.item_generation_params.num_turns, 5);
  assert.deepEqual(calls[2].body.data_source.item_generation_params.attack_strategies, ['Flip', 'Base64', 'IndirectJailbreak']);
  await adapter.enableTaxonomy('taxonomy', { id: 'azureai://taxonomy/versions/1', name: 'taxonomy', version: '1',
    taxonomyCategories: [{ name: 'Generated', subCategories: [{ id: 's', enabled: false }] }] });
  assert.equal(calls[3].method, 'PATCH');
  assert.equal(calls[3].body.id, 'azureai://taxonomy/versions/1');
  assert.equal(calls[3].body.taxonomyCategories[0].subCategories[0].enabled, true);
});

test('preparation pins version, review is separate, results are private and retained', async () => {
  const adapter = fakeAdapter();
  const r = await redteam.prepare(entry, user, { adapter, foundry });
  assert.equal(r.status, 'review-required');
  assert.equal(r.runId, undefined);
  assert.equal(r.target.version, '7');
  assert.equal(redteam.runsFor(entry.id, { id: 'someone-else' }).length, 0);
  assert.equal(redteam.runsFor(entry.id, {}).length, 0);
  await assert.rejects(redteam.act(r.id, { id: 'someone-else' }, 'start', { adapter }), /belong/);
  await redteam.act(r.id, user, 'start', { adapter });
  assert.equal(r.status, 'queued');
  await redteam.act(r.id, user, 'refresh', { adapter });
  assert.equal(r.status, 'completed');
  assert.equal(r.items.length, 1);
  assert.equal(entry._agent.assurance, undefined);
});

test('uncertain submission is not retried and authorization is rechecked', async () => {
  const adapter = fakeAdapter();
  let calls = 0;
  adapter.start = async () => { calls++; throw new Error('Timeout after submission'); };
  const r = await redteam.prepare(entry, user, { adapter, foundry });
  await redteam.act(r.id, user, 'start', { adapter });
  assert.equal(r.status, 'submission-unknown');
  await redteam.act(r.id, user, 'start', { adapter });
  assert.equal(calls, 1);
  index.upsert({ ...entry, _agent: { definition: {} } });
  await assert.rejects(redteam.act(r.id, user, 'start', { adapter }), /no longer/);
});

test('missing persistent state or invalid agent version prevents billable setup', async () => {
  const adapter = fakeAdapter();
  adapter.createEvaluation = async () => { assert.fail('must not call Azure'); };
  await assert.rejects(redteam.prepare(entry, user, { adapter, foundry: { getAgent: async () => ({}) } }), /version/);
  configureState('');
  await assert.rejects(redteam.prepare(entry, user, { adapter, foundry }), /Persistent state/);
  assert.equal(redteam.canRedTeam(entry, { groups: ['cortex-redteam'] }), false);
});

test('a taxonomy reference without generated categories cannot be approved', async () => {
  const adapter = fakeAdapter();
  const generated = await adapter.createTaxonomy();
  adapter.createTaxonomy = async () => ({ id: generated.id });
  adapter.getTaxonomy = async () => generated;
  adapter.start = async () => assert.fail('must not submit before taxonomy review');
  const r = await redteam.prepare(entry, user, { adapter, foundry });
  assert.equal(r.status, 'taxonomy-pending');
  await redteam.act(r.id, user, 'start', { adapter });
  assert.equal(r.status, 'taxonomy-pending');
  await redteam.act(r.id, user, 'refresh', { adapter });
  assert.equal(r.status, 'review-required');
});

test('output pagination follows cursors and rejects repeated cursors and HTTP errors', async () => {
  const urls = [];
  const adapter = new FoundryRedTeam(cfg, { tokenFn: async () => 'stub', fetchFn: async (url) => {
    urls.push(url);
    return Response.json(url.searchParams.has('after') ? { data: [{ id: 'b' }], has_more: false } : { data: [{ id: 'a' }], has_more: true, last_id: 'a' });
  } });
  assert.deepEqual(await adapter.outputItems({ evalId: 'e', runId: 'r' }), [{ id: 'a' }, { id: 'b' }]);
  assert.equal(urls[1].searchParams.get('after'), 'a');
  adapter.fetch = async () => Response.json({ data: [{ id: 'a' }], has_more: true });
  await assert.rejects(adapter.outputItems({ evalId: 'e', runId: 'r' }), /cursor/);
  adapter.fetch = async () => new Response('Forbidden', { status: 403 });
  await assert.rejects(adapter.getRun({ evalId: 'e', runId: 'r' }), /403/);
});

test('assessment output is escaped rather than executable HTML', async () => {
  const r = await redteam.prepare(entry, user, { adapter: fakeAdapter(), foundry });
  r.result = { malicious: '<script>alert(1)</script>' };
  const html = redTeamPage({ user }, { entry, runs: [r] });
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.equal(collection('redteam-runs', {}).data[r.id].target.version, '7');
});
