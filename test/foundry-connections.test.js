/**
 * Project connections — the fix for "401 Access denied due to missing
 * subscription key" when an agent calls an API Management MCP server.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubAzure, CONNECTIONS, resetRoundFour } from './fixtures.js';
import config from '../src/bff/config.js';
import {
  connectionNameFor,
  connectionArmId,
  ensureMcpConnection,
  ensureSearchConnection,
  connectionsConfigured
} from '../src/bff/adapters/foundry-connections.js';

let restore;
before(() => {
  restore = stubAzure();
});
after(() => restore && restore());
beforeEach(() => resetRoundFour());

describe('connection names', () => {
  test('are valid Foundry connection names whatever the API Management id looks like', () => {
    for (const id of ['magic-map-mcp', 'a', 'some-very-long-agent-name-that-goes-on-and-on-and-on-mcp', 'Weird Name!!']) {
      const n = connectionNameFor(id);
      assert.match(n, /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,32}$/, `${id} → ${n}`);
      assert.ok(n.length <= 33);
    }
  });

  test('are stable and distinct', () => {
    assert.equal(connectionNameFor('magic-map-mcp'), connectionNameFor('magic-map-mcp'));
    assert.notEqual(connectionNameFor('magic-map-mcp'), connectionNameFor('magic-map-mcp-2'));
    assert.match(connectionNameFor('magic-map-mcp'), /^cx-mcp-magic-map-mcp-[0-9a-f]{5}$/);
  });
});

describe('ensureMcpConnection', () => {
  test('uses a stable replacement only for purge-protected deleted secrets', async () => {
    const previousFetch = globalThis.fetch;
    const original = connectionNameFor('deleted-demo');
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes(`/connections/${original}?`) && init.method === 'PUT') {
        return new Response('Secret is in deleted state with purge protection enabled', { status: 400 });
      }
      return previousFetch(url, init);
    };
    try {
      const first = await ensureMcpConnection({ apiId: 'deleted-demo', target: 'https://stub/mcp' });
      const second = await ensureMcpConnection({ apiId: 'deleted-demo', target: 'https://stub/mcp' });
      assert.notEqual(first.name, original);
      assert.equal(second.name, first.name);
      assert.equal(second.created, false);
    } finally { globalThis.fetch = previousFetch; }
  });

  test('PUTs a RemoteTool connection with the APIM key under Ocp-Apim-Subscription-Key', async () => {
    const r = await ensureMcpConnection({ apiId: 'magic-map-mcp', target: 'https://apim-stub.azure-api.net/magic-map-mcp/mcp' });
    assert.equal(r.created, true);
    const stored = CONNECTIONS.get(r.name);
    assert.equal(stored.properties.category, 'RemoteTool');
    assert.equal(stored.properties.authType, 'CustomKeys');
    assert.equal(stored.properties.target, 'https://apim-stub.azure-api.net/magic-map-mcp/mcp');
    assert.equal(stored.properties.credentials.keys['Ocp-Apim-Subscription-Key'], 'stub-apim-key');
    assert.equal(stored.properties.metadata.type, 'custom_MCP');
    assert.equal(r.id, connectionArmId(r.name));
    assert.match(r.id, /providers\/Microsoft\.CognitiveServices\/accounts\/fdry-stub\/projects\/proj-stub\/connections\//);
  });

  test('is idempotent: an existing connection with the same target is left alone', async () => {
    const first = await ensureMcpConnection({ apiId: 'x-mcp', target: 'https://apim-stub.azure-api.net/x-mcp/mcp' });
    const second = await ensureMcpConnection({ apiId: 'x-mcp', target: 'https://apim-stub.azure-api.net/x-mcp/mcp' });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(CONNECTIONS.size, 1);
  });

  test('refuses clearly when the project location or the key is missing', async () => {
    const saved = config.apim.subscriptionKey;
    config.apim.subscriptionKey = '';
    await assert.rejects(() => ensureMcpConnection({ apiId: 'y', target: 'https://x/mcp' }), /subscription key/);
    config.apim.subscriptionKey = saved;
    const acct = config.foundry.accountName;
    config.foundry.accountName = '';
    assert.equal(connectionsConfigured(), false);
    await assert.rejects(() => ensureMcpConnection({ apiId: 'y', target: 'https://x/mcp' }), /not configured/);
    config.foundry.accountName = acct;
  });
});

describe('ensureSearchConnection', () => {
  test('is keyless (AAD) and points at the search endpoint', async () => {
    const r = await ensureSearchConnection();
    assert.equal(r.name, 'cortex-search');
    const stored = CONNECTIONS.get('cortex-search');
    assert.equal(stored.properties.category, 'CognitiveSearch');
    assert.equal(stored.properties.authType, 'AAD');
    assert.equal(stored.properties.target, 'https://srch-stub.search.windows.net');
    assert.equal(stored.properties.credentials, undefined);
  });
});
