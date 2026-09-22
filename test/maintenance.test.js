import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubAzure } from './fixtures.js';
import config from '../src/bff/config.js';
import { start } from '../src/bff/server.js';

test('maintenance keeps readiness up while refusing every user and machine write route', async () => {
  const restore = stubAzure();
  config.maintenance = true;
  config.port = 0;
  config.state.dir = '';
  config.state.blobAccount = '';
  config.entra.allowUnauthenticated = true;
  const server = await start({ host: '127.0.0.1' });
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/api/health')).status, 200);
    for (const route of ['/', '/ask', '/build/create', '/share/publish', '/api/index/refresh', '/shim/agents/demo/invoke']) {
      const response = await fetch(base + route, { method: 'POST', body: 'q=demo' });
      assert.equal(response.status, 503, route);
      assert.equal(response.headers.get('retry-after'), '120');
    }
    assert.equal(config.index.refreshMinutes, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    config.maintenance = false;
    restore();
  }
});
