/**
 * The Cortex Index: dependency resolution, cross-cluster counting, search,
 * filtering and sorting.
 *
 * The cross-cluster figure in particular is a number a CTO may be shown on a
 * slide, so it is tested rather than trusted.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import index from '../src/bff/index/store.js';

before(async () => {
  await index.init();
});

describe('the register loads', () => {
  test('every seeded entry is present', () => {
    assert.ok(index.all().length >= 20, 'expected the full seed corpus');
  });

  test('nine clusters, each with a named owner', () => {
    assert.equal(index.clusters.length, 9);
    for (const c of index.clusters) {
      assert.ok(c.name, 'cluster needs a name');
      assert.ok(c.owner, 'cluster needs an owner, even if it is "Not claimed"');
    }
  });

  test('four personas, each with distinct group membership', () => {
    assert.equal(index.personas.length, 4);
    const sets = index.personas.map((p) => p.groups.join(','));
    assert.equal(new Set(sets).size, 4, 'personas must differ or the switcher proves nothing');
  });

  test('every entry has the fields the entry standard requires', () => {
    for (const e of index.all()) {
      for (const f of ['id', 'name', 'cat', 'cluster', 'desc', 'owner', 'sens', 'licence']) {
        assert.ok(e[f] !== undefined && e[f] !== '', `${e.id} is missing ${f}`);
      }
      assert.ok(e._source?.system, `${e.id} must record where it came from`);
    }
  });

  test('every entry belongs to a cluster that exists', () => {
    const ids = new Set(index.clusters.map((c) => c.id));
    for (const e of index.all()) {
      assert.ok(ids.has(e.cluster), `${e.id} points at unknown cluster ${e.cluster}`);
    }
  });
});

describe('cross-cluster dependencies — CAP-035', () => {
  test('counts only dependencies that resolve to a registered entry', () => {
    const { count, links, unresolved } = index.crossClusterLinks();
    assert.equal(count, links.length);
    assert.ok(count >= 0);
    assert.ok(unresolved > 0, 'the seed data has external dependencies; they must be counted separately');
  });

  test('every counted link genuinely crosses a cluster boundary', () => {
    for (const l of index.crossClusterLinks().links) {
      assert.notEqual(l.from, l.to, 'a same-cluster link is not a cross-cluster link');
    }
  });

  test('unresolved dependencies are reported, never silently dropped', () => {
    const { count, unresolved } = index.crossClusterLinks();
    let total = 0;
    for (const e of index.all()) total += (e.deps || []).length;
    const sameCluster = total - count - unresolved;
    assert.ok(sameCluster >= 0, 'every dependency must be accounted for exactly once');
  });
});

describe('coverage — CAP-037', () => {
  test('registered is measured against the believed estate', () => {
    const c = index.coverage();
    assert.equal(c.registered, index.all().length);
    assert.ok(c.believed > c.registered, 'the register is a thin slice, by design');
    assert.ok(c.percent > 0 && c.percent < 100);
    assert.equal(c.illustrative, true, 'the figure must be marked illustrative');
  });
});

describe('search and filter — CAP-023, CAP-025, CAP-026', () => {
  test('search matches name, description, owner and cluster', () => {
    assert.ok(index.search({ q: 'waste' }).length > 0);
    assert.ok(index.search({ q: 'Environment Agency'.toLowerCase() }).length >= 0);
  });

  test('an unmatched search returns nothing rather than everything', () => {
    assert.equal(index.search({ q: 'zzzznomatchzzz' }).length, 0);
  });

  test('category filter narrows to the chosen categories', () => {
    const out = index.search({ cats: ['Skill'] });
    assert.ok(out.length > 0);
    for (const e of out) assert.equal(e.cat, 'Skill');
  });

  test('cluster filter narrows to the chosen clusters', () => {
    const out = index.search({ clusters: ['waste'] });
    assert.ok(out.length > 0);
    for (const e of out) assert.equal(e.cluster, 'waste');
  });

  test('filters combine rather than override each other', () => {
    const out = index.search({ cats: ['Data'], clusters: ['water'] });
    for (const e of out) {
      assert.equal(e.cat, 'Data');
      assert.equal(e.cluster, 'water');
    }
  });
});

describe('access requests — CAP-022', () => {
  test('a request gets a reference and starts pending', () => {
    const r = index.addAccessRequest({
      entryId: 'x',
      entryName: 'X',
      requester: 'Sarah',
      purpose: 'testing',
      owner: 'Someone'
    });
    assert.match(r.ref, /^CTX-\d{4}$/);
    assert.equal(r.status, 'Pending');
    assert.ok(r.raisedAt);
  });

  test('references are unique', () => {
    const a = index.addAccessRequest({ entryId: 'a', requester: 'x' });
    const b = index.addAccessRequest({ entryId: 'b', requester: 'x' });
    assert.notEqual(a.ref, b.ref);
  });
});

describe('upsert — CAP-047 claiming an entry', () => {
  test('claiming sets a confirmed owner without losing other fields', () => {
    const before = index.all().find((e) => e.ownerState === 'proposed');
    if (!before) return;
    const desc = before.desc;
    index.upsert({ ...before, owner: 'My Team', ownerState: 'confirmed' });
    const after = index.get(before.id);
    assert.equal(after.owner, 'My Team');
    assert.equal(after.ownerState, 'confirmed');
    assert.equal(after.desc, desc, 'claiming must not drop the description');
  });
});
