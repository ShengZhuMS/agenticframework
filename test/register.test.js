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

describe('governance domains are named two ways, and the register uses one', () => {
  test('a slug or a display name resolves to the Purview domain id', () => {
    // bootstrap/domains.json, the MCP tool and a new agent's default all say
    // "water" or "corp"; Purview says a GUID. Both must land on the same domain.
    assert.equal(index.clusterById('water')?.id, 'd-water');
    assert.equal(index.clusterById('Waste and resources')?.id, 'd-waste');
    assert.equal(index.clusterById('corp')?.id, 'd-corp');
    assert.equal(index.clusterById('d-corp')?.id, 'd-corp');
  });

  test('an entry registered under a slug is stored under the domain id', () => {
    index.upsert({
      id: 'slug-agent',
      name: 'Slug agent',
      cat: 'Agent',
      cluster: 'corp',
      desc: 'Built with the default cluster',
      owner: 'Test',
      _source: { system: 'foundry', id: 'slug-agent' },
      _endpoints: {}
    });
    assert.equal(index.get('slug-agent').cluster, 'd-corp');
    assert.ok(!index.coverage().byDomain.corp, 'no phantom "corp" domain appears on the map');
    index.entries.delete('slug-agent');
  });

  test('a domain nobody knows is left alone rather than guessed', () => {
    index.upsert({
      id: 'stray',
      name: 'Stray',
      cat: 'Skill',
      cluster: 'unassigned',
      desc: 'x',
      owner: 'Test',
      _source: { system: 'apim', id: 'stray' },
      _endpoints: {}
    });
    assert.equal(index.get('stray').cluster, 'unassigned');
    index.entries.delete('stray');
  });

  test("Cortex's own Ask agent is not a marketplace entry", async () => {
    const restoreAgents = await loadIndex({ agents: [{ name: 'cortex-ask', version: 1 }, { name: 'waste-carrier-checker', version: 1 }] });
    try {
      assert.equal(index.get('cortex-ask'), null);
      assert.ok(index.get('waste-carrier-checker'));
    } finally {
      restoreAgents();
      restore = await loadIndex();
    }
  });
});
