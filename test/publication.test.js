import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex, index, USERS } from './fixtures.js';
import { configureStateBlob, primeState } from '../src/bff/state/store.js';
import { requestPublication, advancePublications, publishAgent } from '../src/bff/services/publish.js';
import { publicationVerdict } from '../src/bff/services/redteam.js';

let restore, originalGet, fetchBefore, version, result, calls;
const user = USERS.analyst;
const complete = () => ({
  result_counts: { total: 1, passed: 1, failed: 0 }, status: 'completed'
});
const items = () => [{ id: 'out-1', status: 'pass', results: ['Prohibited actions', 'Task adherence', 'Sensitive data leakage'].map((name) => ({ name, passed: true })) }];
beforeEach(async () => {
  restore = await loadIndex();
  configureStateBlob({ account: 'stub', backend: { list: async () => [], get: async () => '{}', put: async () => {} } });
  await primeState();
  index.upsert({ id: 'auto-test', name: 'Auto test', cat: 'Agent', allowedGroups: ['all-staff'],
    _source: { system: 'foundry', id: 'auto-test' },
    _agent: { published: false, definition: { builtById: user.id } } });
  originalGet = index.foundry.getAgent;
  version = '1';
  index.foundry.getAgent = async () => ({ version });
  result = complete();
  calls = [];
  fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method || 'GET' });
    if (path.endsWith('/openai/evals')) return Response.json({ id: 'eval-pub' });
    if (path.includes('/evaluationtaxonomies/')) return Response.json({ id: 'taxonomy-file', taxonomyInput: { type: 'agent' }, taxonomyCategories: [{ name: 'Synthetic policy', subCategories: [{ name: 'Boundary', enabled: true }] }] });
    if (path.endsWith('/runs') && init.method === 'POST') return Response.json({ id: 'run-pub', status: 'queued' });
    if (path.endsWith('/runs/run-pub')) return Response.json(result);
    if (path.endsWith('/output_items')) return Response.json({ data: items(), has_more: false });
    return fetchBefore(url, init);
  };
});
afterEach(() => { globalThis.fetch = fetchBefore; index.foundry.getAgent = originalGet; restore(); });

test('one request automatically runs native assessment then publishes the tested version', async () => {
  const r = await requestPublication('auto-test', { user, baseUrl: 'https://stub', visibility: 'all' });
  assert.equal(r.publication.status, 'assessing');
  assert.equal(index.get('auto-test')._agent.published, false);
  await advancePublications();
  assert.equal(r.runId, 'run-pub');
  assert.equal(index.get('auto-test')._agent.published, false);
  await advancePublications();
  assert.equal(r.publication.status, 'published');
  assert.equal(index.get('auto-test')._agent.publishedVersion, '1');
  assert.equal(index.get('auto-test')._agent.assessmentId, r.id);
  assert.equal(calls.filter((c) => c.path.endsWith('/runs') && c.method === 'POST').length, 1);
});

test('repeat publication requests reuse the pending assessment rather than billing twice', async () => {
  const first = await requestPublication('auto-test', { user, baseUrl: 'https://stub' });
  const second = await requestPublication('auto-test', { user, baseUrl: 'https://stub' });
  assert.equal(first.id, second.id);
  assert.equal(calls.filter((c) => c.path.endsWith('/openai/evals')).length, 1);
});

test('failed results block all APIM publishing', async () => {
  const r = await requestPublication('auto-test', { user, baseUrl: 'https://stub' });
  result = { ...complete(), result_counts: { passed: 0, failed: 1, errored: 0 } };
  await advancePublications();
  await advancePublications();
  assert.equal(r.publication.status, 'blocked');
  assert.equal(index.get('auto-test')._agent.published, false);
  assert.ok(!calls.some((c) => c.path.includes('/apis/') && c.method === 'PUT'));
});

test('changed agent version and missing evidence cannot bypass the gate', async () => {
  await assert.rejects(publishAgent('auto-test', { user, baseUrl: 'https://stub' }), /assessment/);
  const r = await requestPublication('auto-test', { user, baseUrl: 'https://stub' });
  await advancePublications();
  version = '2';
  await advancePublications();
  assert.equal(r.publication.status, 'blocked');
  assert.match(r.publication.error, /changed/);
  await assert.rejects(requestPublication('auto-test', { user: { id: 'other' }, baseUrl: 'https://stub' }), /builder/);
});

test('empty, partial, errored and missing-grader reports fail closed', () => {
  const valid = { status: 'completed', result: complete(), items: items() };
  assert.equal(publicationVerdict(valid).passed, true);
  for (const changes of [
    { items: [] }, { items: [{ status: 'pass', results: [{ passed: true }] }] },
    { error: 'Fetching output failed' }, { status: 'failed' },
    { items: [{ status: 'pass', results: Array(3).fill({ name: 'Task adherence', passed: true }) }] },
    { result: { result_counts: { total: 2, passed: 1, failed: 0 } } },
    { result: { ...complete(), error: { message: 'Evaluator unavailable' } } },
    { result: { result_counts: { passed: 1, failed: 0, errored: 1 } } }
  ]) assert.equal(publicationVerdict({ ...valid, ...changes }).passed, false);
});

test('explicit advisory acknowledgement publishes the current version without fabricating scan evidence', async () => {
  const entry = index.get('auto-test');
  index.upsert({ ...entry, _agent: { ...entry._agent, version: '1' } });
  const result = await requestPublication(entry.id, { user, baseUrl: 'https://stub', acknowledge: true });
  assert.equal(result.entry._agent.published, true);
  assert.equal(result.entry._agent.assessmentId, null);
  assert.equal(result.entry._agent.assuranceAcknowledgement.by, user.id);
  assert.ok(result.entry._agent.assuranceAcknowledgement.findings.some((finding) => finding.id === 'redteam'));
  assert.equal(calls.some((call) => call.path.endsWith('/openai/evals')), false);
});
