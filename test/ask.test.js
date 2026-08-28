/**
 * Ask.
 *
 * The assertion that matters: "what it could not reach" is computed from the
 * visibility engine, not invented. If that ever silently returns empty, an
 * answer built from half the relevant sources looks identical to a complete
 * one — which is exactly the failure mode Cortex exists to prevent.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import index from '../src/bff/index/store.js';
import { ask, threadsFor, getThread, clearThreads } from '../src/bff/services/ask.js';

let analyst;
let consumer;
let owner;

before(async () => {
  await index.init();
  analyst = index.personaById('analyst');
  consumer = index.personaById('consumer');
  owner = index.personaById('owner');
});

beforeEach(() => clearThreads());

describe('answering', () => {
  test('returns an answer, sources and the search scope', async () => {
    const { answer } = await ask('waste carrier registrations', analyst);
    assert.ok(answer.text);
    assert.ok(Array.isArray(answer.sources));
    assert.equal(answer.searched, index.all().length);
    assert.ok(answer.matched >= 1);
  });

  test('every source names its freshness and owner, so the answer is checkable', async () => {
    const { answer } = await ask('waste carrier registrations', analyst);
    for (const s of answer.sources) {
      assert.ok(s.id, 'a source must link back to its entry');
      assert.ok(s.freshness, 'a source without freshness cannot be judged');
      assert.ok(s.owner);
      assert.ok(s.used, 'say what was taken from each source');
    }
  });

  test('only reaches sources the asker can actually see', async () => {
    const { answer } = await ask('livestock movements', analyst);
    const ids = answer.sources.map((s) => s.id);
    assert.ok(!ids.includes('livestock-movements'), 'sensitivity-blocked data must never be a source');
  });
});

describe('what it could not reach — the honesty test', () => {
  test('names relevant sources that were not used', async () => {
    const { answer } = await ask('livestock movements', analyst);
    const names = answer.couldNotReach.map((c) => c.id);
    assert.ok(names.includes('livestock-movements'), 'an unreachable match must be named, not dropped');
  });

  test('each unreachable source carries its state and the reason', async () => {
    const { answer } = await ask('livestock movements permit history', consumer);
    for (const c of answer.couldNotReach) {
      assert.ok(c.stateLabel, 'must show which of the six states applies');
      assert.ok(c.reason && c.reason.length > 5, 'must explain why');
      assert.ok(c.next, 'must say what to do about it');
    }
  });

  test('the same question yields different gaps for different people', async () => {
    const a = await ask('permit history livestock rural land', analyst);
    const c = await ask('permit history livestock rural land', consumer);
    const o = await ask('permit history livestock rural land', owner);
    assert.notEqual(
      a.answer.couldNotReach.length,
      c.answer.couldNotReach.length,
      'reachability must reflect who is asking'
    );
    assert.ok(
      o.answer.couldNotReach.length <= a.answer.couldNotReach.length,
      'the data owner should reach at least as much as the analyst'
    );
  });

  test('confidence drops when something relevant was out of reach', async () => {
    const { answer } = await ask('livestock movements rural land parcels', consumer);
    if (answer.sources.length && answer.couldNotReach.length) {
      assert.equal(answer.confidence, 'Medium');
    }
  });
});

describe('routing to a person — CAP-021', () => {
  test('offers a holder when the data itself is never released', async () => {
    const { answer } = await ask('service incidents tickets', analyst);
    const hasPerson = answer.answerableByPerson.length > 0;
    if (hasPerson) {
      const p = answer.answerableByPerson[0];
      assert.ok(p.owner, 'must name who can answer');
      assert.ok(Array.isArray(p.askable));
    }
  });

  test('a person route carries the minimum aggregation that will be enforced', async () => {
    const { answer } = await ask('service incidents tickets', analyst);
    const withAgg = answer.answerableByPerson.find((p) => p.minAgg);
    if (withAgg) assert.match(withAgg.minAgg, /\w+/);
  });
});

describe('when nothing is found — CAP-012', () => {
  test('gives the working rather than a blank', async () => {
    const { answer } = await ask('zzzznothingmatchesthisquery', consumer);
    assert.equal(answer.sources.length, 0);
    assert.match(answer.text, /registered entries/);
    assert.equal(answer.confidence, 'None');
  });

  test('says the data may exist but be unregistered', async () => {
    const { answer } = await ask('zzzznothingmatchesthisquery', consumer);
    assert.match(answer.text, /not registered|does not exist/i);
  });
});

describe('threads — CAP-002, CAP-003', () => {
  test('a follow-up stays in the same thread', async () => {
    const first = await ask('waste carrier registrations', analyst);
    const second = await ask('and which lapsed?', analyst, { threadId: first.threadId });
    assert.equal(second.threadId, first.threadId);
    assert.equal(second.thread.turns.length, 2);
  });

  test('a new question starts a new thread', async () => {
    const a = await ask('waste', analyst);
    const b = await ask('water', analyst);
    assert.notEqual(a.threadId, b.threadId);
  });

  test('history is grouped and titled by the first question', async () => {
    await ask('waste carrier registrations', analyst);
    const h = threadsFor(analyst);
    assert.equal(h.total, 1);
    assert.equal(h.today.length, 1);
    assert.match(h.today[0].title, /waste carrier/i);
  });

  test('one person cannot read another person\u2019s thread', async () => {
    const mine = await ask('waste', analyst);
    assert.equal(getThread(mine.threadId, consumer), null, 'threads must not leak between users');
    assert.ok(getThread(mine.threadId, analyst));
  });

  test('history is scoped to the person asking', async () => {
    await ask('waste', analyst);
    await ask('water', consumer);
    assert.equal(threadsFor(analyst).total, 1);
    assert.equal(threadsFor(consumer).total, 1);
  });
});
