import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stubAzure } from './fixtures.js';
import config from '../src/bff/config.js';
import index from '../src/bff/index/store.js';

export async function browserFixture() {
  const restore = stubAzure();
  const directory = await mkdtemp(path.join(tmpdir(), 'cortex-browser-'));
  process.env.CORTEX_THEME = 'microsoft';
  config.port = 0;
  config.entra.allowUnauthenticated = true;
  config.entra.localUser = 'Browser regression fixture';
  config.entra.localGroups = ['all-staff', 'cortex-redteam'];
  config.index.refreshMinutes = 0;
  config.state.dir = directory;
  config.state.blobAccount = '';
  config.automations.enabled = false;
  const { start } = await import('../src/bff/server.js');
  const server = await start({ host: '127.0.0.1' });
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  index.upsert({ id: 'browser-agent', name: 'Demo review agent', cat: 'Agent', allowedGroups: ['all-staff'], owner: 'Local development',
    _source: { id: 'browser-agent', system: 'foundry' },
    _agent: { version: '1', definition: { builtById: 'local-dev', instructions: 'Summarise synthetic data and cite sources.', knowledge: [], tools: [], actions: ['read', 'summarise'], model: config.foundry.model } }
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      restore();
      await rm(directory, { recursive: true, force: true });
    }
  };
}
