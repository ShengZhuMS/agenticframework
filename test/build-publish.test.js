/**
 * Building and publishing.
 *
 * The critical assertion here is the security boundary: an agent may never
 * reach further than the person who built it. A greyed-out checkbox is a
 * courtesy; the server-side refusal is the control, and it is what these
 * tests protect.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import index from '../src/bff/index/store.js';
import {
  knowledgeOptions,
  validateBuild,
  createAgent,
  composeInstructions,
  resolveDefinition
} from '../src/bff/services/agents.js';
import { publishAgent, openApiFor } from '../src/bff/services/publish.js';

let analyst;
let consumer;

before(async () => {
  await index.init();
  analyst = index.personaById('analyst');
  consumer = index.personaById('consumer');
});

describe('the knowledge checklist — CAP-135', () => {
  test('lists everything relevant, not only what is attachable', () => {
    const opts = knowledgeOptions(consumer);
    assert.ok(opts.some((o) => o.attachable), 'expected some attachable');
    assert.ok(opts.some((o) => !o.attachable), 'unavailable items must still be listed');
  });

  test('every unattachable item carries the reason it is unavailable', () => {
    for (const o of knowledgeOptions(consumer).filter((x) => !x.attachable)) {
      assert.ok(o.reason && o.reason.length > 5, `${o.id} must explain why it is disabled`);
    }
  });

  test('different people get different checklists', () => {
    const a = knowledgeOptions(analyst).filter((o) => o.attachable).length;
    const c = knowledgeOptions(consumer).filter((o) => o.attachable).length;
    assert.notEqual(a, c, 'the checklist must reflect who is looking');
  });
});

describe('server-side refusal — the actual control', () => {
  const base = {
    name: 'Test agent',
    model: 'gpt-5-mini',
    instructions: 'Answer questions.',
    actions: ['read', 'summarise']
  };

  test('accepts knowledge the builder can see', async () => {
    const r = await validateBuild({ ...base, knowledge: ['waste-carrier-registrations'] }, analyst);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  test('refuses knowledge blocked by sensitivity, even if submitted directly', async () => {
    const r = await validateBuild({ ...base, knowledge: ['livestock-movements'] }, analyst);
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /cannot reach further than you can/);
  });

  test('refuses knowledge the builder would have to request first', async () => {
    const r = await validateBuild({ ...base, knowledge: ['permit-history-lookup'] }, consumer);
    assert.equal(r.ok, false);
    assert.ok(r.refused.length > 0);
  });

  test('refuses an entry that is not in the register at all', async () => {
    const r = await validateBuild({ ...base, knowledge: ['../../etc/passwd'] }, analyst);
    assert.equal(r.ok, false);
  });

  test('refuses an action that is not available this phase', async () => {
    const r = await validateBuild({ ...base, actions: ['read', 'write'] }, analyst);
    assert.equal(r.ok, false);
    assert.match(r.errors.map((e) => e.message).join(' '), /not available in this phase/);
  });

  test('refuses a model outside the approved catalogue', async () => {
    const r = await validateBuild({ ...base, model: 'gpt-nonexistent' }, analyst);
    assert.equal(r.ok, false);
    assert.match(r.errors.map((e) => e.message).join(' '), /approved catalogue/);
  });

  test('requires a name and instructions', async () => {
    const r = await validateBuild({ ...base, name: '', instructions: '' }, analyst);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length >= 2, true);
  });

  test('every error names the field it belongs to, for the error summary', async () => {
    const r = await validateBuild({ ...base, name: '', model: '' }, analyst);
    for (const e of r.errors) assert.ok(e.field, 'an error without a field cannot be linked to');
  });
});

describe('composed instructions', () => {
  test('the builder\u2019s words come first, house rules after', () => {
    const out = composeInstructions({ instructions: 'MY WORDS' }, []);
    assert.ok(out.indexOf('MY WORDS') < out.indexOf('Cortex house rules'));
  });

  test('house rules require sources, freshness and honest gaps', () => {
    const out = composeInstructions({ instructions: 'x' }, []);
    assert.match(out, /Name every source/);
    assert.match(out, /what you could not reach/);
    assert.match(out, /Do not guess/);
  });

  test('house rules forbid breaching minimum aggregation', () => {
    assert.match(composeInstructions({ instructions: 'x' }, []), /minimum aggregation/);
  });

  test('house rules treat tool output as untrusted', () => {
    assert.match(composeInstructions({ instructions: 'x' }, []), /untrusted input/);
  });

  test('attached sources are listed with freshness and sensitivity', () => {
    const k = [{ name: 'Waste carrier registrations', fresh: 'Daily', sens: 'Official' }];
    assert.match(composeInstructions({ instructions: 'x' }, k), /Waste carrier registrations \(Daily, Official\)/);
  });
});

describe('create and publish — the loop closes', () => {
  let created;

  test('an agent can be created from an allowed definition', async () => {
    const r = await validateBuild(
      {
        name: 'Loop test assistant',
        model: 'gpt-5-mini',
        instructions: 'Answer waste questions.',
        knowledge: ['waste-carrier-registrations'],
        tools: ['permit-history-lookup'],
        actions: ['read', 'summarise']
      },
      analyst
    );
    assert.equal(r.ok, true);
    const out = await createAgent(r.definition, analyst);
    created = out.entry;
    assert.equal(created.cat, 'Agent');
    assert.equal(created._agent.published, false);
    assert.ok(out.gates.length === 7);
  });

  test('a new agent is registered in the marketplace immediately', () => {
    assert.ok(index.get(created.id), 'the agent must appear in the register');
  });

  test('a new agent is not shared until it is published', () => {
    assert.ok(!created._endpoints?.mcp, 'no MCP endpoint before publishing');
  });

  test('the agent records what it depends on', () => {
    assert.ok(created.deps.includes('waste-carrier-registrations'));
  });

  test('sensitivity is inherited from the most sensitive attached source', () => {
    assert.equal(created.sens, 'Official');
  });

  test('the generated OpenAPI is valid enough for APIM to import', () => {
    const spec = openApiFor(created, 'https://example.test');
    assert.equal(spec.openapi, '3.0.3');
    assert.ok(spec.paths['/invoke'].post);
    // APIM and Foundry both require operationId to be letters, - and _ only.
    assert.match(spec.paths['/invoke'].post.operationId, /^[A-Za-z_-]+$/);
    assert.ok(spec.info.description.includes('Reads:'), 'the spec must declare what it reads');
  });

  test('publishing registers it and returns an MCP endpoint', async () => {
    const r = await publishAgent(created.id, {
      baseUrl: 'https://example.test',
      visibility: 'all',
      user: analyst
    });
    assert.ok(r.mcpUrl, 'expected an MCP endpoint');
    assert.ok(r.steps.length >= 4, 'the publish steps are the demo; there must be four');
    assert.equal(r.entry._agent.published, true);
    assert.equal(r.entry._endpoints.mcp, r.mcpUrl);
  });

  test('a published agent becomes visible to others', () => {
    const after = index.get(created.id);
    assert.match(after.access, /all staff/i);
    assert.ok(after.allowedGroups.includes('all-staff'));
  });

  test('publishing is idempotent — the demo is rehearsed many times', async () => {
    const a = await publishAgent(created.id, { baseUrl: 'https://example.test', user: analyst });
    const b = await publishAgent(created.id, { baseUrl: 'https://example.test', user: analyst });
    assert.equal(a.mcpUrl, b.mcpUrl, 'republishing must not create a second endpoint');
  });

  test('the published agent can itself be attached to the next agent', async () => {
    const opts = knowledgeOptions(analyst);
    const r = await validateBuild(
      {
        name: 'Second order agent',
        model: 'gpt-5-mini',
        instructions: 'Use the first agent.',
        tools: [created.id],
        actions: ['read', 'summarise']
      },
      analyst
    );
    assert.equal(r.ok, true, 'a published agent must be usable as a part: ' + JSON.stringify(r.errors));
  });
});
