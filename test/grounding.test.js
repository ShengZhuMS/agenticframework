/**
 * Grounding — from a data product to its Data Map assets and its search index.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex, index, SEARCH, UC_RELATIONSHIPS, UC_ASSETS, resetRoundFour } from './fixtures.js';
import { parseCsvHeader, describeGrounding, searchToolsFor, groundingStatus, buildIndex, indexFor, forgetAssets } from '../src/bff/services/grounding.js';
import { indexDefinitionFor } from '../src/bff/adapters/search.js';
import { createAgent, validateBuild } from '../src/bff/services/agents.js';
import { USERS } from './fixtures.js';

let restore;
before(async () => {
  restore = await loadIndex();
});
after(() => restore && restore());
beforeEach(() => {
  resetRoundFour();
  forgetAssets();
});

describe('parseCsvHeader', () => {
  test('splits a plain header and a quoted one, ignoring a BOM', () => {
    assert.deepEqual(parseCsvHeader('a,b,c\n1,2,3'), ['a', 'b', 'c']);
    assert.deepEqual(parseCsvHeader('\uFEFF"sample id","result, qualified",x\r\n'), ['sample id', 'result, qualified', 'x']);
  });
});

describe('describeGrounding', () => {
  test('names the assets, their columns and the index; says plainly when there is no index', () => {
    const e = { name: 'Waste carrier registrations' };
    const withIndex = describeGrounding(e, [{ name: 'w.csv', fqn: 'https://x/w.csv', schema: [{ name: 'registration_number' }], classifications: ['PII'] }], 'cortex-w');
    assert.match(withIndex, /Asset: w\.csv/);
    assert.match(withIndex, /registration_number/);
    assert.match(withIndex, /Search index: cortex-w/);
    const without = describeGrounding(e, [], null);
    assert.match(without, /No search index is attached/);
  });
});

describe('index per product', () => {
  test('the index name comes from the product\u2019s data folder attribute when Purview carries one', () => {
    assert.equal(indexFor({ name: 'X', dataFolder: 'waste-carrier-registrations' }), 'cortex-waste-carrier-registrations');
    assert.equal(indexFor({ name: 'X', searchIndex: 'custom-index' }), 'custom-index');
    assert.equal(indexFor({ name: 'Water quality archive' }), 'cortex-water-quality-archive');
  });

  test('searchToolsFor gives an azure_ai_search tool for products with an index and lists the rest as described-only', async () => {
    const water = index.get('p-water-quality');
    const waste = index.get('p-waste-carriers');
    SEARCH.indexes.set(indexFor(water), indexDefinitionFor(indexFor(water), ['a']));
    const r = await searchToolsFor([water, waste]);
    assert.equal(r.tools.length, 1);
    assert.equal(r.tools[0].type, 'azure_ai_search');
    assert.equal(r.tools[0].azure_ai_search.indexes[0].index_name, indexFor(water));
    assert.match(r.tools[0].azure_ai_search.indexes[0].project_connection_id, /connections\/cortex-search$/);
    assert.equal(r.tools[0].azure_ai_search.indexes[0].query_type, 'simple');
    assert.deepEqual(r.describedOnly, [waste.name]);
  });

  test('groundingStatus reports assets, index and indexer without throwing', async () => {
    const water = index.get('p-water-quality');
    UC_ASSETS.set('uc-1', { id: 'uc-1', name: 'water.csv', source: { assetId: 'g1', fqn: 'https://x/water.csv', assetType: 'adls_gen2_path' }, schema: [{ name: 'sample_id' }] });
    UC_RELATIONSHIPS.set(water.id, [{ entityId: 'uc-1' }]);
    const g = await groundingStatus(water);
    assert.equal(g.configured, true);
    assert.equal(g.assets.length, 1);
    assert.equal(g.assets[0].schema[0].name, 'sample_id');
    assert.equal(g.exists, false);
    assert.equal(g.index, 'cortex-water-quality-archive');
  });

  test('buildIndex uses the Data Map schema for columns and creates index, source and indexer', async () => {
    const water = index.get('p-water-quality');
    UC_ASSETS.set('uc-2', { id: 'uc-2', name: 'water.csv', source: { assetId: 'g2', fqn: 'https://x/water.csv' }, schema: [{ name: 'sample_id' }, { name: 'result' }] });
    UC_RELATIONSHIPS.set(water.id, [{ entityId: 'uc-2' }]);
    const r = await buildIndex(water);
    assert.deepEqual(r.columns, ['sample_id', 'result']);
    assert.ok(SEARCH.indexes.has('cortex-water-quality-archive'));
    assert.ok(SEARCH.datasources.has('cortex-water-quality-archive-source'));
    assert.equal(SEARCH.datasources.get('cortex-water-quality-archive-source').container.query, 'water-quality-archive');
    assert.ok(SEARCH.indexers.has('cortex-water-quality-archive-indexer'));
    assert.equal(r.run.started, true);
  });

  test('an agent built on an indexed product gets the search tool and grounding notes in its instructions', async () => {
    const water = index.get('p-water-quality');
    SEARCH.indexes.set(indexFor(water), indexDefinitionFor(indexFor(water), ['a']));
    const v = await validateBuild(
      { name: 'Water agent', instructions: 'Answer about water.', model: 'gpt-5-mini', knowledge: ['p-water-quality'] },
      USERS.analyst
    );
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    const { entry, created, grounding } = await createAgent(v.definition, USERS.analyst);
    assert.equal(grounding.grounded.length, 1);
    assert.equal(entry._agent.grounding.grounded[0].index, 'cortex-water-quality-archive');
    assert.match(entry._agent.definition.instructions, /Answer about water/);
    assert.ok(created);
  });
});
