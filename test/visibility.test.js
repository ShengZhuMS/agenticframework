/**
 * The visibility engine is the governance story. If it is wrong, the demo
 * asserts something untrue in front of a CTO. So it is tested exhaustively.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  visibilityFor,
  attachableFor,
  decorate,
  VIS,
  VIS_ORDER
} from '../src/bff/services/visibility.js';

const staff = {
  id: 'consumer',
  name: 'David',
  groups: ['all-staff'],
  clearance: 'Official',
  licences: ['ogl']
};

const analyst = {
  id: 'analyst',
  name: 'Sarah',
  groups: ['all-staff', 'waste-crime', 'analysts'],
  clearance: 'Official',
  licences: ['ogl', 'internal']
};

const owner = {
  id: 'owner',
  name: 'Michael',
  groups: ['all-staff', 'waste-crime', 'ea-waste-regulation', 'restricted-permits'],
  clearance: 'Official–Sensitive',
  licences: ['ogl', 'internal', 'commercial']
};

const entry = (over = {}) => ({
  id: 'x',
  name: 'X',
  cat: 'Data',
  cluster: 'waste',
  owner: 'EA Waste Regulation',
  sens: 'Official',
  access: 'Open to all staff',
  licence: 'Open Government Licence — covers all staff',
  ...over
});

describe('visibilityFor', () => {
  test('open to all staff is available to any member of staff', () => {
    assert.equal(visibilityFor(entry(), staff).state, 'available');
  });

  test('a group-scoped entry is available to a member and requestable by others', () => {
    const e = entry({ allowedGroups: ['waste-crime'] });
    assert.equal(visibilityFor(e, analyst).state, 'available');
    assert.equal(visibilityFor(e, staff).state, 'request');
  });

  test('the request reason names the owner, so the user knows who to ask', () => {
    const e = entry({ allowedGroups: ['waste-crime'] });
    assert.match(visibilityFor(e, staff).reason, /EA Waste Regulation/);
  });

  test('sensitivity outranks group membership', () => {
    const e = entry({ sens: 'Official–Sensitive', allowedGroups: ['all-staff'] });
    assert.equal(visibilityFor(e, staff).state, 'sensitivity');
    assert.equal(visibilityFor(e, owner).state, 'available');
  });

  test('a seat-limited licence excludes those it does not cover', () => {
    const e = entry({ licence: 'Seat-limited commercial licence' });
    assert.equal(visibilityFor(e, analyst).state, 'licence');
    assert.equal(visibilityFor(e, owner).state, 'available');
  });

  test('Open Government Licence covers everyone', () => {
    const e = entry({ licence: 'Open Government Licence — covers all staff and contractors' });
    assert.equal(visibilityFor(e, staff).state, 'available');
  });

  test('"internal only" covers any member of staff, not nobody', () => {
    assert.equal(visibilityFor(entry({ licence: 'Internal only' }), staff).state, 'available');
  });

  test('an askable entry is answerable by a person, whoever is asking', () => {
    const e = entry({ askable: ['Average days sick by directorate'] });
    for (const u of [staff, analyst, owner]) {
      assert.equal(visibilityFor(e, u).state, 'person');
    }
  });

  test('askable outranks sensitivity — the data is never released either way', () => {
    const e = entry({ sens: 'Official–Sensitive', askable: ['Aggregate only'] });
    assert.equal(visibilityFor(e, owner).state, 'person');
  });

  test('an uncleared entry is uncleared for everyone, including its owner', () => {
    assert.equal(visibilityFor(entry({ vis: 'notcleared' }), owner).state, 'notcleared');
  });

  test('no user means nothing is visible', () => {
    assert.equal(visibilityFor(entry(), null).state, 'notcleared');
  });

  test('every returned state is one of the six, and carries a reason', () => {
    const cases = [
      entry(),
      entry({ vis: 'notcleared' }),
      entry({ askable: ['x'] }),
      entry({ sens: 'Official–Sensitive' }),
      entry({ licence: 'Seat-limited commercial licence' }),
      entry({ allowedGroups: ['nobody'] })
    ];
    for (const c of cases) {
      const r = visibilityFor(c, staff);
      assert.ok(VIS_ORDER.includes(r.state), `unexpected state ${r.state}`);
      assert.ok(r.reason && r.reason.length > 0, 'every state must explain itself');
    }
  });

  test('every state in the model has a label, a mark and a next action', () => {
    for (const s of VIS_ORDER) {
      assert.ok(VIS[s].label, `${s} needs a label`);
      assert.ok(VIS[s].mark, `${s} needs a mark — colour alone fails WCAG`);
      assert.ok(VIS[s].next, `${s} needs a next action`);
    }
  });
});

describe('attachableFor — an agent may never reach further than its builder', () => {
  test('only an available entry can be attached as knowledge', () => {
    const e = entry({ allowedGroups: ['waste-crime'] });
    assert.equal(attachableFor(e, analyst).attachable, true);
    assert.equal(attachableFor(e, staff).attachable, false);
  });

  test('a requestable entry explains how to make it attachable', () => {
    const r = attachableFor(entry({ allowedGroups: ['waste-crime'] }), staff);
    assert.equal(r.attachable, false);
    assert.match(r.reason, /Request access first/);
  });

  test('a blocked entry is never attachable and always says why', () => {
    for (const e of [
      entry({ sens: 'Official–Sensitive' }),
      entry({ licence: 'Seat-limited commercial licence' }),
      entry({ vis: 'notcleared' }),
      entry({ askable: ['x'] })
    ]) {
      const r = attachableFor(e, staff);
      assert.equal(r.attachable, false);
      assert.ok(r.reason);
    }
  });
});

describe('decorate', () => {
  test('attaches state, reason and display metadata to every entry', () => {
    const [d] = decorate([entry()], analyst);
    assert.equal(d.vis, 'available');
    assert.ok(d.visReason);
    assert.equal(d.visMeta.label, 'Available');
  });

  test('is pure — the source entry is not mutated', () => {
    const e = entry({ vis: 'seeded-value' });
    decorate([e], analyst);
    assert.equal(e.vis, 'seeded-value');
  });
});
