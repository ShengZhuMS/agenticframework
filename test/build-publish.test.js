/**
 * Building and publishing, against live-loaded entries.
 *
 * The critical assertion: an agent may never reach further than the person who
 * built it. A greyed-out checkbox is a courtesy; the server-side refusal is
 * the control.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex, index, USERS } from './fixtures.js';
import {
  knowledgeOptions,
  validateBuild,
  createAgent,
  composeInstructions
} from '../src/bff/services/agents.js';
import { publishAgent, openApiFor } from '../src/bff/services/publish.js';

let restore;
before(async () => {
  restore = await loadIndex();
});
after(() => restore && restore());

describe('the knowledge checklist — CAP-135', () => {
  test('lists everything relevant, not only what is attachable', () => {
    const opts = knowledgeOptions(USERS.consumer);
    assert.ok(opts.some((o) => o.attachable));
    assert.ok(opts.some((o) => !o.attachable), 'unavailable items must still be listed');
  });

  test('every unattachable item carries the reason', () => {
    for (const o of knowledgeOptions(USERS.consumer).filter((x) => !x.attachable)) {
      assert.ok(o.reason && o.reason.length > 5, `${o.id} must explain why`);
    }
  });

  test('different people get different checklists', () => {
    const a = knowledgeOptions(USERS.analyst).filter((o) => o.attachable).length;
    const c = knowledgeOptions(USERS.consumer).filter((o) => o.attachable).length;
    assert.notEqual(a, c);
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
    const r = await validateBuild({ ...base, knowledge: ['p-waste-carriers'] }, USERS.analyst);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  test('refuses knowledge blocked by sensitivity, even submitted directly', async () => {
    const r = await validateBuild({ ...base, knowledge: ['p-livestock'] }, USERS.analyst);
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /cannot reach further than you can/);
  });

  test('refuses knowledge the builder would have to request first', async () => {
    const r = await validateBuild({ ...base, knowledge: ['p-waste-carriers'] }, USERS.consumer);
    assert.equal(r.ok, false);
  });

  test('refuses an entry that is not in the register', async () => {
    const r = await validateBuild({ ...base, knowledge: ['../../etc/passwd'] }, USERS.analyst);
    assert.equal(r.ok, false);
  });

  test('refuses an action not available this phase', async () => {
    const r = await validateBuild({ ...base, actions: ['read', 'write'] }, USERS.analyst);
    assert.equal(r.ok, false);
    assert.match(r.errors.map((e) => e.message).join(' '), /not available in this phase/);
  });

  test('refuses a model outside the approved catalogue', async () => {
    const r = await validateBuild({ ...base, model: 'gpt-nonexistent' }, USERS.analyst);
    assert.equal(r.ok, false);
  });
});

describe('composed instructions', () => {
  test('the builder\u2019s words come first, house rules after', () => {
    const out = composeInstructions({ instructions: 'MY WORDS' }, []);
    assert.ok(out.indexOf('MY WORDS') < out.indexOf('Cortex house rules'));
  });

  test('house rules require sources, honest gaps and no guessing', () => {
    const out = composeInstructions({ instructions: 'x' }, []);
    assert.match(out, /Name every source/);
    assert.match(out, /what you could not reach/);
    assert.match(out, /Do not guess/);
    assert.match(out, /minimum aggregation/);
    assert.match(out, /untrusted input/);
  });
});

describe('create and publish — the loop closes', () => {
  let created;

  test('an agent is created in Foundry from an allowed definition', async () => {
    const r = await validateBuild(
      {
        name: 'Loop test assistant',
        model: 'gpt-5-mini',
        instructions: 'Answer waste questions.',
        knowledge: ['p-waste-carriers'],
        tools: ['permit-history-lookup'],
        actions: ['read', 'summarise']
      },
      USERS.analyst
    );
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const out = await createAgent(r.definition, USERS.analyst);
    created = out.entry;
    assert.equal(created.cat, 'Agent');
    assert.equal(created._agent.published, false);
    assert.equal(out.gates.length, 7);
  });

  test('a new agent is not shared until it is published', () => {
    assert.ok(!created._endpoints?.mcp);
  });

  test('the generated OpenAPI is importable by APIM', () => {
    const spec = openApiFor(created, 'https://example.test');
    assert.equal(spec.openapi, '3.0.3');
    assert.match(spec.paths['/invoke'].post.operationId, /^[A-Za-z_-]+$/);
    assert.ok(spec.info.description.includes('Reads:'));
  });

  test('publishing registers it and returns an MCP endpoint', async () => {
    const r = await publishAgent(created.id, {
      baseUrl: 'https://example.test',
      visibility: 'all',
      user: USERS.analyst
    });
    assert.ok(r.mcpUrl);
    assert.ok(r.steps.length >= 4);
    assert.equal(r.entry._agent.published, true);
  });

  test('a published agent becomes visible to others', () => {
    const after = index.get(created.id);
    assert.ok(after.allowedGroups.includes('all-staff'));
  });

  test('republishing does not narrow visibility', async () => {
    const a = await publishAgent(created.id, { baseUrl: 'https://example.test', user: USERS.analyst });
    assert.match(a.entry.access, /all staff/i);
  });

  test('the published agent can be attached to the next agent', async () => {
    const r = await validateBuild(
      {
        name: 'Second order agent',
        model: 'gpt-5-mini',
        instructions: 'Use the first agent.',
        tools: [created.id],
        actions: ['read', 'summarise']
      },
      USERS.analyst
    );
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });
});
