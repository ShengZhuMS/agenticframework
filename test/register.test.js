/**
 * The Cortex Index, built from live Azure responses.
 *
 * Everything here goes through the real adapters against stubbed HTTP, so a
 * change to a response shape breaks a test rather than a demo.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex, index, USERS } from './fixtures.js';

let restore;
before(async () => {
  restore = await loadIndex();
});
after(() => restore && restore());

describe('the register is built from live sources', () => {
  test('data products arrive from Purview', () => {
    const p = index.get('p-water-quality');
    assert.ok(p, 'expected the Purview data product');
    assert.equal(p.cat, 'Data');
    assert.equal(p._source.system, 'purview');
  });

  test('governance domains arrive from Purview, not a local file', () => {
    assert.equal(index.domains.length, 3);
    assert.ok(index.clusterById('d-water'));
  });

  test('APIs arrive from API Management', () => {
    const s = index.get('permit-history-lookup');
    assert.ok(s);
    assert.equal(s._source.system, 'apim');
  });

  test('an MCP endpoint attaches to the entry it fronts', () => {
    assert.match(index.get('permit-history-lookup')._endpoints.mcp, /\/mcp$/);
  });

  test('managed attributes survive the round trip through Purview', () => {
    const p = index.get('p-sickness');
    assert.match(p.minAgg, /Directorate level/);
    assert.equal(p.askable.length, 2, 'askable questions must survive as a list');
    assert.match(p.licence, /Internal only/);
  });

  test('a dependency recorded as an attribute is read back', () => {
    assert.ok(index.get('p-waste-carriers').deps.includes('p-water-quality'));
  });
});

describe('usage comes from API Management analytics', () => {
  test('a called API carries real figures and names its source', () => {
    const s = index.get('permit-history-lookup');
    assert.equal(s.calls, 41200);
    assert.equal(s.usageSource, 'API Management analytics');
    assert.match(s.err, /%$/);
  });

  test('an entry with no gateway traffic reports no usage rather than zero-looking-real', () => {
    assert.equal(index.get('p-sickness').usageSource, undefined);
  });

  test('no entry carries a cost or carbon figure', () => {
    for (const e of index.all()) {
      assert.equal(e.cpu, undefined, `${e.id} must not carry an unsourced cost`);
      assert.equal(e.carbon, undefined, `${e.id} must not carry an unsourced carbon figure`);
    }
  });
});

describe('coverage reports what is registered, not what is guessed', () => {
  test('counts are facts, and there is no believed-estate percentage', () => {
    const c = index.coverage();
    assert.equal(c.registered, index.all().length);
    assert.equal(c.percent, undefined, 'a percentage of an estimate had no source and is gone');
    assert.equal(c.believed, undefined);
    assert.ok(c.byCat.Data >= 1);
  });
});

describe('a failing source degrades that slice only', () => {
  test('the register survives Purview being down', async () => {
    const r = await loadIndex({ failing: ['datagovernance'] });
    assert.ok(index.stats().sourceErrors['purview-products'], 'the failure must be recorded');
    assert.ok(index.get('permit-history-lookup'), 'APIM content must still load');
    r();
    restore = await loadIndex();
  });
});

describe('cross-cluster dependencies', () => {
  test('only counts links that resolve to a registered entry', () => {
    const { count, links, unresolved } = index.crossClusterLinks();
    assert.equal(count, links.length);
    for (const l of links) assert.notEqual(l.from, l.to);
    assert.equal(typeof unresolved, 'number');
  });
});

describe('access requests capture the requester at the time of asking', () => {
  test('a request records the groups held when it was raised', () => {
    const r = index.addAccessRequest({
      entryId: 'p-waste-carriers',
      requester: USERS.consumer.name,
      requesterGroups: USERS.consumer.groups,
      purpose: 'testing'
    });
    assert.match(r.ref, /^CTX-\d{4}$/);
    assert.deepEqual(r.requesterGroups, USERS.consumer.groups);
  });
});
