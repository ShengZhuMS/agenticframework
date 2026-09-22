/**
 * Storage access — the two 403s, and what bootstrap does about the network one.
 *
 * The first live run of round 4 failed with `403 AuthorizationFailure` and
 * reported it as a missing role. It is the storage FIREWALL code: a tenant
 * policy had closed the account's public endpoint after provisioning. These
 * tests pin the distinction, the flag callers use to stop early, the gating of
 * the search step on the data step, and the indexer verification that turns
 * "rows appear within a minute or two" into a checked result.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { explainStorageError, LiveStorage } from '../src/bff/adapters/storage.js';
import { bootstrapData, bootstrapSearch, verifyIndexers } from '../scripts/bootstrap-data.js';
import { stubConfig, stubAzure } from './fixtures.js';
import { clearTokenCache } from '../src/bff/adapters/token.js';

const FIREWALL = '<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthorizationFailure</Code><Message>This request is not authorized to perform this operation.\nRequestId:8f85b3e0</Message></Error>';
const ROLE = '<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthorizationPermissionMismatch</Code><Message>This request is not authorized to perform this operation using this permission.</Message></Error>';

describe('explainStorageError', () => {
  test('AuthorizationFailure is named as the firewall and points at the repair script, not at a role', () => {
    const e = explainStorageError(403, FIREWALL, 'stcortexdata', 'PUT /products');
    assert.equal(e.code, 'AuthorizationFailure');
    assert.match(e.message, /FIREWALL code, not a missing role/);
    assert.match(e.message, /Set-CortexStorageAccess\.ps1/);
    assert.match(e.message, /tenant Azure Policy/);
    assert.doesNotMatch(e.message, /grant the signed-in account/i);
  });

  test('AuthorizationPermissionMismatch is named as the missing role, with the propagation delay', () => {
    const e = explainStorageError(403, ROLE, 'stcortexdata', 'PUT /products');
    assert.equal(e.code, 'AuthorizationPermissionMismatch');
    assert.match(e.message, /Storage Blob Data Contributor/);
    assert.match(e.message, /five minutes/);
    assert.doesNotMatch(e.message, /Set-CortexStorageAccess/);
  });

  test('an unrecognised 403 says how to tell the two apart; a non-403 carries no hint', () => {
    assert.match(explainStorageError(403, '<Error><Code>Other</Code></Error>', 'x').message, /AuthorizationFailure.*AuthorizationPermissionMismatch/);
    const e = explainStorageError(500, 'boom', 'x');
    assert.equal(e.code, '');
    assert.match(e.message, /failed 500: boom$/);
  });

  test('reads the code from a JSON body too', () => {
    assert.equal(explainStorageError(403, '{"error":{"code":"AuthorizationFailure"}}', 'x').code, 'AuthorizationFailure');
  });
});

describe('LiveStorage against a firewalled account', () => {
  const realFetch = globalThis.fetch;
  before(() => {
    process.env.IDENTITY_ENDPOINT = 'http://localhost/IDENTITY';
    process.env.IDENTITY_HEADER = 'stub';
    clearTokenCache();
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('IDENTITY')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_on: '99999999999' }), text: async () => '' };
      return { ok: false, status: 403, text: async () => FIREWALL, json: async () => ({}) };
    };
  });
  after(() => {
    globalThis.fetch = realFetch;
    delete process.env.IDENTITY_ENDPOINT;
    delete process.env.IDENTITY_HEADER;
    clearTokenCache();
  });

  test('download returns null for a blob that does not exist, and the text otherwise', async () => {
    const realFetch2 = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('IDENTITY')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_on: '99999999999' }), text: async () => '' };
      if (url.endsWith('/state/missing.json')) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      return { ok: true, status: 200, text: async () => '{"seq":1}', json: async () => ({}) };
    };
    try {
      const s = new LiveStorage({ storageAccount: 'ststate', container: 'state', scope: 'https://storage.azure.com/.default' });
      assert.equal(await s.download('state', 'missing.json'), null);
      assert.equal(await s.download('state', 'requests.json'), '{"seq":1}');
    } finally {
      globalThis.fetch = realFetch2;
    }
  });

  test('the error carries the code and the blocked flag so callers stop after one failure', async () => {
    const s = new LiveStorage({ storageAccount: 'stfirewalled', container: 'products', scope: 'https://storage.azure.com/.default' });
    await assert.rejects(s.ensureContainer('products'), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.storageCode, 'AuthorizationFailure');
      assert.equal(err.blocked, true);
      assert.match(err.message, /PUT \/products failed 403 \(AuthorizationFailure\)/);
      return true;
    });
  });
});

function fakeLog() {
  const lines = { ok: [], warn: [], fail: [], skip: [], step: [] };
  return {
    lines,
    step: (m) => lines.step.push(m),
    ok: (m) => lines.ok.push(m),
    warn: (m) => lines.warn.push(m),
    fail: (m) => lines.fail.push(m),
    skip: (m) => lines.skip.push(m)
  };
}

function blockedError() {
  const err = new Error('Storage PUT /products failed 403 (AuthorizationFailure): refused');
  err.status = 403;
  err.storageCode = 'AuthorizationFailure';
  err.blocked = true;
  return err;
}

describe('bootstrapData when the account refuses the machine', () => {
  before(() => stubConfig());

  test('stops at the container and reports blocked, so nothing downstream runs', async () => {
    const log = fakeLog();
    const counters = { created: 0, updated: 0, failed: 0 };
    let scans = 0;
    const r = await bootstrapData({
      products: [{ id: 'water-quality-archive', name: 'Water quality archive' }],
      log,
      counters,
      signedInObjectId: async () => 'me',
      guidFor: (s) => s,
      listAllDataProducts: async () => [],
      storage: { ensureContainer: async () => { throw blockedError(); }, upload: async () => ({}) },
      datamap: { collection: 'root', ensureCollectionRoles: async () => ({ changed: false }), ensureAdlsSource: async () => { scans++; }, ensureAdlsScan: async () => ({}), runScan: async () => ({}) },
      purview: {}
    });
    assert.equal(r.blocked, true);
    assert.equal(r.uploaded, 0);
    assert.equal(scans, 0, 'the Data Map must not be touched');
    assert.equal(counters.failed, 1);
    assert.match(log.lines.fail[0], /AuthorizationFailure/);
    assert.match(log.lines.warn.join(' '), /skipped this run/);
  });

  test('a network refusal on the first upload stops the loop after one failure, not fourteen', async () => {
    const log = fakeLog();
    const counters = { created: 0, updated: 0, failed: 0 };
    let uploads = 0;
    const products = ['cx-demo-service-performance', 'cx-demo-feedback', 'cx-demo-delivery'].map((id) => ({ id, name: id }));
    const r = await bootstrapData({
      products,
      log,
      counters,
      signedInObjectId: async () => 'me',
      guidFor: (s) => s,
      listAllDataProducts: async () => [],
      storage: { ensureContainer: async () => ({ created: false }), upload: async () => { uploads++; throw blockedError(); } },
      datamap: { collection: 'root', ensureCollectionRoles: async () => ({ changed: false }) },
      purview: {}
    });
    assert.equal(uploads, 1);
    assert.equal(counters.failed, 1);
    assert.equal(r.blocked, true);
  });

  test('a role refusal is not "blocked" — every product is still attempted and reported', async () => {
    const log = fakeLog();
    const counters = { created: 0, updated: 0, failed: 0 };
    let uploads = 0;
    const products = ['cx-demo-service-performance', 'cx-demo-feedback'].map((id) => ({ id, name: id }));
    const roleErr = () => Object.assign(new Error('Storage PUT failed 403 (AuthorizationPermissionMismatch)'), { status: 403, blocked: false });
    const r = await bootstrapData({
      products,
      log,
      counters,
      signedInObjectId: async () => 'me',
      guidFor: (s) => s,
      listAllDataProducts: async () => [],
      storage: { ensureContainer: async () => ({ created: false }), upload: async () => { uploads++; throw roleErr(); } },
      datamap: { collection: 'root', ensureCollectionRoles: async () => ({ changed: false }) },
      purview: {}
    });
    assert.equal(uploads, 2);
    assert.equal(counters.failed, 2);
    assert.equal(r.blocked, true, 'nothing was uploaded, so the scan is still pointless');
    assert.equal(r.uploaded, 0);
  });
});

describe('verifyIndexers', () => {
  test('waits for eventually consistent document counts rather than falsely failing an indexer', async () => {
    let reads = 0;
    const r = await verifyIndexers({
      names: ['cortex-new'], log: fakeLog(), sleep: async () => {},
      search: {
        indexerStatus: async () => ({ lastRun: { status: 'success', failed: 0, processed: 100 } }),
        indexStats: async () => ({ documents: ++reads === 1 ? 0 : 100 })
      }, verifySeconds: 1
    });
    assert.equal(r.indexed, 1);
    assert.equal(r.failed, 0);
    assert.equal(reads, 2);
  });

  test('zero documents at the deadline never count as a populated index', async () => {
    const r = await verifyIndexers({
      names: ['cortex-empty'], log: fakeLog(), sleep: async () => {},
      search: {
        indexerStatus: async () => ({ lastRun: { status: 'success', failed: 0, processed: 0 } }),
        indexStats: async () => ({ documents: 0 })
      }, verifySeconds: 0.01
    });
    assert.equal(r.indexed, 0);
    assert.equal(r.failed, 1);
  });

  test('reports rows for a successful run and the first error for a failed one, and flags a storage refusal', async () => {
    const log = fakeLog();
    const statuses = {
      'cortex-a-indexer': { lastRun: { status: 'success', processed: 120, failed: 0, errors: [] } },
      'cortex-b-indexer': { lastRun: { status: 'transientFailure', processed: 0, failed: 0, errors: ['Error with data source: This request is not authorized to perform this operation.'] } }
    };
    const r = await verifyIndexers({
      names: ['cortex-a', 'cortex-b'],
      search: { indexerStatus: async (n) => statuses[n] },
      log,
      sleep: async () => {},
      verifySeconds: 5,
      intervalMs: 0
    });
    assert.equal(r.indexed, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.pending, 0);
    assert.equal(r.networkBlocked, true);
    assert.match(log.lines.ok[0], /120 rows indexed/);
    assert.match(log.lines.fail[0], /not authorized/);
  });

  test('an indexer that never finishes is reported as pending, not as success', async () => {
    const log = fakeLog();
    let ticks = 0;
    const r = await verifyIndexers({
      names: ['cortex-slow'],
      search: { indexerStatus: async () => ({ lastRun: { status: 'inProgress', processed: 0 } }) },
      log,
      sleep: async () => { ticks++; },
      verifySeconds: 0.05,
      intervalMs: 10
    });
    assert.equal(r.indexed, 0);
    assert.equal(r.pending, 1);
    assert.ok(ticks >= 1);
  });
});

describe('bootstrapSearch verification', () => {
  let restore;
  before(() => { restore = stubAzure(); });
  after(() => restore());

  test('waits for the indexers it started and counts the rows, instead of promising them', async () => {
    const log = fakeLog();
    const counters = { created: 0, updated: 0, failed: 0 };
    const search = {
      listIndexes: async () => [],
      ensureIndex: async () => ({}),
      ensureDataSource: async () => ({}),
      ensureIndexer: async () => ({}),
      runIndexer: async () => ({ started: true }),
      indexerStatus: async () => ({ lastRun: { status: 'success', processed: 750, failed: 0, errors: [] } })
    };
    const r = await bootstrapSearch({
      products: [{ id: 'cx-demo-service-performance', name: 'Demo - Service performance' }],
      log,
      counters,
      search,
      sleep: async () => {},
      verifySeconds: 5
    });
    assert.equal(r.built, 1);
    assert.equal(r.indexed, 1);
    assert.equal(r.verified, true);
    assert.match(log.lines.ok.join('\n'), /750 rows indexed/);
    assert.match(log.lines.ok.join('\n'), /1 of 1 indexes hold rows/);
  });

  test('verify:false (--no-wait) starts the indexers and says it is not waiting', async () => {
    const log = fakeLog();
    const counters = { created: 0, updated: 0, failed: 0 };
    let statusCalls = 0;
    const search = {
      listIndexes: async () => [],
      ensureIndex: async () => ({}),
      ensureDataSource: async () => ({}),
      ensureIndexer: async () => ({}),
      runIndexer: async () => ({ started: true }),
      indexerStatus: async () => { statusCalls++; return null; }
    };
    const r = await bootstrapSearch({ products: [{ id: 'finance-ledger', name: 'Finance' }], log, counters, search, verify: false });
    assert.equal(r.verified, false);
    assert.equal(statusCalls, 0);
    assert.match(log.lines.ok.join('\n'), /not waiting/);
  });
});
