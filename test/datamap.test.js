/**
 * Purview Data Map — collection roles, sources, scans and asset lookup.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubAzure, DATAMAP_ASSETS, resetRoundFour } from './fixtures.js';
import { createDataMapAdapter, adlsQualifiedName, COLLECTION_ROLES } from '../src/bff/adapters/datamap.js';

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
    DATAMAP_ASSETS.set(qn, { guid: 'g-1', typeName: 'adls_gen2_path', attributes: { name: 'x.csv', qualifiedName: qn }, classifications: [{ typeName: 'MICROSOFT.PERSONAL.NAME' }] });
    const a = await dm.getAssetByQualifiedName(qn);
    assert.equal(a.id, 'g-1');
    assert.deepEqual(a.classifications, ['MICROSOFT.PERSONAL.NAME']);
  });
});
