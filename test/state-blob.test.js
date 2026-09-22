/**
 * State in blobs — the deployed persistence shape since round 6.
 *
 * The rule under test: nothing is written unless the blobs were read first.
 * A start with storage unreachable must serve from memory, say so on the
 * health endpoint, and never overwrite what is in the container.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configureState, configureStateBlob, primeState, collection, flushAll, stateHealth, __resetState } from '../src/bff/state/store.js';

function fakeBackend(initial = {}, { failList = false, slow = false } = {}) {
  const blobs = new Map(Object.entries(initial));
  const calls = { list: 0, get: 0, put: 0 };
  return {
    blobs,
    calls,
    list: async () => {
      calls.list++;
      if (failList) throw new Error('Storage GET /state failed 403 (AuthorizationFailure): refused');
      if (slow) return new Promise(() => {});
      return [...blobs.keys()];
    },
    get: async (name) => {
      calls.get++;
      return blobs.has(name) ? blobs.get(name) : null;
    },
    put: async (name, body) => {
      calls.put++;
      blobs.set(name, body);
    }
  };
}

afterEach(() => {
  configureState('');
  __resetState();
});

describe('blob-backed state', () => {
  test('primes every collection from the container and writes changes back as JSON', async () => {
    const backend = fakeBackend({ 'requests.json': JSON.stringify({ seq: 7, items: { a: { id: 'a' } } }) });
    configureStateBlob({ account: 'ststate', container: 'state', backend });
    const primed = await primeState();
    assert.equal(primed.mode, 'blob');
    assert.equal(primed.primed, 1);

    const c = collection('requests', { seq: 0, items: {} });
    assert.equal(c.data.seq, 7, 'loaded from the blob');
    assert.equal(c.persisted, true);

    c.data.seq = 8;
    c.data.items.b = { id: 'b' };
    await c.flush();
    assert.equal(backend.calls.put, 1);
    assert.deepEqual(JSON.parse(backend.blobs.get('requests.json')).items.b, { id: 'b' });

    const h = stateHealth();
    assert.equal(h.mode, 'blob');
    assert.equal(h.ok, true);
    assert.equal(h.directory, 'https://ststate.blob.core.windows.net/state');
    assert.equal(h.collections[0].records, 2);
  });

  test('a collection with no blob yet starts from its empty shape and is created on first save', async () => {
    const backend = fakeBackend();
    configureStateBlob({ account: 'ststate', backend });
    await primeState();
    const c = collection('chats', []);
    assert.deepEqual(c.data, []);
    c.data.push({ id: 1 });
    await c.flush();
    assert.equal(JSON.parse(backend.blobs.get('chats.json')).length, 1);
  });

  test('a newer shape keeps its new keys when an older document is loaded', async () => {
    const backend = fakeBackend({ 'shape.json': JSON.stringify({ seq: 1, items: {} }) });
    configureStateBlob({ account: 'ststate', backend });
    await primeState();
    const v2 = collection('shape', { seq: 0, items: {}, methods: {} });
    assert.deepEqual(Object.keys(v2.data).sort(), ['items', 'methods', 'seq']);
    assert.equal(v2.data.seq, 1);
  });

  test('when the blobs cannot be read, the app runs on memory, reports it, and never writes', async () => {
    const backend = fakeBackend({ 'requests.json': JSON.stringify({ seq: 99, items: {} }) }, { failList: true });
    configureStateBlob({ account: 'ststate', backend });
    const primed = await primeState();
    assert.equal(primed.mode, 'memory');
    assert.match(primed.error, /AuthorizationFailure/);

    const c = collection('requests', { seq: 0, items: {} });
    assert.equal(c.persisted, false);
    assert.equal(c.data.seq, 0, 'the unreadable blob is not guessed at');
    c.data.seq = 1;
    c.save();
    await flushAll();
    assert.equal(backend.calls.put, 0, 'nothing may be written over state that was never read');
    assert.equal(backend.blobs.get('requests.json'), JSON.stringify({ seq: 99, items: {} }), 'the real state is untouched');

    const h = stateHealth();
    assert.equal(h.mode, 'memory');
    assert.equal(h.ok, false);
    assert.match(h.error, /AuthorizationFailure/);
  });

  test('a storage account that never answers is given up on after the timeout, not forever', async () => {
    const backend = fakeBackend({}, { slow: true });
    configureStateBlob({ account: 'ststate', backend });
    const started = Date.now();
    const primed = await primeState({ timeoutMs: 50 });
    assert.ok(Date.now() - started < 2000);
    assert.equal(primed.mode, 'memory');
    assert.match(primed.error, /no answer from blob storage/);
  });

  test('a failed write is recorded on the collection and the health endpoint, and the next write retries', async () => {
    const backend = fakeBackend();
    let fail = true;
    backend.put = async (name, body) => {
      if (fail) throw new Error('Storage PUT /state/x.json failed 503: busy');
      backend.blobs.set(name, body);
    };
    configureStateBlob({ account: 'ststate', backend });
    await primeState();
    const c = collection('x', []);
    c.data.push(1);
    await c.flush();
    assert.match(c.lastError, /503/);
    assert.equal(stateHealth().ok, false);
    fail = false;
    await c.flush();
    assert.equal(c.lastError, null);
    assert.equal(stateHealth().ok, true);
    assert.ok(backend.blobs.has('x.json'));
  });

  test('configureState (files or memory) after blob mode leaves no blob state behind', async () => {
    configureStateBlob({ account: 'ststate', backend: fakeBackend() });
    await primeState();
    configureState('');
    const h = stateHealth();
    assert.equal(h.mode, 'memory');
    assert.equal(h.directory, null);
    assert.equal(h.error, null);
  });
});
