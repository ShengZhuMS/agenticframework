/**
 * Bootstrap — regression tests for the idempotency rules.
 *
 * WHY THIS FILE EXISTS. bootstrap.js writes into a real Purview catalogue, and
 * every bug below duplicates content rather than failing — the worst kind,
 * because nothing looks wrong until someone opens the portal and finds two of
 * everything. None of it was covered before, because importing the script ran
 * it.
 *
 * Stubbed at the HTTP boundary, the same convention as test/fixtures.js. The
 * managed identity endpoint is stubbed too, so no Azure CLI is involved.
 */

import { test, describe, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.IDENTITY_ENDPOINT = 'http://127.0.0.1:1/msi/token';
process.env.IDENTITY_HEADER = 'stub';

const {
  listAllDomains,
  listAllDataProducts,
  bootstrapDomains,
  bootstrapDataProducts,
  purviewFetch,
  apimFetch,
  waitForOperation,
  attributesFor,
  mapFrequency,
  guidFor,
  __counters
} = await import('../scripts/bootstrap.js');

const { toAttributeMap } = await import('../src/bff/adapters/purview.js');

const realFetch = globalThis.fetch;

/** Calls recorded by the stub, so a test can assert on what was sent. */
let calls = [];

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

/**
 * @param {(url: URL, init: object) => Response|undefined} handler
 */
function stubFetch(handler) {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    // Token first: everything else needs one.
    if (url.pathname.includes('/msi/token')) {
      return json({ access_token: 'stub-token', expires_on: Math.floor(Date.now() / 1000) + 3600 });
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method || 'GET', body });
    const res = handler(url, { ...init, body });
    if (!res) throw new Error(`unstubbed call: ${init.method || 'GET'} ${url.pathname}`);
    return res;
  };
}

before(() => {
  // Silence the script's progress output; the assertions are on the calls.
  console.log = () => {};
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  __counters.reset();
});

/* ------------------------------------------------------- pagination */

describe('listing existing content', () => {
  test('domain listing follows the pagination cursor', async () => {
    // A tenant with more than one page of domains used to have its Cortex
    // domains missed on a re-run, and created a second time.
    stubFetch((url) => {
      const skipToken = url.searchParams.get('$skipToken');
      if (!skipToken) {
        return json({
          value: [{ id: 'a', name: 'Water' }],
          nextLink: 'https://api.purview-service.microsoft.com/x?$skipToken=PAGE2'
        });
      }
      return json({ value: [{ id: 'b', name: 'Air quality' }] });
    });

    const all = await listAllDomains();
    assert.deepEqual(
      all.map((d) => d.name),
      ['Water', 'Air quality']
    );
    assert.equal(calls.length, 2, 'should have fetched both pages');
  });

  test('the data product query asks for Draft as well as Published', async () => {
    // THE DUPLICATE BUG. When the publish transition is refused the script
    // falls back to creating the product as DRAFT. A Published-only query then
    // cannot see it next time, so the next run creates it again.
    stubFetch(() => json({ value: [] }));
    await listAllDataProducts();
    const statuses = calls[0].body.multiStatus;
    assert.ok(statuses.includes('Draft'), 'must include Draft');
    assert.ok(statuses.includes('Published'), 'must include Published');
  });

  test('the data product query pages until a short page comes back', async () => {
    let page = 0;
    stubFetch(() => {
      page++;
      if (page === 1) {
        return json({ value: Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, name: `P${i}` })) });
      }
      return json({ value: [{ id: 'last', name: 'Last' }] });
    });

    const all = await listAllDataProducts();
    assert.equal(all.length, 101);
    assert.equal(calls[0].body.skip, 0);
    assert.equal(calls[1].body.skip, 100);
  });
});

/* ------------------------------------------------------- throttling */

