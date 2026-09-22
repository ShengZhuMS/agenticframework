import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyPlan, confirmationFor, resourceUrl, requestResource, targetScope, cortexOwnedAgentIds } from '../scripts/reset-content.js';

const fingerprint = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex');
const makePlan = () => ({
  version: 1, scope: targetScope(),
  items: ['first', 'second'].map((id) => ({ kind: 'api', id, fingerprint: fingerprint({ id }) }))
});

test('a reset requires exact confirmation and stopped writers before any requests', async () => {
  const plan = makePlan();
  const request = async () => assert.fail('no request permitted');
  await assert.rejects(applyPlan(plan, { request }), /confirmation/);
  await assert.rejects(applyPlan(plan, { request, confirmation: confirmationFor(plan) }), /confirmation/);
  const altered = { ...plan, scope: { ...plan.scope, apim: 'another-service' } };
  await assert.rejects(applyPlan(altered, { request, confirmation: confirmationFor(altered), writersStopped: true }), /targets differ/);
});

test('a stale resource anywhere in the plan prevents all deletes', async () => {
  const plan = makePlan();
  const methods = [];
  const request = async (item, scope, method = 'GET') => { methods.push(method); return { body: { id: item.id === 'second' ? 'changed' : item.id } }; };
  await assert.rejects(applyPlan(plan, { confirmation: confirmationFor(plan), writersStopped: true, request }), /changed/);
  assert.ok(methods.every((m) => m === 'GET'));
});

test('an active scan blocks the entire apply phase', async () => {
  const plan = makePlan();
  plan.items[0].kind = 'scan';
  plan.items[0].parent = 'sample-source';
  const request = async (item, scope, method = 'GET') => {
    assert.equal(method, 'GET');
    return { body: { id: item.id } };
  };
  await assert.rejects(applyPlan(plan, {
    confirmation: confirmationFor(plan), writersStopped: true, request,
    scanCheck: async () => { throw new Error('Scan is running'); }
  }), /Scan is running/);
});

test('applies exact items, waits for absence, saves progress and resumes without duplicate deletes', async () => {
  const plan = makePlan();
  const confirmation = confirmationFor(plan);
  const live = new Set(['first', 'second']);
  const deletes = [];
  let saves = 0;
  let fail = true;
  const request = async (item, scope, method = 'GET') => {
    if (method === 'DELETE') {
      if (item.id === 'second' && fail) throw new Error('Simulated failure');
      deletes.push(item.id);
      live.delete(item.id);
      return null;
    }
    return live.has(item.id) ? { body: { id: item.id } } : null;
  };
  const options = { confirmation, writersStopped: true, request, save: () => saves++, sleep: async () => {} };
  await assert.rejects(applyPlan(plan, options), /Simulated/);
  assert.equal(plan.items[0].done, true);
  assert.equal(confirmationFor(plan), confirmation);
  fail = false;
  await applyPlan(plan, options);
  assert.deepEqual(deletes, ['first', 'second']);
  assert.equal(saves, 2);
});

test('resource kinds are allowlisted and ids cannot replace the destination host', async () => {
  const scope = { ...targetScope(), subscription: 'sub', apimGroup: 'rg', apim: 'apim' };
  assert.throws(() => resourceUrl({ kind: 'resourceGroup', id: 'rg' }, scope), /Unsupported/);
  const item = { kind: 'api', id: 'https://evil.example/path', etag: '"version"' };
  const url = resourceUrl(item, scope).url;
  assert.equal(new URL(url).host, 'management.azure.com');
  assert.ok(url.includes('https%3A%2F%2Fevil.example%2Fpath'));
  await requestResource(item, scope, 'DELETE', { tokenFn: async () => 'stub', fetchFn: async (requested, init) => {
    assert.equal(requested, url);
    assert.equal(init.headers['If-Match'], '"version"');
    return new Response(null, { status: 204 });
  } });
});

test('multi-app reset scopes state blobs to explicitly selected containers', () => {
  const scope = { ...targetScope(), stateAccount: 'stateaccount', stateContainer: 'state',
    stateContainers: ['state', 'state-cortex-web-microsoft', 'state-cortex-web-novo'] };
  assert.match(resourceUrl({ kind: 'stateBlob', id: 'chats.json', parent: 'state-cortex-web-novo' }, scope).url, /\/state-cortex-web-novo\/chats\.json/);
  assert.throws(() => resourceUrl({ kind: 'stateBlob', id: 'chats.json', parent: 'unrelated-state' }, scope), /outside/);
  assert.match(resourceUrl({ kind: 'scan', id: 'scan', parent: 'sample-source' }, { ...scope, dataMap: 'https://example.purview.azure.com' }).url, /datasources\/sample-source\/scans\/scan/);
});

test('knowledge objects use their supported API without widening reset to infrastructure', () => {
  const scope = { ...targetScope(), search: 'https://example.search.windows.net' };
  assert.match(resourceUrl({ kind: 'knowledgebases', id: 'cx-kb-demo' }, scope).url, /\/knowledgebases\/cx-kb-demo\?api-version=2026-08-01-preview$/);
  assert.match(resourceUrl({ kind: 'knowledgesources', id: 'cx-kb-demo-source' }, scope).url, /\/knowledgesources\//);
  assert.throws(() => resourceUrl({ kind: 'searchService', id: 'example' }, scope), /Unsupported/);
});

test('merely discovering an external agent does not make it owned demo content', () => {
  const ids = cortexOwnedAgentIds([
    { id: 'external', _agent: { version: '5' } },
    { id: 'built', _agent: { definition: { builtById: 'owner' } } },
    { id: 'published', _agent: { apimApiId: 'published-api' } },
    { id: 'unrelated', _agent: { apimApiId: 'some-other-api' } }
  ], [{ agentId: 'wrapper' }]);
  assert.deepEqual([...ids], ['built', 'published', 'wrapper']);
});

test('provider deleted:false is a failure even with HTTP 200', async () => {
  const scope = { ...targetScope(), foundry: 'https://example.services.ai.azure.com/api/projects/demo' };
  await assert.rejects(requestResource({ kind: 'evaluation', id: 'eval-demo' }, scope, 'DELETE', {
    tokenFn: async () => 'stub', fetchFn: async () => Response.json({ object: 'eval.deleted', deleted: false })
  }), /deleted:false/);
});

test('relationship reads select only the approved pair and absence is confirmed', async () => {
  const scope = { ...targetScope(), purview: 'https://api.purview-service.microsoft.com' };
  const item = { kind: 'relationship', id: 'asset-a', parent: 'product-a' };
  const read = await requestResource(item, scope, 'GET', {
    tokenFn: async () => 'stub', fetchFn: async () => Response.json({ value: [{ entityId: 'asset-a', relationshipType: 'Related' }, { entityId: 'other' }] })
  });
  assert.equal(read.body.entityId, 'asset-a');
  assert.equal(await requestResource(item, scope, 'GET', {
    tokenFn: async () => 'stub', fetchFn: async () => Response.json({ value: [{ entityId: 'other' }] })
  }), null);
});
