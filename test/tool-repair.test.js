/**
 * The self-healing half of the agent → tool 401.
 *
 * "Authentication failed when connecting to the MCP server … 401 Access
 * denied due to missing subscription key" is what an agent says when its MCP
 * tool carries no usable project connection. Cortex now repairs the agent
 * from the definition Foundry holds — no Cortex record needed — and retries
 * the turn once.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubAzure, CONNECTIONS } from './fixtures.js';
import { ensureToolConnections, __forgetToolChecks } from '../src/bff/services/agents.js';
import { LiveFoundry, isToolAuthFailure } from '../src/bff/adapters/foundry.js';
import { connectionNameFor, connectionArmId, connectionRef } from '../src/bff/adapters/foundry-connections.js';
import config from '../src/bff/config.js';

const APIM_TOOL = 'https://apim-stub.azure-api.net/magic-map-mcp/mcp';
const SCREENSHOT_ERROR =
  'Foundry POST /openai/v1/responses failed 400: {"error":{"message":"Authentication failed when connecting to the MCP server: ' +
  'https://prdcoreapimneu001.azure-api.net:443/magic-map-mcp/mcp: Response status code does not indicate success: 401 (Access Denied). ' +
  'Response body: { \\"statusCode\\": 401, \\"message\\": \\"Access denied due to missing subscription key. Make sure to include subscription key when making requests to an API.\\" }. Verify the conf';

let restore;
before(() => {
  restore = stubAzure();
});
after(() => restore && restore());
beforeEach(() => {
  __forgetToolChecks();
  CONNECTIONS.clear();
});

function fakeFoundry(tools) {
  const created = [];
  return {
    created,
    getAgent: async () => ({ name: 'data-mapper', definition: { kind: 'prompt', model: 'gpt-5-mini', instructions: 'Map things.', tools } }),
    createAgent: async (def) => {
      created.push(def);
      return { name: def.name, version: '2' };
    }
  };
}

describe('isToolAuthFailure', () => {
  test('recognises the exact message from the chat window, and nothing else', () => {
    assert.equal(isToolAuthFailure(new Error(SCREENSHOT_ERROR)), true);
    assert.equal(isToolAuthFailure(new Error('Foundry POST /openai/v1/responses failed 500: boom')), false);
    assert.equal(isToolAuthFailure(new Error('Authentication failed when connecting to the MCP server: timeout')), false);
  });
});

describe('ensureToolConnections', () => {
  test('gives an API Management MCP tool its connection and creates a new version; other tools are untouched', async () => {
    const foundry = fakeFoundry([
      { type: 'mcp', server_label: 'magic_map', server_url: APIM_TOOL, require_approval: 'always' },
      { type: 'azure_ai_search', azure_ai_search: { indexes: [{ index_name: 'x' }] } },
      { type: 'code_interpreter' }
    ]);
    const r = await ensureToolConnections('data-mapper', { foundry });
    assert.equal(r.repaired, true);
    assert.equal(foundry.created.length, 1);
    const def = foundry.created[0];
    assert.equal(def.name, 'data-mapper');
    assert.equal(def.model, 'gpt-5-mini');
    assert.equal(def.instructions, 'Map things.');
    assert.equal(def.keepAllTools, true, 'a repair must not drop tool types it does not know');
    assert.equal(def.tools.length, 3);
    const mcp = def.tools.find((t) => t.type === 'mcp');
    const name = connectionNameFor('magic-map-mcp');
    assert.equal(mcp.project_connection_id, connectionRef(name));
    assert.equal(mcp.project_connection_id, connectionArmId(name), 'the id form by default');
    assert.equal(mcp.require_approval, 'always', 'everything else on the tool is kept');
    assert.ok(CONNECTIONS.has(name), 'the connection itself was created');
    assert.deepEqual(def.tools[2], { type: 'code_interpreter' });
  });

  test('an agent whose tools already carry their connections is left alone', async () => {
    const name = connectionNameFor('magic-map-mcp');
    const foundry = fakeFoundry([{ type: 'mcp', server_label: 'magic_map', server_url: APIM_TOOL, project_connection_id: connectionRef(name) }]);
    const r = await ensureToolConnections('data-mapper', { foundry });
    assert.equal(r.repaired, false);
    assert.equal(foundry.created.length, 0);
  });

  test('a tool carrying the bare connection name is moved to the id form (the round-4 shape)', async () => {
    const name = connectionNameFor('magic-map-mcp');
    const foundry = fakeFoundry([{ type: 'mcp', server_label: 'magic_map', server_url: APIM_TOOL, project_connection_id: name }]);
    const r = await ensureToolConnections('data-mapper', { foundry });
    assert.equal(r.repaired, true);
    assert.equal(foundry.created[0].tools[0].project_connection_id, connectionArmId(name));
  });

  test('FOUNDRY_CONNECTION_REF=name writes the bare name instead', async () => {
    const before = config.foundry.connectionRef;
    config.foundry.connectionRef = 'name';
    try {
      const name = connectionNameFor('magic-map-mcp');
      const foundry = fakeFoundry([{ type: 'mcp', server_label: 'magic_map', server_url: APIM_TOOL }]);
      await ensureToolConnections('data-mapper', { foundry });
      assert.equal(foundry.created[0].tools[0].project_connection_id, name);
    } finally {
      config.foundry.connectionRef = before;
    }
  });

  test('a tool that is not on API Management needs no connection', async () => {
    const foundry = fakeFoundry([{ type: 'mcp', server_label: 'purview_catalogue', server_url: 'https://mcp.stub/mcp' }]);
    const r = await ensureToolConnections('data-mapper', { foundry });
    assert.equal(r.repaired, false);
    assert.equal(foundry.created.length, 0);
  });

  test('is checked at most once per interval unless forced', async () => {
    const foundry = fakeFoundry([{ type: 'mcp', server_label: 'magic_map', server_url: APIM_TOOL }]);
    const first = await ensureToolConnections('data-mapper', { foundry, now: 1000 });
    assert.equal(first.repaired, true);
    const second = await ensureToolConnections('data-mapper', { foundry, now: 2000 });
    assert.equal(second.reason, 'checked recently');
    const forced = await ensureToolConnections('data-mapper', { foundry, now: 3000, force: true });
    assert.notEqual(forced.reason, 'checked recently');
  });
});

describe('respond retries once after repairing the tools', () => {
  function adapter(sequence, repairTools) {
    const f = new LiveFoundry({ ...config.foundry, projectEndpoint: 'https://stub.services.ai.azure.com/api/projects/cortex' });
    f.posts = [];
    f._post = async (body) => {
      f.posts.push(body);
      const next = sequence.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    f.repairTools = repairTools;
    return f;
  }

  test('the 401 triggers the repair and the same turn is sent again', async () => {
    const repairs = [];
    const f = adapter(
      [new Error(SCREENSHOT_ERROR), { id: 'resp_2', output_text: 'Exeter is in Devon.', output: [] }],
      async (name, opts) => {
        repairs.push({ name, ...opts });
        return { repaired: true };
      }
    );
    const answer = await f.respond({ agentName: 'data-mapper', input: 'where is Exeter' });
    assert.equal(answer.text, 'Exeter is in Devon.');
    assert.equal(f.posts.length, 2);
    assert.deepEqual(repairs, [{ name: 'data-mapper', force: true }]);
  });

  test('when nothing could be repaired the original error is what the person sees', async () => {
    const f = adapter([new Error(SCREENSHOT_ERROR)], async () => ({ repaired: false, reason: 'no tools' }));
    await assert.rejects(f.respond({ agentName: 'data-mapper', input: 'hi' }), /missing subscription key/);
    assert.equal(f.posts.length, 1);
  });

  test('a repair that itself fails is reported alongside the original error, and there is no second attempt', async () => {
    const f = adapter([new Error(SCREENSHOT_ERROR)], async () => {
      throw new Error('Foundry connection PUT failed 403');
    });
    await assert.rejects(f.respond({ agentName: 'data-mapper', input: 'hi' }), /tried to repair.*PUT failed 403/);
    assert.equal(f.posts.length, 1);
  });

  test('other failures are not retried', async () => {
    let repairs = 0;
    const f = adapter([new Error('Foundry POST /openai/v1/responses failed 500: boom')], async () => {
      repairs++;
      return { repaired: true };
    });
    await assert.rejects(f.respond({ agentName: 'data-mapper', input: 'hi' }), /500/);
    assert.equal(repairs, 0);
  });
});