describe('rate limiting', () => {
  test('a 429 is retried after the advertised delay', async () => {
    // Purview allows 100 List calls per 20 seconds. A 429 during a bootstrap
    // run is normal, and used to abort the whole step.
    let attempt = 0;
    stubFetch(() => {
      attempt++;
      if (attempt === 1) return json({ error: 'throttled' }, 429, { 'retry-after': '0' });
      return json({ value: [] });
    });

    const res = await purviewFetch('/datagovernance/catalog/businessdomains');
    assert.deepEqual(res, { value: [] });
    assert.equal(attempt, 2, 'should have retried once');
  });

  test('a non-throttling error still fails loudly', async () => {
    stubFetch(() => json({ error: 'forbidden' }, 403));
    await assert.rejects(purviewFetch('/datagovernance/catalog/businessdomains'), /403/);
  });
});

/* ------------------------------------------------------- idempotency */

describe('re-running does not duplicate', () => {
  const domains = [{ id: 'water', name: 'Water', description: 'Water domain' }];

  test('an existing domain is updated in place, not created again', async () => {
    stubFetch((url, init) => {
      if (init.method === 'PUT') return json({ id: 'existing-guid' });
      if (init.method === 'POST') return json({ id: 'should-not-happen' });
      return json({ value: [{ id: 'existing-guid', name: 'Water', description: 'old' }] });
    });

    const ids = await bootstrapDomains(domains);
    assert.equal(ids.water, 'existing-guid', 'must reuse the id Purview already assigned');
    assert.equal(__counters.updated, 1);
    assert.equal(__counters.created, 0);
    assert.ok(!calls.some((c) => c.method === 'POST'), 'must not create a second domain');
  });

  test('a product left as DRAFT by a previous run is updated, not duplicated', async () => {
    const products = [{ id: 'wq', name: 'Water quality archive', domain: 'water', updateFrequency: 'daily' }];
    const draftId = guidFor('product:wq');

    stubFetch((url, init) => {
      if (url.pathname.endsWith('/dataProducts/query')) {
        // What the previous run left behind: the product exists, as DRAFT.
        return json({ value: [{ id: draftId, name: 'Water quality archive', status: 'DRAFT' }] });
      }
      if (init.method === 'PUT') return json({ id: draftId });
      if (init.method === 'POST') return json({ id: 'duplicate' });
      return json({ value: [] });
    });

    await bootstrapDataProducts(products, { water: 'domain-guid' });

    const creates = calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/dataProducts'));
    assert.equal(creates.length, 0, 'must not create a duplicate of the DRAFT product');
    assert.equal(__counters.updated, 1);
    assert.equal(__counters.created, 0);
  });

  test('a product with no matching governance domain fails rather than guessing', async () => {
    stubFetch(() => json({ value: [] }));
    await bootstrapDataProducts([{ id: 'x', name: 'X', domain: 'nonexistent' }], {});
    assert.equal(__counters.failed, 1);
    assert.equal(__counters.created, 0);
  });

  test('when publish is refused the DRAFT fallback of an EXISTING product counts as updated', async () => {
    // Counting it as created made every re-run report 14 new products.
    const products = [{ id: 'wq', name: 'WQ', domain: 'water', updateFrequency: 'daily' }];
    const id = guidFor('product:wq');
    let putCount = 0;

    stubFetch((url, init) => {
      if (url.pathname.endsWith('/dataProducts/query')) {
        return json({ value: [{ id, name: 'WQ', status: 'DRAFT' }] });
      }
      if (init.method === 'PUT') {
        putCount++;
        // Refuse the PUBLISHED transition, accept the DRAFT one.
        if (init.body.status === 'PUBLISHED') return json({ error: 'publish refused' }, 400);
        return json({ id });
      }
      return json({ value: [] });
    });

    await bootstrapDataProducts(products, { water: 'domain-guid' });
    assert.equal(putCount, 2, 'PUBLISHED attempt then DRAFT fallback');
    assert.equal(__counters.updated, 1);
    assert.equal(__counters.created, 0);
  });
});

/* ------------------------------------------------------- apim sequencing */

