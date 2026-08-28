/**
 * Requests — the lifecycle.
 *
 * The claim this section rests on is that none of the controls move. These
 * tests are what make that claim checkable:
 *   - drafting happens inside the HOLDER's permissions, never the requester's
 *   - nothing reaches a requester without a person releasing it
 *   - somebody who cannot reach the data cannot act on the request
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex, USERS } from './fixtures.js';
import * as reqs from '../src/bff/services/requests.js';

let restore;
before(async () => {
  restore = await loadIndex();
});
after(() => restore && restore());
beforeEach(() => reqs.clearAll());

const stubFoundry = {
  respond: async () => ({ text: 'Average 6.2 days per employee, by directorate.', sources: [] })
};

describe('proposing a holder — CAP-055', () => {
  test('finds who holds data that can answer, without the org chart', () => {
    const holders = reqs.proposeHolders('average days sick per employee');
    assert.ok(holders.length > 0);
    assert.equal(holders[0].owner, 'DDTS Performance');
  });

  test('a proposed holder states the aggregation it will enforce', () => {
    const h = reqs.proposeHolders('sickness absence')[0];
    assert.match(h.minAgg, /Directorate/);
  });

  test('proposes nobody for something no one holds', () => {
    assert.equal(reqs.proposeHolders('zzzznothingmatches').length, 0);
  });
});

describe('raising — CAP-052, CAP-054, CAP-056', () => {
  test('a request records the question, purpose and cadence', () => {
    const r = reqs.raise({
      question: 'Average days sick',
      purpose: 'Board report',
      cadence: 'monthly',
      requester: USERS.consumer,
      holderEntryId: 'p-sickness'
    });
    assert.match(r.ref, /^REQ-\d{4}$/);
    assert.equal(r.status, 'raised');
    assert.equal(r.purpose, 'Board report');
    assert.equal(r.cadence, 'monthly');
    assert.equal(r.holder, 'DDTS Performance');
  });

  test('the minimum aggregation travels with the request from the start', () => {
    const r = reqs.raise({
      question: 'q',
      purpose: 'p',
      requester: USERS.consumer,
      holderEntryId: 'p-sickness'
    });
    assert.match(r.minAgg, /Directorate/);
  });
});

describe('drafting happens inside the HOLDER permissions — the whole claim', () => {
  test('a holder who can reach the data can draft', async () => {
    const r = reqs.raise({
      question: 'Average days sick',
      purpose: 'Board report',
      requester: USERS.consumer,
      holderEntryId: 'p-sickness'
    });
    const drafted = await reqs.draft(r.ref, USERS.analyst, { foundry: stubFoundry });
    assert.equal(drafted.status, 'drafted');
    assert.ok(drafted.draft.text);
  });

  test('the method records whose access it was computed inside', async () => {
    const r = reqs.raise({
      question: 'q',
      purpose: 'p',
      requester: USERS.consumer,
      holderEntryId: 'p-sickness'
    });
    const d = await reqs.draft(r.ref, USERS.analyst, { foundry: stubFoundry });
    assert.match(d.draft.method, new RegExp(USERS.analyst.name));
    assert.match(d.draft.method, /requester received no records/i);
  });

  test('the method states the aggregation that was enforced', async () => {
    const r = reqs.raise({
      question: 'q',
      purpose: 'p',
      requester: USERS.consumer,
      holderEntryId: 'p-sickness'
    });
    const d = await reqs.draft(r.ref, USERS.analyst, { foundry: stubFoundry });
    assert.match(d.draft.method, /Directorate level/);
  });

  test('somebody who cannot reach the data cannot draft it either', async () => {
    const r = reqs.raise({
      question: 'q',
      purpose: 'p',
      requester: USERS.consumer,
      holderEntryId: 'p-livestock'
    });
    await assert.rejects(
      () => reqs.draft(r.ref, USERS.analyst, { foundry: stubFoundry }),
      /cannot reach/i
    );
  });

  test('a drafting failure does not lose the request', async () => {
    const r = reqs.raise({
      question: 'q',
      purpose: 'p',
      requester: USERS.consumer,
      holderEntryId: 'p-sickness'
    });
    const failing = { respond: async () => { throw new Error('Foundry unavailable'); } };
    const d = await reqs.draft(r.ref, USERS.analyst, { foundry: failing });
    assert.equal(d.status, 'drafted');
    assert.equal(d.draft.text, null);
    assert.match(d.draftError, /unavailable/);
    assert.ok(d.draft.method, 'the method is still recorded so the holder can answer by hand');
  });
});

describe('release requires a person — CAP-074', () => {
  test('nothing reaches the requester until somebody releases it', async () => {
    const r = reqs.raise({
      question: 'q',
      purpose: 'p',
      requester: USERS.consumer,
      holderEntryId: 'p-sickness'
    });
    await reqs.draft(r.ref, USERS.analyst, { foundry: stubFoundry });
    assert.equal(reqs.get(r.ref).released, null, 'a draft is not a release');

    const released = reqs.release(r.ref, USERS.analyst, { answer: 'Six point two days.' });
    assert.equal(released.status, 'released');
    assert.equal(released.released.releasedBy, USERS.analyst.name);
  });

  test('the method travels with the released answer — CAP-063', () => {
    const r = reqs.raise({
      question: 'q',
      purpose: 'p',
      requester: USERS.consumer,
      holderEntryId: 'p-sickness'
    });
    return reqs.draft(r.ref, USERS.analyst, { foundry: stubFoundry }).then(() => {
      const out = reqs.release(r.ref, USERS.analyst, { answer: 'x' });
      assert.ok(out.released.method, 'an answer without its method cannot be checked');
    });
  });

  test('a caveat travels with the answer — CAP-073', () => {
    const r = reqs.raise({ question: 'q', purpose: 'p', requester: USERS.consumer, holderEntryId: 'p-sickness' });
    const out = reqs.release(r.ref, USERS.analyst, { answer: 'x', caveat: 'Excludes contractors.' });
    assert.equal(out.released.caveat, 'Excludes contractors.');
  });

  test('approving the method lets it recur without the responder — CAP-076', async () => {
    const r = reqs.raise({ question: 'Average days sick', purpose: 'p', requester: USERS.consumer, holderEntryId: 'p-sickness' });
    await reqs.draft(r.ref, USERS.analyst, { foundry: stubFoundry });
    reqs.release(r.ref, USERS.analyst, { answer: 'x', approveMethod: true });
    const methods = reqs.approvedMethods();
    assert.equal(methods.length, 1);
    assert.equal(methods[0].owner, USERS.analyst.name);
  });

  test('declining records a reason and what was offered instead — CAP-079, CAP-068', () => {
    const r = reqs.raise({ question: 'q', purpose: 'p', requester: USERS.consumer, holderEntryId: 'p-sickness' });
    const out = reqs.decline(r.ref, USERS.analyst, {
      reason: 'Too granular to release.',
      offered: 'Directorate-level totals instead.'
    });
    assert.equal(out.status, 'declined');
    assert.match(out.declined.offered, /Directorate/);
  });
});

describe('who sees what', () => {
  test('a requester sees their own requests — CAP-061', () => {
    reqs.raise({ question: 'mine', purpose: 'p', requester: USERS.consumer, holderEntryId: 'p-sickness' });
    reqs.raise({ question: 'theirs', purpose: 'p', requester: USERS.owner, holderEntryId: 'p-sickness' });
    assert.equal(reqs.raisedBy(USERS.consumer).length, 1);
    assert.equal(reqs.raisedBy(USERS.consumer)[0].question, 'mine');
  });

  test('a request waits on whoever can reach the data — CAP-069', () => {
    reqs.raise({ question: 'q', purpose: 'p', requester: USERS.consumer, holderEntryId: 'p-livestock' });
    // p-livestock is Official–Sensitive: only the cleared owner can reach it.
    assert.equal(reqs.waitingOn(USERS.owner).length, 1);
    assert.equal(reqs.waitingOn(USERS.analyst).length, 0);
  });

  test('a requester is never their own holder', () => {
    // An "answerable by a person" entry resolves to that state for EVERYONE,
    // because the data is never released to anyone. Deciding holdership from
    // that state would make every requester their own holder and requests
    // would appear to wait on the person who raised them.
    reqs.raise({
      question: 'Average days sick',
      purpose: 'p',
      requester: USERS.consumer,
      holderEntryId: 'p-sickness'
    });
    assert.equal(
      reqs.waitingOn(USERS.consumer).length,
      0,
      'the requester holds no group that reaches this data'
    );
    assert.equal(reqs.waitingOn(USERS.analyst).length, 1, 'a genuine holder must see it');
  });

  test('every step is recorded in the history', async () => {
    const r = reqs.raise({ question: 'q', purpose: 'p', requester: USERS.consumer, holderEntryId: 'p-sickness' });
    await reqs.draft(r.ref, USERS.analyst, { foundry: stubFoundry });
    reqs.release(r.ref, USERS.analyst, { answer: 'x' });
    const h = reqs.get(r.ref).history;
    assert.equal(h.length, 3);
    assert.match(h[2].what, /Released by a person/);
  });
});
