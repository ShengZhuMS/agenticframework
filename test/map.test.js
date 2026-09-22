import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutDomains, mapPage } from '../src/web/views/map.js';

test('live domains without coordinates have a stable bounded layout at every size', () => {
  for (const size of [0, 1, 9, 21, 100]) {
    const domains = Array.from({ length: size }, (_, i) => ({ id: `guid-${i}`, name: `Domain ${i}` }));
    const result = layoutDomains(domains, { 'guid-0': 100 });
    assert.deepEqual(result, layoutDomains([...domains].reverse(), { 'guid-0': 100 }));
    for (const c of result.clusters) {
      assert.ok(Number.isFinite(c.x + c.y + c.r));
      assert.ok(c.x - c.r >= 0 && c.x + c.r <= result.width);
      assert.ok(c.y - c.r >= 0 && c.y + c.r <= result.height);
    }
    assert.ok(domains.every((c) => c.x === undefined));
  }
});

test('map renders real coordinates, links, text alternatives and service failures', () => {
  const args = {
    clusters: [{ id: 'a', name: '<Operations>', owner: 'Team' }, { id: 'b', name: 'Research', owner: 'Team' }],
    counts: { a: 3, b: 1 }, links: [{ from: 'a', to: 'b' }],
    cross: { count: 1, unresolved: 2 }, coverage: { registered: 4, byCat: { Agent: 4 } },
    unclustered: [], errors: { 'purview-products': 'failed' }
  };
  const html = mapPage({ user: { name: 'Test', groups: [] } }, args);
  assert.doesNotMatch(html, /NaN|cx="undefined"|r="undefined"/);
  assert.match(html, /<line x1="[\d.]+"/);
  assert.match(html, /&lt;Operations&gt;/);
  assert.match(html, /text alternative/);
  assert.match(html, /may be incomplete/);
  assert.match(mapPage({ user: { name: 'Test', groups: [] } }, { ...args, clusters: [] }), /No governance domains/);
});
