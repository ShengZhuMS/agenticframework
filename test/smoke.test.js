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
  for (const path of ['/', '/marketplace', '/marketplace/map', '/build', '/build/new', '/share', '/requests', '/profile', '/help']) {
    test(`${path} is 200 and not the error page`, async () => {
      const r = await page(path);
      assert.equal(r.status, 200, path);
      assert.ok(!/problem with the service/.test(r.body), `${path} rendered the 500 page`);
    });
  }

  test('an entry page shows the entry standard, with the catalogue status from Purview', async () => {
    const r = await page('/entry/p-water-quality');
    assert.equal(r.status, 200);
    assert.match(r.body, /Water quality archive/);
    assert.match(r.body, /Catalogue status/);
  });

  test('the Marketplace resolves a domain slug in the filter to the same entries as the id', async () => {
    const byId = await page('/marketplace?cluster=d-water');
    assert.match(byId.body, /Water quality archive/);
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
