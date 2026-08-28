/**
 * The seven assurance gates.
 *
 * These are computed, not hardcoded, so that when somebody in the demo asks
 * "what if it DID read personal data?" the answer is to change the selection
 * and watch the table change. These tests are what make that claim safe.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gatesFor, blockingGates, ACTIONS, GATE_STATUS } from '../src/bff/services/assurance.js';

const models = [
  { id: 'gpt-5-mini', name: 'First-party, small and fast', approved: true },
  { id: 'third-party-review', name: 'Third-party model', approved: false }
];

const agent = (over = {}) => ({
  name: 'test',
  model: 'gpt-5-mini',
  instructions: 'x',
  actions: ['read', 'summarise'],
  ...over
});

const source = (over = {}) => ({
  id: 's',
  name: 'A source',
  sens: 'Official',
  desc: 'Ordinary reference data about rivers',
  vis: 'available',
  ...over
});

const gate = (gates, id) => gates.find((g) => g.id === id);

describe('the gate set', () => {
  test('there are exactly seven gates', () => {
    assert.equal(gatesFor(agent(), [], models).length, 7);
  });

  test('every gate carries a status, a tone and a reason', () => {
    for (const g of gatesFor(agent(), [source()], models)) {
      assert.ok(g.name, 'gate needs a name');
      assert.ok(g.label, 'gate needs a status label');
      assert.ok(g.tone, 'gate needs a tone');
      assert.ok(g.reason && g.reason.length > 10, `${g.id} needs a reason worth reading`);
    }
  });

  test('every status maps to a known label', () => {
    for (const g of gatesFor(agent(), [source()], models)) {
      assert.ok(GATE_STATUS[g.statusKey], `unknown status ${g.statusKey}`);
    }
  });
});

describe('data protection impact assessment', () => {
  test('not required when no attached source holds personal data', () => {
    const g = gate(gatesFor(agent(), [source()], models), 'dpia');
    assert.equal(g.statusKey, 'notRequired');
  });

  test('required when a source is Official–Sensitive', () => {
    const g = gate(gatesFor(agent(), [source({ sens: 'Official–Sensitive' })], models), 'dpia');
    assert.equal(g.statusKey, 'outstanding');
    assert.match(g.reason, /Official–Sensitive/);
  });

  test('required when a source describes personal records', () => {
    const g = gate(
      gatesFor(agent(), [source({ desc: 'Individual sickness absence records per employee' })], models),
      'dpia'
    );
    assert.equal(g.statusKey, 'outstanding');
  });

  test('the reason counts the sensitive sources, so it is checkable', () => {
    const g = gate(
      gatesFor(
        agent(),
        [source({ id: 'a', sens: 'Official–Sensitive' }), source({ id: 'b', sens: 'Official–Sensitive' })],
        models
      ),
      'dpia'
    );
    assert.match(g.reason, /2 of the attached sources/);
  });
});

describe('gateway security review', () => {
  test('complete when every attached source has cleared', () => {
    const g = gate(gatesFor(agent(), [source()], models), 'gateway');
    assert.equal(g.statusKey, 'complete');
  });

  test('outstanding when a source has not cleared the gateway', () => {
    const g = gate(gatesFor(agent(), [source({ vis: 'notcleared' })], models), 'gateway');
    assert.equal(g.statusKey, 'outstanding');
  });
});

describe('responsible AI review', () => {
  test('in progress when the agent summarises for a decision', () => {
    const g = gate(gatesFor(agent({ actions: ['read', 'summarise'] }), [source()], models), 'rai');
    assert.equal(g.statusKey, 'inProgress');
    assert.match(g.reason, /summarises for a decision/);
  });

  test('not required when the agent only retrieves', () => {
    const g = gate(gatesFor(agent({ actions: ['read'] }), [source()], models), 'rai');
    assert.equal(g.statusKey, 'notRequired');
  });
});

describe('model catalogue approval', () => {
  test('complete for a first-party approved model', () => {
    const g = gate(gatesFor(agent(), [], models), 'model');
    assert.equal(g.statusKey, 'complete');
  });

  test('outstanding for a third-party model', () => {
    const g = gate(gatesFor(agent({ model: 'third-party-review' }), [], models), 'model');
    assert.equal(g.statusKey, 'outstanding');
    assert.match(g.reason, /third-party/i);
  });
});

describe('red team report', () => {
  test('not started when the agent reads retrieved content', () => {
    const g = gate(gatesFor(agent(), [source()], models), 'redteam');
    assert.equal(g.statusKey, 'notStarted');
    assert.match(g.reason, /[Ii]ndirect injection/);
  });

  test('not applicable when the agent retrieves nothing', () => {
    const g = gate(gatesFor(agent({ actions: ['summarise'] }), [], models), 'redteam');
    assert.equal(g.statusKey, 'notApplicable');
  });

  test('names untrusted tool output as the risk', () => {
    const g = gate(gatesFor(agent(), [source()], models), 'redteam');
    assert.match(g.reason, /untrusted input/);
  });
});

describe('accessibility', () => {
  test('always applies — it is a legal obligation', () => {
    for (const a of [agent(), agent({ actions: [] }), agent({ actions: ['read'] })]) {
      const g = gate(gatesFor(a, [], models), 'a11y');
      assert.equal(g.statusKey, 'notStarted');
      assert.match(g.reason, /legal obligation/);
    }
  });
});

describe('service assessment', () => {
  test('not applicable for an internal read-and-summarise agent', () => {
    const g = gate(gatesFor(agent(), [source()], models), 'service');
    assert.equal(g.statusKey, 'notApplicable');
  });

  test('outstanding when the agent writes or sends', () => {
    for (const act of ['write', 'send']) {
      const g = gate(gatesFor(agent({ actions: ['read', act] }), [source()], models), 'service');
      assert.equal(g.statusKey, 'outstanding', `${act} should trigger a service assessment`);
    }
  });
});

describe('blockingGates', () => {
  test('returns only outstanding gates', () => {
    const gates = gatesFor(agent({ model: 'third-party-review' }), [source({ sens: 'Official–Sensitive' })], models);
    const blocking = blockingGates(gates);
    assert.ok(blocking.length >= 2);
    for (const g of blocking) assert.equal(g.statusKey, 'outstanding');
  });

  test('a clean agent has nothing outstanding', () => {
    assert.equal(blockingGates(gatesFor(agent(), [source()], models)).length, 0);
  });
});

describe('permitted actions', () => {
  test('read and summarise are available; write and send are not, this phase', () => {
    const byId = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));
    assert.equal(byId.read.available, true);
    assert.equal(byId.summarise.available, true);
    assert.equal(byId.write.available, false);
    assert.equal(byId.send.available, false);
  });

  test('unavailable actions still carry an explanation, because they are shown', () => {
    for (const a of ACTIONS.filter((x) => !x.available)) {
      assert.match(a.hint, /Not this phase/);
    }
  });
});
