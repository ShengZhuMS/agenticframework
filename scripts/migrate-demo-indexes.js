import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import config from '../src/bff/config.js';
import { getToken } from '../src/bff/adapters/token.js';
import { createSearchAdapter } from '../src/bff/adapters/search.js';

const legacy = [
  'water-quality-archive', 'hydrology-flow-level', 'bathing-water-results', 'catchment-land-cover',
  'rural-land-parcels', 'livestock-movements', 'waste-carrier-registrations', 'national-forest-inventory',
  'marine-catch-returns', 'flood-risk-model-outputs', 'ammonia-emissions-grid', 'servicenow-incidents'
];

async function agentPages(path) {
  const values = [];
  let after;
  do {
    const url = new URL(config.foundry.projectEndpoint + path);
    url.searchParams.set('api-version', 'v1');
    if (after) url.searchParams.set('after', after);
    const response = await fetch(url, { headers: { Authorization: ['Bearer', await getToken(config.foundry.scope)].join(' ') }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Cannot prove index references: Foundry listing failed ${response.status}. No deletion permitted.`);
    const body = await response.json();
    const page = body.data || body.value;
    if (!Array.isArray(page)) throw new Error('Unexpected Foundry listing shape. No deletion permitted.');
    values.push(...page);
    if (!body.has_more) break;
    const next = body.last_id || page.at(-1)?.id;
    if (!next || next === after) throw new Error('Invalid Foundry listing cursor.');
    after = next;
  } while (after);
  return values;
}

export async function migrate({ apply = false } = {}) {
  if (!config.foundry.projectEndpoint || !config.search.endpoint) throw new Error('Load the deployed application configuration first.');
  const search = createSearchAdapter();
  const current = JSON.parse(readFileSync(new URL('../bootstrap/data-products.json', import.meta.url), 'utf8'));
  const keep = new Set(current.map((p) => `${config.search.indexPrefix}${p.id}`));
  const have = await search.listIndexes();
  const candidates = legacy.map((id) => `${config.search.indexPrefix}${id}`).filter((id) => have.includes(id) && !keep.has(id));
  const references = [];
  for (const agent of await agentPages('/agents')) {
    for (const version of await agentPages(`/agents/${encodeURIComponent(agent.name)}/versions`)) {
      const definition = JSON.stringify(version);
      for (const name of candidates) if (definition.includes(name)) references.push({ index: name, agent: agent.name, version: version.version });
    }
  }
  const deletable = candidates.filter((name) => !references.some((r) => r.index === name));
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', search: config.search.endpoint, protectedAgentReferences: references, legacyIndexes: deletable, preservedCurrentIndexes: [...keep], note: 'Only the historical demo allowlist is eligible. Catalogue products, files, agents and unknown indexes are preserved.' }, null, 2));
  if (apply) {
    for (const name of deletable) {
      await search.deleteIndexer(`${name}-indexer`);
      await search.deleteDataSource(`${name}-source`);
      await search.deleteIndex(name);
      if (await search.getIndex(name)) throw new Error(`Deletion not yet confirmed for ${name}; stop before bootstrap.`);
      console.log(`Removed unused historical demo index: ${name}`);
    }
  }
  return { deletable, references };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  migrate({ apply: process.argv.includes('--apply') }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
