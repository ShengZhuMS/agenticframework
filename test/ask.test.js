/**
 * Ask.
 *
 * The assertion that matters: "what it could not reach" is computed from the
 * visibility engine against live-loaded entries. If it silently returns empty,
 * an answer built from half the relevant sources looks identical to a complete
 * one — the exact failure Cortex exists to prevent.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex, USERS } from './fixtures.js';
import { ask, threadsFor, getThread, clearThreads } from '../src/bff/services/ask.js';

let restore;
before(async () => {
  restore = await loadIndex();
});
after(() => restore && restore());
beforeEach(() => clearThreads());

describe('answering', () => {
  test('returns an answer, sources and the search scope', async () => {
    const { answer } = await ask('water quality', USERS.analyst);
    assert.ok(answer.text);
    assert.ok(answer.searched >= 1);
  });

  test('every source names its freshness and owner', async () => {
    const { answer } = await ask('water quality', USERS.analyst);
    for (const s of answer.sources) {
      assert.ok(s.id);
      assert.ok(s.freshness);
      assert.ok(s.owner);
    }
  });

  test('never reaches a source the asker cannot see', async () => {
    const { answer } = await ask('livestock movement records', USERS.analyst);
    assert.ok(!answer.sources.map((s) => s.id).includes('p-livestock'));
  });
});

describe('what it could not reach — the honesty test', () => {
  test('names a relevant source that was not used', async () => {
    const { answer } = await ask('livestock movement records', USERS.analyst);
    assert.ok(answer.couldNotReach.map((c) => c.id).includes('p-livestock'));
  });

  test('each unreachable source carries its state, reason and next step', async () => {
    const { answer } = await ask('livestock waste carrier', USERS.consumer);
    for (const c of answer.couldNotReach) {
      assert.ok(c.stateLabel);
      assert.ok(c.reason && c.reason.length > 5);
      assert.ok(c.next);
    }
  });

  test('the same question yields different gaps for different people', async () => {
    const a = await ask('waste carrier livestock water', USERS.analyst);
    const c = await ask('waste carrier livestock water', USERS.consumer);
    assert.notEqual(
      a.answer.couldNotReach.length,
      c.answer.couldNotReach.length,
      'reachability must reflect who is asking'
    );
  });
});

describe('routing to a person — CAP-021', () => {
  test('offers a holder when the data itself is never released', async () => {
    const { answer } = await ask('sickness absence', USERS.analyst);
    assert.ok(answer.answerableByPerson.length > 0, 'an askable source must offer its holder');
    assert.ok(answer.answerableByPerson[0].owner);
  });

  test('the person route states the aggregation that will be enforced', async () => {
    const { answer } = await ask('sickness absence', USERS.analyst);
    assert.match(answer.answerableByPerson[0].minAgg, /Directorate/);
  });
});

describe('when nothing is found — CAP-012', () => {
  test('gives the working rather than a blank', async () => {
    const { answer } = await ask('zzzznothingmatchesthis', USERS.consumer);
    assert.equal(answer.sources.length, 0);
    assert.equal(answer.confidence, 'None');
    assert.match(answer.text, /registered entries/);
  });
});

describe('threads', () => {
  test('a follow-up stays in the same thread', async () => {
    const first = await ask('water quality', USERS.analyst);
    const second = await ask('and which lapsed?', USERS.analyst, { threadId: first.threadId });
    assert.equal(second.threadId, first.threadId);
    assert.equal(second.thread.turns.length, 2);
  });

  test('one person cannot read another person\u2019s thread', async () => {
    const mine = await ask('water', USERS.analyst);
    assert.equal(getThread(mine.threadId, USERS.consumer), null);
    assert.ok(getThread(mine.threadId, USERS.analyst));
  });

  test('history is scoped to the person asking', async () => {
    await ask('water', USERS.analyst);
    await ask('waste', USERS.consumer);
    assert.equal(threadsFor(USERS.analyst).total, 1);
    assert.equal(threadsFor(USERS.consumer).total, 1);
  });
});
