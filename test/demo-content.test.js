import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gatewayKeyMatches, invokeDemoSkill } from '../src/bff/services/demo-skills.js';
import { LiveStorage } from '../src/bff/adapters/storage.js';
import { themeFor } from '../src/web/theme.js';

const pack = (name) => JSON.parse(readFileSync(new URL(`../bootstrap/${name}.json`, import.meta.url), 'utf8'));

test('neutral pack has unique domains and every product/skill has a valid domain', () => {
  const domains = pack('domains'), products = pack('data-products'), skills = pack('skills');
  for (const items of [domains, products, skills]) assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  for (const item of [...products, ...skills]) assert.ok(domains.some((d) => d.id === item.domain), item.id);
  for (const skill of skills) assert.ok(products.some((p) => p.id === skill.productId));
  assert.ok(!/defra|novo|badger|waste carrier/i.test(JSON.stringify([domains, products, skills])));
});

test('sample skill returns actual bounded CSV rows and enforces key comparison', async () => {
  assert.equal(gatewayKeyMatches('correct', 'correct'), true);
  assert.equal(gatewayKeyMatches('wrong', 'correct'), false);
  assert.equal(gatewayKeyMatches(undefined, undefined), false);
  const storage = {
    head: async (container, name, bytes) => {
      assert.equal(container, 'products'); assert.equal(bytes, 65536);
      assert.match(name, /cx-demo-service-performance/);
      return 'record_id,business_unit\n001,North\n002,South\n003,par';
    },
    blobUrl: () => 'https://stub.blob.core.windows.net/products/sample.csv'
  };
  const r = await invokeDemoSkill('cx-demo-service-summary', 'north', storage, 'products');
  assert.deepEqual(r.rows, [{ record_id: '001', business_unit: 'North' }]);
  assert.equal(r.synthetic, true);
  assert.equal(await invokeDemoSkill('unknown', '', storage, 'products'), null);
});

test('storage inventories paginate and reject repeated cursors', async () => {
  const storage = new LiveStorage({ storageAccount: 'stub' });
  const urls = [];
  storage._fetch = async (url) => {
    urls.push(url);
    return new Response(url.includes('marker=page2') ? '<EnumerationResults><Blobs><Blob><Name>b</Name></Blob></Blobs><NextMarker /></EnumerationResults>' : '<EnumerationResults><Blobs><Blob><Name>a&amp;b</Name></Blob></Blobs><NextMarker>page2</NextMarker></EnumerationResults>');
  };
  assert.deepEqual((await storage.list('state')).map((b) => b.name), ['a&b', 'b']);
  assert.equal(urls.length, 2);
  storage._fetch = async () => new Response('<EnumerationResults><NextMarker>repeat</NextMarker></EnumerationResults>');
  await assert.rejects(storage.list('state'), /repeated/);
});

test('theme lookup is allowlisted and preserves the existing default', () => {
  assert.equal(themeFor('defra').id, 'defra');
  assert.equal(themeFor('microsoft').id, 'microsoft');
  assert.equal(themeFor('novo').id, 'novo');
  assert.throws(() => themeFor('<script>'), /Unsupported/);
});
