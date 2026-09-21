/**
 * Chat with an agent — who may, whose thread is whose, and how a failure reads.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex, index, USERS } from './fixtures.js';
import config from '../src/bff/config.js';
import { canChat, chat, getThread, threadsFor, clearChats } from '../src/bff/services/chat.js';

let restore;
let agent;
before(async () => {
  restore = await loadIndex();
  agent = index.upsert({
    id: 'lapsed-carriers',
    name: 'Lapsed carriers',
    cat: 'Agent',
    cluster: 'd-waste',
    desc: 'Finds lapsed waste carrier registrations.',
    owner: 'EA Waste Regulation',
    fresh: 'Live',
    sens: 'Official',
    access: 'Open to the team that built it',
    allowedGroups: ['ea-waste-regulation'],
    licence: 'Internal only',
    _source: { system: 'foundry', id: 'lapsed-carriers' },
    _agent: { definition: { builtByTeam: 'EA Waste Regulation', knowledge: [], tools: [] } }
  });
});
after(() => restore && restore());
beforeEach(() => {
  clearChats();
  config.chat.policy = 'all-staff';
});

function fakeFoundry({ fail } = {}) {
  const calls = [];
  return {
    calls,
    async respond(req) {
      calls.push(req);
      if (fail) throw new Error(`Foundry POST /openai/v1/responses failed 400: {"error":{"message":"Authentication failed when connecting to the MCP server https://apim-stub.azure-api.net/magic-map-mcp/mcp: 401 Access denied due to missing subscription key"}}`);
      return {
        text: `Answer ${calls.length}`,
        responseId: `resp_${calls.length}`,
        sources: [{ name: 'Waste carrier registrations', url: null }],
        toolCalls: [{ kind: 'call', server: 'magic_map', tool: 'find', arguments: '{"q":"x"}', error: null }]
      };
    }
  };
}

describe('policy', () => {
  test('all-staff: anyone signed in may chat with any agent, even one not visible to them', () => {
    assert.equal(canChat(agent, USERS.consumer).allowed, true);
    assert.equal(canChat(agent, USERS.consumer).policy, 'all-staff');
  });
  test('visibility: the Marketplace rules apply', () => {
    config.chat.policy = 'visibility';
    assert.equal(canChat(agent, USERS.consumer).allowed, false);
    assert.equal(canChat(agent, USERS.owner).allowed, true);
  });
  test('only agents can be chatted with', () => {
    assert.equal(canChat(index.get('p-water-quality'), USERS.owner).allowed, false);
  });
});

describe('threads', () => {
  test('a first message starts a thread; a follow-up continues it with the previous response id', async () => {
    const foundry = fakeFoundry();
    const first = await chat(agent, 'Which registrations lapsed?', USERS.consumer, { foundry });
    assert.equal(first.thread.turns.length, 1);
    assert.equal(first.turn.answer.text, 'Answer 1');
    const second = await chat(agent, 'And in Kent?', USERS.consumer, { foundry, threadId: first.thread.id });
    assert.equal(second.thread.id, first.thread.id);
    assert.equal(second.thread.turns.length, 2);
    assert.equal(foundry.calls[0].previousResponseId, undefined);
    assert.equal(foundry.calls[1].previousResponseId, 'resp_1');
    assert.equal(foundry.calls[1].agentName, 'lapsed-carriers');
  });

  test('a thread belongs to the person who started it', async () => {
    const foundry = fakeFoundry();
    const { thread } = await chat(agent, 'hello', USERS.consumer, { foundry });
    assert.ok(getThread(thread.id, USERS.consumer));
    assert.equal(getThread(thread.id, USERS.owner), null);
    assert.equal(threadsFor(agent.id, USERS.consumer).length, 1);
    assert.equal(threadsFor(agent.id, USERS.owner).length, 0);
  });

  test('a failed turn is recorded in plain language and the thread stays usable', async () => {
    const failing = fakeFoundry({ fail: true });
    const { thread, turn } = await chat(agent, 'hello', USERS.consumer, { foundry: failing });
    assert.equal(turn.answer, null);
    assert.equal(turn.error.heading, 'The agent could not sign in to one of its tools');
    assert.match(turn.error.message, /API Management/);
    assert.match(turn.error.detail, /401/);
    assert.equal(thread.lastResponseId, null, 'a failed turn does not advance the conversation');
    const ok = fakeFoundry();
    const next = await chat(agent, 'again', USERS.consumer, { foundry: ok, threadId: thread.id });
    assert.equal(next.thread.turns.length, 2);
    assert.equal(next.turn.answer.text, 'Answer 1');
  });

  test('the tools an answer used travel with the turn', async () => {
    const { turn } = await chat(agent, 'hello', USERS.consumer, { foundry: fakeFoundry() });
    assert.equal(turn.answer.toolCalls[0].server, 'magic_map');
  });

  test('a refused policy throws a 403 the route can render', async () => {
    config.chat.policy = 'visibility';
    await assert.rejects(() => chat(agent, 'hi', USERS.consumer, { foundry: fakeFoundry() }), (err) => err.code === 403);
  });
});
