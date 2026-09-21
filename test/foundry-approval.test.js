/**
 * The approval loop — an MCP tool call registered with require_approval
 * 'always' comes back as a request; Cortex approves it server-side, records
 * it, and continues the same response until there is an answer.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubConfig } from './fixtures.js';
import { LiveFoundry } from '../src/bff/adapters/foundry.js';
import config from '../src/bff/config.js';

const realFetch = globalThis.fetch;
const posts = [];
before(() => {
  stubConfig();
  process.env.IDENTITY_ENDPOINT = 'http://localhost/IDENTITY';
  process.env.IDENTITY_HEADER = 'stub';
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (url.includes('IDENTITY')) return json({ access_token: 't', expires_on: '99999999999' });
    const body = JSON.parse(init.body || '{}');
    posts.push(body);
    if (posts.length === 1) {
      return json({
        id: 'resp_1',
        output: [
          { type: 'mcp_list_tools', server_label: 'magic_map', tools: [{ name: 'find_location' }] },
          { type: 'mcp_approval_request', id: 'apr_1', server_label: 'magic_map', name: 'find_location', arguments: '{"q":"Exeter"}' }
        ]
      });
    }
    return json({
      id: 'resp_2',
      output: [
        { type: 'mcp_call', server_label: 'magic_map', name: 'find_location', arguments: '{"q":"Exeter"}', output: '{"lat":50.7}' },
        { type: 'message', content: [{ type: 'output_text', text: 'Exeter is at 50.7N.', annotations: [{ type: 'url_citation', title: 'MAGIC', url: 'https://magic.defra.gov.uk' }] }] }
      ]
    });
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

describe('respond', () => {
  test('approves the request, continues from the previous response and records the tool calls', async () => {
    const f = new LiveFoundry(config.foundry);
    const a = await f.respond({ agentName: 'data-mapper', input: 'Where is Exeter?' });
    assert.equal(posts.length, 2);
    assert.equal(posts[1].previous_response_id, 'resp_1');
    assert.deepEqual(posts[1].input, [{ type: 'mcp_approval_response', approval_request_id: 'apr_1', approve: true }]);
    assert.equal(posts[1].agent_reference.name, 'data-mapper');
    assert.equal(a.text, 'Exeter is at 50.7N.');
    assert.equal(a.responseId, 'resp_2');
    assert.equal(a.approvalRounds, 1);
    assert.equal(a.sources[0].url, 'https://magic.defra.gov.uk');
    const kinds = a.toolCalls.map((t) => t.kind);
    assert.deepEqual(kinds, ['list', 'approval', 'call']);
    assert.equal(a.toolCalls[2].output, '{"lat":50.7}');
    assert.equal(a.pendingApprovals, 0);
  });
});
