/**
 * Ask — the live model path.
 *
 * Cortex decides WHAT the model may see; Foundry decides what to SAY. These
 * tests pin the boundary between the two: the model is only ever handed
 * entries the asker can reach, the answer on screen is the model's, and a
 * model failure degrades to an honest register answer rather than a blank or
 * a stack trace.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex, USERS } from './fixtures.js';
import { ask, clearThreads, catalogueContext, ASK_INSTRUCTIONS } from '../src/bff/services/ask.js';

let restore;
before(async () => {
  restore = await loadIndex();
});
after(() => restore && restore());
beforeEach(() => clearThreads());

/** A Foundry stand-in that records what it was asked. */
function fakeFoundry({ fail = false, text = 'Model answer citing [1].' } = {}) {
  const calls = { ensure: [], respond: [] };
  return {
    calls,
    async ensureAgent(def) {
      calls.ensure.push(def);
      return { agent: { name: def.name, version: 1 }, created: true };
    },
    async respond(req) {
      calls.respond.push(req);
      if (fail) throw new Error('Foundry POST /openai/v1/responses failed 503: unavailable');
      return { text, responseId: `resp_${calls.respond.length}`, model: 'gpt-5.4-mini', sources: [] };
    }
  };
}

describe('the model answers, Cortex governs', () => {
  test('the answer on screen is the model\u2019s, and the panel says so', async () => {
    const foundry = fakeFoundry({ text: 'The Water quality archive [1] holds sampling results.' });
    const { answer } = await ask('water quality', USERS.analyst, { foundry });
    assert.equal(answer.engine, 'foundry');
    assert.match(answer.text, /Water quality archive \[1\]/);
    assert.match(answer.engineDetail, /cortex-ask/);
    assert.equal(answer.sources[0].ref, 1);
  });

  test('the agent is created once with the house rules, and reused after', async () => {
    const foundry = fakeFoundry();
    await ask('water quality', USERS.analyst, { foundry });
    await ask('waste carrier', USERS.analyst, { foundry });
    assert.equal(foundry.calls.ensure.length, 1, 'ensureAgent runs once per process');
    assert.equal(foundry.calls.ensure[0].name, 'cortex-ask');
    assert.equal(foundry.calls.ensure[0].instructions, ASK_INSTRUCTIONS);
    assert.equal(foundry.calls.respond.length, 2);
  });

  test('the model is never handed an entry the asker cannot reach', async () => {
    const foundry = fakeFoundry();
    await ask('livestock movement records waste carrier', USERS.analyst, { foundry });
    const input = foundry.calls.respond[0].input;
    const reachablePart = input.split('Entries that matched but could NOT be reached')[0];
    assert.ok(!/\[\d+\] Livestock movement records/.test(reachablePart), 'must not be a numbered, citable source');
    assert.match(input, /could NOT be reached[\s\S]*Livestock movement records/, 'but is named as unreachable');
  });

  test('a follow-up carries the previous response id so Foundry keeps the thread', async () => {
    const foundry = fakeFoundry();
    const first = await ask('water quality', USERS.analyst, { foundry });
    await ask('and how fresh is it?', USERS.analyst, { foundry, threadId: first.threadId });
    assert.equal(foundry.calls.respond[0].previousResponseId, null);
    assert.equal(foundry.calls.respond[1].previousResponseId, 'resp_1');
  });

  test('another person\u2019s thread id does not leak their conversation into the model call', async () => {
    const foundry = fakeFoundry();
    const mine = await ask('water quality', USERS.analyst, { foundry });
    await ask('water quality', USERS.consumer, { foundry, threadId: mine.threadId });
    assert.equal(foundry.calls.respond[1].previousResponseId, null);
  });
});

describe('when the model is not there', () => {
  test('the question still gets an answer, labelled as degraded', async () => {
    const foundry = fakeFoundry({ fail: true });
    const { answer } = await ask('water quality', USERS.analyst, { foundry });
    assert.equal(answer.engine, 'register-fallback');
    assert.match(answer.text, /Water quality archive/);
    assert.match(answer.confidence, /model unavailable/i);
    assert.match(answer.degraded, /503/);
    assert.ok(answer.sources.length >= 1, 'the provenance panel is still built from the register');
  });

  test('no model is called when nothing reachable matches — the working is shown instead', async () => {
    const foundry = fakeFoundry();
    const { answer } = await ask('zzzznothingmatchesthis', USERS.consumer, { foundry });
    assert.equal(foundry.calls.respond.length, 0);
    assert.equal(answer.engine, 'register');
    assert.match(answer.text, /registered entries/);
  });

  test('no model is called when the only route is a person', async () => {
    const foundry = fakeFoundry();
    const { answer } = await ask('sickness absence', USERS.consumer, { foundry });
    assert.equal(foundry.calls.respond.length, 0);
    assert.ok(answer.answerableByPerson.length > 0);
  });
});

describe('the catalogue context', () => {
  test('numbers reachable entries for citation and carries the fields that matter', () => {
    const ctx = catalogueContext(
      [
        {
          name: 'Water quality archive',
          cat: 'Data',
          desc: 'Sampling results.',
          owner: 'EA Water Quality',
          ownerState: 'confirmed',
          fresh: 'Daily',
          sens: 'Official',
          licence: 'OGL',
          limits: 'Not uniform.',
          minAgg: null,
          location: 'National'
        }
      ],
      [{ entry: { name: 'Livestock movement records' }, state: 'sensitivity' }],
      []
    );
    assert.match(ctx, /\[1\] Water quality archive/);
    assert.match(ctx, /Known limitations: Not uniform\./);
    assert.match(ctx, /could NOT be reached[\s\S]*Livestock movement records — Sensitivity precludes you/);
  });
});
