/**
 * Purview Data Map — collection roles, sources, scans and asset lookup.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubAzure, DATAMAP_ASSETS, resetRoundFour } from './fixtures.js';
import { createDataMapAdapter, adlsQualifiedName, COLLECTION_ROLES } from '../src/bff/adapters/datamap.js';
import { createPurviewAdapter } from '../src/bff/adapters/purview.js';

let restore;
before(() => {
  restore = stubAzure();
});
after(() => restore && restore());
beforeEach(() => resetRoundFour());

describe('qualified names', () => {
  test('follow the dfs form the Data Map records for ADLS Gen2 files', () => {
    assert.equal(
      adlsQualifiedName('ststubdata', 'products', 'waste-carrier-registrations/waste-carrier-registrations.csv'),
      'https://ststubdata.dfs.core.windows.net/products/waste-carrier-registrations/waste-carrier-registrations.csv'
    );
  });
});

describe('collection roles', () => {
  test('adds principals to the matching rules and PUTs the whole policy back', async () => {
    const dm = createDataMapAdapter();
    const r = await dm.ensureCollectionRoles({
      principalIds: ['me-oid', 'existing-oid'],
      roles: [COLLECTION_ROLES.dataSourceAdmin, COLLECTION_ROLES.dataCurator]
    });
    assert.equal(r.changed, true);
    assert.deepEqual(r.roles[COLLECTION_ROLES.dataSourceAdmin], ['me-oid'], 'existing-oid was already there');
    assert.deepEqual(r.roles[COLLECTION_ROLES.dataCurator], ['me-oid', 'existing-oid']);
    const put = DATAMAP_ASSETS.get('__policy_put__');
    assert.ok(put, 'the policy was written');
    const curator = put.properties.attributeRules.find((x) => x.id.startsWith(COLLECTION_ROLES.dataCurator));
    assert.deepEqual(curator.dnfCondition[0][0].attributeValueIncludedIn, ['me-oid', 'existing-oid']);
  });

  test('a rule without a principal clause gets one', async () => {
    const dm = createDataMapAdapter();
    const r = await dm.ensureCollectionRoles({ principalIds: ['me-oid'], roles: [COLLECTION_ROLES.dataReader] });
    assert.deepEqual(r.roles[COLLECTION_ROLES.dataReader], ['me-oid']);
  });

  test('dry run changes nothing', async () => {
    const dm = createDataMapAdapter();
    await dm.ensureCollectionRoles({ principalIds: ['new-oid'], roles: [COLLECTION_ROLES.dataCurator], dryRun: true });
    assert.equal(DATAMAP_ASSETS.has('__policy_put__'), false);
  });
});

describe('sources, scans and assets', () => {
  test('does not mistake another successful scan for the requested run', async () => {
    const dm = createDataMapAdapter();
    dm.scanRuns = async () => [{ id: 'other', status: 'Succeeded' }];
    const result = await dm.waitForScan('source', 'scan', 'requested', { timeoutMs: 5, pollMs: 1 });
    assert.equal(result.done, false);
  });

  test('registers required Unified Catalog file metadata and does not create after a failed lookup', async () => {
    const pv = createPurviewAdapter();
    const calls = [];
    pv._fetch = async (path, options) => {
      calls.push({ path, ...options });
      return path.endsWith('/query') ? { value: [] } : { id: 'uc-asset', ...options.body };
    };
    await pv.registerDataAsset({
      dataMapAssetId: 'scanned', name: 'sample.csv', assetType: 'azure_datalake_gen2_path',
      qualifiedName: 'https://ststubdata.dfs.core.windows.net/products/demo/sample.csv',
      columns: [{ name: 'measure', type: 'string' }]
    });
    assert.equal(calls[1].body.name, 'sample.csv');
    assert.equal(calls[1].body.type, 'ADLSGen2Path');
    assert.deepEqual(calls[1].body.typeProperties, {
      serverEndpoint: 'https://ststubdata.dfs.core.windows.net', container: 'products', folderPath: 'demo', fileName: 'sample.csv'
    });
    assert.equal(calls[1].body.source.assetId, 'scanned');
    pv._fetch = async () => { throw new Error('Lookup denied'); };
    await assert.rejects(pv.registerDataAsset({ dataMapAssetId: 'scanned', name: 'sample.csv' }), /Lookup denied/);
  });

  test('repairs missing storage ARM identity and uses the documented scan action', async () => {
    const dm = createDataMapAdapter();
    const calls = [];
    dm._fetch = async (path, options = {}) => {
      calls.push({ path, ...options });
      if (options.method === 'PUT' || options.method === 'POST') return {};
      return { properties: { endpoint: 'https://ststubdata.dfs.core.windows.net/' } };
    };
    await dm.ensureAdlsSource({ name: 'sample', storageAccount: 'ststubdata', resourceGroup: 'rg', subscriptionId: 'sub' });
    assert.equal(calls[1].body.properties.resourceId, '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/ststubdata');
    await dm.runScan('sample', 'scan');
    assert.equal(calls[2].path, '/scan/datasources/sample/scans/scan:run');
    assert.equal(calls[2].method, 'POST');
    assert.match(calls[2].query.runId, /^[0-9a-f-]{36}$/);
  });

  test('registers an ADLS Gen2 source and an MSI scan in the collection, and starts a run', async () => {
    const dm = createDataMapAdapter();
    const src = await dm.ensureAdlsSource({ name: 'cortex-sample-data', storageAccount: 'ststubdata', resourceGroup: 'rg', subscriptionId: 's', location: 'northeurope' });
    assert.equal(src.created, true);
    const scan = await dm.ensureAdlsScan({ dataSourceName: 'cortex-sample-data', scanName: 'cortex-sample-scan' });
    assert.equal(scan.created, true);
    const run = await dm.runScan('cortex-sample-data', 'cortex-sample-scan');
    assert.match(run.runId, /^[0-9a-f-]{36}$/);
    const w = await dm.waitForScan('cortex-sample-data', 'cortex-sample-scan', 'run-1', { pollMs: 1 });
    assert.equal(w.done, true);
    assert.equal(w.status, 'Succeeded');
    assert.equal(w.run.discovered, 28);
  });

  test('finds a scanned file by qualified name, or reports null before the scan lands', async () => {
    const dm = createDataMapAdapter();
    const qn = adlsQualifiedName('ststubdata', 'products', 'x/x.csv');
    assert.equal(await dm.getAssetByQualifiedName(qn), null);
    DATAMAP_ASSETS.set(qn, { guid: 'g-1', typeName: 'azure_datalake_gen2_path', attributes: { name: 'x.csv', qualifiedName: qn }, classifications: [{ typeName: 'MICROSOFT.PERSONAL.NAME' }] });
    const a = await dm.getAssetByQualifiedName(qn);
    assert.equal(a.id, 'g-1');
    assert.equal(a.type, 'azure_datalake_gen2_path');
    assert.deepEqual(a.classifications, ['MICROSOFT.PERSONAL.NAME']);
  });
});
