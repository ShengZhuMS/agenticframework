/**
 * Azure AI Search — index definitions and the indexer that turns a CSV into rows.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubAzure, SEARCH, resetRoundFour } from './fixtures.js';
import { createSearchAdapter, indexNameFor, fieldNameFor, indexDefinitionFor } from '../src/bff/adapters/search.js';

let restore;
before(() => {
  restore = stubAzure();
});
after(() => restore && restore());
beforeEach(() => resetRoundFour());

describe('names', () => {
  test('index names are lower-case, dashed and prefixed', () => {
    assert.equal(indexNameFor('Water Quality Archive'), 'cortex-water-quality-archive');
    assert.equal(indexNameFor('waste-carrier-registrations'), 'cortex-waste-carrier-registrations');
  });
  test('field names are valid whatever the CSV header says', () => {
    assert.equal(fieldNameFor('sample date'), 'sample_date');
    assert.equal(fieldNameFor('2024 total'), 'c_2024_total');
    assert.equal(fieldNameFor('AzureSearch_x'), 'c_AzureSearch_x');
    assert.equal(fieldNameFor('ok_name'), 'ok_name');
  });
});

describe('index definition', () => {
  test('carries id/title/url plus one searchable string field per column', () => {
    const def = indexDefinitionFor('cortex-x', ['registration_number', 'status', 'title']);
    const names = def.fields.map((f) => f.name);
    assert.deepEqual(names, ['id', 'title', 'url', 'registration_number', 'status']);
    assert.equal(def.fields.find((f) => f.name === 'id').key, true);
    assert.equal(def.fields.find((f) => f.name === 'status').searchable, true);
    assert.equal(def.semantic, undefined, 'no semantic configuration unless asked');
  });
  test('adds a semantic configuration when the query type needs one', () => {
    const def = indexDefinitionFor('cortex-x', ['a', 'b'], { semantic: true });
    assert.equal(def.semantic.configurations[0].name, 'default');
    assert.equal(def.semantic.configurations[0].prioritizedFields.titleField.fieldName, 'title');
  });
});

describe('adapter', () => {
  test('schema evolution preserves existing fields and refuses incompatible types', async () => {
    const s = createSearchAdapter();
    await s.ensureIndex(indexDefinitionFor('cortex-evolve', ['old']));
    await s.ensureIndex(indexDefinitionFor('cortex-evolve', ['new']));
    const def = SEARCH.indexes.get('cortex-evolve');
    assert.ok(def.fields.some((f) => f.name === 'old'));
    assert.ok(def.fields.some((f) => f.name === 'new'));
    await assert.rejects(s.ensureIndex({ ...def, fields: [{ name: 'old', type: 'Edm.Int32' }] }), /type/i);
  });

  test('creates index, data source (managed identity, adlsgen2) and a CSV indexer, then runs it', async () => {
    const s = createSearchAdapter();
    await s.ensureIndex(indexDefinitionFor('cortex-t', ['a']));
    await s.ensureDataSource({ name: 'cortex-t-source', storageAccountId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acct', container: 'products', folder: 't' });
    await s.ensureIndexer({ name: 'cortex-t-indexer', dataSourceName: 'cortex-t-source', targetIndexName: 'cortex-t' });
    const run = await s.runIndexer('cortex-t-indexer');
    assert.equal(run.started, true);
    const ds = SEARCH.datasources.get('cortex-t-source');
    assert.equal(ds.type, 'adlsgen2');
    assert.match(ds.credentials.connectionString, /^ResourceId=\/subscriptions\/s\/.*storageAccounts\/acct;$/);
    assert.equal(ds.container.query, 't');
    const ix = SEARCH.indexers.get('cortex-t-indexer');
    assert.equal(ix.parameters.configuration.parsingMode, 'delimitedText');
    assert.equal(ix.parameters.configuration.firstLineContainsHeaders, true);
    assert.equal(ix.fieldMappings.find((m) => m.targetFieldName === 'id').sourceFieldName, 'AzureSearch_DocumentKey');
    assert.equal(ix.fieldMappings.find((m) => m.targetFieldName === 'url').sourceFieldName, 'metadata_storage_path');
    assert.deepEqual(SEARCH.runs, ['cortex-t-indexer']);
  });

  test('stats and status come back shaped for the entry page; a missing index is null, not an error', async () => {
    const s = createSearchAdapter();
    assert.equal(await s.indexStats('cortex-nope'), null);
    await s.ensureIndex(indexDefinitionFor('cortex-y', ['a']));
    const st = await s.indexStats('cortex-y');
    assert.equal(st.documents, 42);
    await s.ensureIndexer({ name: 'cortex-y-indexer', dataSourceName: 'd', targetIndexName: 'cortex-y' });
    const status = await s.indexerStatus('cortex-y-indexer');
    assert.equal(status.lastRun.processed, 42);
    assert.equal(status.lastRun.status, 'success');
  });

  test('health counts only Cortex indexes', async () => {
    const s = createSearchAdapter();
    await s.ensureIndex({ name: 'other', fields: [] });
    await s.ensureIndex(indexDefinitionFor('cortex-z', ['a']));
    const h = await s.health();
    assert.equal(h.ok, true);
    assert.equal(h.indexes, 1);
  });
});