describe('API Management creation is asynchronous', () => {
  test('a tool waits for the operation the OpenAPI import must produce', async () => {
    // THE 500. The tool references the backing operation by full ARM id. The
    // import that creates that operation had not finished, so APIM answered
    // 500 rather than the documented 400 for a missing operation — which is
    // why five of six skills failed and the first, being slower, did not.
    let attempts = 0;
    stubFetch(() => {
      attempts++;
      return attempts < 3 ? json({ error: 'not there yet' }, 404) : json({ name: 'invoke' });
    });

    await waitForOperation('permit-history', 'invoke');
    assert.equal(attempts, 3, 'should have polled until the operation appeared');
  });

  test('a 500 is retried only where that is asked for', async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts++;
      return attempts === 1 ? json({ error: 'internal' }, 500) : json({ ok: true });
    });
    const res = await apimFetch('/apis/x-mcp/tools/invoke', {
      method: 'PUT',
      retryOn5xx: true
    });
    assert.equal(res.status, 200);
    assert.equal(attempts, 2);
  });

  test('an ordinary 500 still fails immediately', async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts++;
      return json({ error: 'internal' }, 500);
    });
    await assert.rejects(apimFetch('/apis/x'), /500/);
    assert.equal(attempts, 1, 'must not retry by default');
  });
});

/* ------------------------------------------------------- payload mapping */

describe('payload mapping', () => {
  test('update frequency is mapped onto the Purview enum', () => {
    assert.equal(mapFrequency('every 15 minutes'), 'Hourly');
    assert.equal(mapFrequency('Daily'), 'Daily');
    assert.equal(mapFrequency('weekly'), 'Weekly');
    assert.equal(mapFrequency('annual'), 'Yearly');
    assert.equal(mapFrequency(undefined), 'Daily');
  });

  test('managed attributes are an ARRAY of name/value pairs, not a dictionary', () => {
    // Purview rejects the dictionary form with a 400 whose message is pure
    // .NET: "requires a JSON array". Nothing in the payload hints at which
    // field, so this is worth pinning by shape.
    const attrs = attributesFor({
      sensitivity: 'Official-Sensitive',
      allowedGroups: ['waste-crime', 'all-staff'],
      askable: ['how many permits', 'which sites']
    });

    assert.ok(Array.isArray(attrs), 'must be an array');
    for (const a of attrs) {
      assert.equal(typeof a.name, 'string');
      assert.equal(typeof a.value, 'string');
    }
    const byName = Object.fromEntries(attrs.map((a) => [a.name, a.value]));
    assert.equal(byName.cortexSensitivity, 'Official-Sensitive');
    assert.equal(byName.cortexAllowedGroups, 'waste-crime,all-staff');
  });

  test('what bootstrap writes is what the adapter reads back', () => {
    // The read path used to index managedAttributes as a dictionary. Against
    // the real array shape every lookup returned undefined — silently, so the
    // Marketplace just showed defaults. allowedGroups coming back empty feeds
    // straight into visibilityFor(), so this is a governance bug, not cosmetic.
    const product = {
      sensitivity: 'Official',
      licence: 'OGL v3',
      owner: 'Water Quality Team',
      allowedGroups: ['waste-crime'],
      askable: ['how many permits'],
      location: 'North East'
    };
    const roundTripped = toAttributeMap(attributesFor(product));
    assert.equal(roundTripped.cortexSensitivity, 'Official');
    assert.equal(roundTripped.cortexLicence, 'OGL v3');
    assert.equal(roundTripped.cortexOwnerTeam, 'Water Quality Team');
    assert.equal(roundTripped.cortexAllowedGroups, 'waste-crime');
    assert.equal(roundTripped.cortexLocation, 'North East');
  });

  test('the reader still understands the old dictionary shape', () => {
    // A tenant written by an earlier run may still hold it.
    assert.deepEqual(toAttributeMap({ cortexSensitivity: 'Official' }), {
      cortexSensitivity: 'Official'
    });
    assert.deepEqual(toAttributeMap(undefined), {});
  });

  test('the deterministic id is a well-formed v4-shaped GUID and is stable', () => {
    const a = guidFor('domain:water');
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(a, guidFor('domain:water'), 'must be stable across runs');
    assert.notEqual(a, guidFor('domain:air'));
  });
});
