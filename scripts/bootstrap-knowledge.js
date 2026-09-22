import config from '../src/bff/config.js';
import { createSearchAdapter, indexNameFor } from '../src/bff/adapters/search.js';
import { ensureKnowledgeConnection, connectionNameFor } from '../src/bff/adapters/foundry-connections.js';
import { toAttributeMap } from '../src/bff/adapters/purview.js';
import { SAMPLE_PRODUCTS } from './sample-data.js';

export async function bootstrapKnowledge({
  products, log, counters, dryRun = false, listAllDataProducts, purviewFetch,
  search = createSearchAdapter(), connect = ensureKnowledgeConnection
}) {
  log.step('Foundry IQ - verified data assets behind each catalogue product');
  if (dryRun) {
    for (const product of products) log.skip(`${product.name}: index -> knowledge source/base -> Foundry MCP connection -> catalogue metadata`);
    return { connected: 0 };
  }
  const registered = await listAllDataProducts();
  let connected = 0;
  for (const product of products) {
    try {
      const actual = registered.find((item) => item.name === product.name || toAttributeMap(item.managedAttributes).cortexDataFolder === product.id);
      if (!actual) throw new Error('The catalogue product has not been registered.');
      const indexName = indexNameFor(product.id);
      const stats = await search.indexStats(indexName);
      const expected = SAMPLE_PRODUCTS[product.id]?.rows;
      if (!expected || stats?.documents !== expected) throw new Error(`Index has ${stats?.documents ?? 0} documents; expected exactly ${expected}. Complete ingestion or remove stale demo rows before publication.`);
      const kb = await search.ensureKnowledgeBase({ name: `cx-kb-${product.id}`, indexName, description: `${product.name}. Synthetic demonstration data only.` });
      const connection = await connect({ name: connectionNameFor(kb.name, 'cx-iq-'), target: kb.mcp });
      const path = `/datagovernance/catalog/dataProducts/${actual.id}`;
      const latest = await purviewFetch(path);
      const values = {
        ...toAttributeMap(latest.managedAttributes),
        cortexKnowledgeBase: kb.name, cortexKnowledgeSource: kb.sourceName,
        cortexKnowledgeMcp: kb.mcp, cortexKnowledgeConnection: connection.id,
        cortexKnowledgeReasoning: kb.reasoning, cortexIndexedRows: String(stats.documents)
      };
      await purviewFetch(path, { method: 'PUT', body: {
        ...latest, managedAttributes: Object.entries(values).map(([name, value]) => ({ name, value: String(value) }))
      } });
      connected++; counters.updated++;
      log.ok(`${product.name}: ${stats.documents} indexed rows, knowledge base ${kb.name}, catalogue linked`);
    } catch (error) {
      counters.failed++;
      log.fail(`${product.name}: ${error.message}`);
    }
  }
  return { connected };
}
