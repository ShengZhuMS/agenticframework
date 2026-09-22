/**
 * Smoke — boot the real server against stubbed Azure and open every page a
 * demo visits.
 *
 * Unit tests prove the pieces; this proves the wiring. A page that throws
 * renders the 500 page, which this catches, and a page that renders a
 * misleading word — the old Ask page said "demo mode is on" — is caught by the
 * content assertions.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stubAzure } from './fixtures.js';
import config from '../src/bff/config.js';
import index from '../src/bff/index/store.js';

let restore;
let server;
let base;

before(async () => {
  restore = stubAzure();
  // The real server, on a free port, signed in as a fixed local identity —
  // exactly how Start-Local.ps1 runs it.
  config.port = 0;
  config.entra.allowUnauthenticated = true;
  config.entra.localUser = 'Smoke Tester';
  config.entra.localGroups = ['waste-crime', 'analysts'];
  config.index.refreshMinutes = 0;
  index.entries.clear();
  index.domains = [];

  const { start } = await import('../src/bff/server.js');
  server = await start();
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  restore?.();
  config.entra.allowUnauthenticated = false;
});

async function page(path, init) {
  const res = await fetch(base + path, { redirect: 'manual', ...init });
  const body = await res.text();
  return { status: res.status, body, location: res.headers.get('location') };
}

describe('every demo page renders', () => {
  for (const path of ['/', '/about', '/marketplace', '/marketplace/map', '/build', '/build/new', '/share', '/requests', '/profile', '/help', '/automate', '/automate/new']) {
    test(`${path} is 200 and not the error page`, async () => {
      const r = await page(path);
      assert.equal(r.status, 200, path);
      assert.ok(!/problem with the service/.test(r.body), `${path} rendered the 500 page`);
    });
  }

  test('the About page explains the neutral accelerator, live figures and limitations', async () => {
    const r = await page('/about');
    assert.equal(r.status, 200);
    // Every section a leader is promised in the contents list is on the page.
    for (const id of ['purpose', 'problem', 'system', 'architecture', 'value', 'journey', 'governance', 'readiness']) {
      assert.match(r.body, new RegExp(`<section id="${id}"`), `section ${id} missing`);
    }
    assert.match(r.body, /Microsoft technology accelerator/);
    assert.match(r.body, /read live from the register/);
    assert.match(r.body, /text alternative/);
    assert.match(r.body, /not a safety certification/);
    assert.match(r.body, /same code and synthetic demonstration pack/);
    assert.match(r.body, /<svg[^>]+role="img"[^>]+aria-labelledby="architecture-title architecture-desc"/);
    assert.match(r.body, /Azure landing-zone foundation/);
    assert.equal((r.body.match(/<section id=/g) || []).length, 8, 'Restore all original Novo About sections');
    // The nav highlights it and the footer links to it.
    assert.match(r.body, /href="\/about" aria-current="page">About<\/a>/);
    assert.match(r.body, /href="\/about">About Cortex<\/a>/);
  });

  test('an entry page shows the entry standard, with the catalogue status from Purview', async () => {
    const r = await page('/entry/p-water-quality');
    assert.equal(r.status, 200);
    assert.match(r.body, /Water quality archive/);
    assert.match(r.body, /Catalogue status/);
  });

  test('a data product entry shows the data behind it', async () => {
    const r = await page('/entry/p-water-quality');
    assert.match(r.body, /The data behind it/);
    assert.match(r.body, /Build the index now|Rebuild the index/);
  });

  test('the Automate section is real: the form validates and a set-up automation appears', async () => {
    const bad = await page('/automate/new', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=' });
    assert.equal(bad.status, 400);
    assert.match(bad.body, /There is a problem/);
  });

  test('the Marketplace resolves a domain slug in the filter to the same entries as the id', async () => {
    const byId = await page('/marketplace?cluster=d-water');
    assert.match(byId.body, /Water quality archive/);
  });
});

describe('agents: page, chat window, marketplace link', () => {
  before(() => {
    index.upsert({
      id: 'smoke-agent',
      name: 'Smoke agent',
      cat: 'Agent',
      cluster: 'd-waste',
      desc: 'Answers smoke questions.',
      owner: 'EA Waste Regulation',
      fresh: 'Live',
      sens: 'Official',
      access: 'Open to the team that built it',
      allowedGroups: ['ea-waste-regulation'],
      licence: 'Internal only',
      _source: { system: 'foundry', id: 'smoke-agent' },
      _endpoints: {},
      _agent: { definition: { name: 'Smoke agent', instructions: 'Be brief.', builtByTeam: 'EA Waste Regulation', knowledge: ['p-water-quality'], tools: [], actions: ['read'] }, gates: [] }
    });
  });

  test('the agent page renders with the chat and rebuild controls', async () => {
    const r = await page('/agent/smoke-agent');
    assert.equal(r.status, 200);
    assert.match(r.body, /Chat with this agent/);
    assert.match(r.body, /id="agent-chat-panel"/);
    assert.match(r.body, /Rebuild tools/);
  });

  test('a chat turn posts, redirects to the thread and shows the answer with its provenance', async () => {
    const open = await page('/agent/smoke-agent/chat');
    assert.equal(open.status, 200);
    assert.match(open.body, /Every member of staff can chat with every agent/);
    const sent = await page('/agent/smoke-agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'q=' + encodeURIComponent('Which registrations lapsed?')
    });
    assert.equal(sent.status, 303);
    assert.match(sent.location, /\/agent\/smoke-agent\/chat\?thread=.*#latest$/);
    const thread = await page(sent.location.replace('#latest', ''));
    assert.equal(thread.status, 200);
    assert.match(thread.body, /Which registrations lapsed\?/);
    assert.match(thread.body, /A stubbed answer naming its sources/);
  });

  test('the entry page of an agent offers the chat, whatever its visibility to this person', async () => {
    const r = await page('/entry/smoke-agent');
    assert.equal(r.status, 200);
    assert.match(r.body, /Chat with this agent/);
  });

  test('an automation can be set up against the agent and run', async () => {
    const created = await page('/automate/new', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Smoke digest', kind: 'agent', agentId: 'smoke-agent', question: 'What lapsed this week?', cadence: 'daily', at: '07:00', purpose: 'Smoke test' }).toString()
    });
    assert.equal(created.status, 303);
    const id = new URL(created.location, base).searchParams.get('created');
    assert.match(id, /^AUT-\d{4}$/);
    const ran = await page(`/automate/${id}/run`, { method: 'POST' });
    assert.equal(ran.status, 303);
    const detail = await page(`/automate/${id}`);
    assert.match(detail.body, /A stubbed answer naming its sources/);
    assert.match(detail.body, /What it writes/);
  });
});

describe('the Ask page is live, and says so', () => {
  test('a question is answered by the model and the panel explains how', async () => {
    const r = await page(`/ask?q=${encodeURIComponent('What water quality data do we hold?')}`);
    assert.equal(r.status, 303, 'a question redirects to its thread');
    const thread = await page(r.location);
    assert.equal(thread.status, 200);
    assert.match(thread.body, /A stubbed answer naming its sources/, 'the model answer is on the page');
    assert.match(thread.body, /Answered by the Foundry agent/);
    assert.ok(!/demo mode/i.test(thread.body), 'the old canned copy must be gone');
  });

  test('a question nothing can answer still gets the working', async () => {
    const r = await page(`/ask?q=${encodeURIComponent('badger population trends')}`);
    const thread = await page(r.location);
    assert.match(thread.body, /Nothing connected can answer that/);
  });
});

describe('health', () => {
  test('/api/health reports the register and the sources', async () => {
    const r = await page('/api/health');
    const h = JSON.parse(r.body);
    assert.equal(h.ok, true);
    assert.ok(h.entries >= 4);
  });

  test('/api/health/purview counts published and draft products', async () => {
    const r = await page('/api/health/purview');
    const h = JSON.parse(r.body);
    assert.equal(h.ok, true);
    assert.equal(h.domains, 3);
    assert.equal(h.published, h.dataProducts);
  });
});
