/**
 * Grounding — from a data product to the data behind it.
 *
 * A data product in the Unified Catalog is a description. Underneath it, in
 * the Data Map, sit the DATA ASSETS the scan found: real files with a schema.
 * Underneath those, in Azure AI Search, sits an index Cortex built from the
 * same files. This service walks that chain so that:
 *
 *   - the entry page can show the assets attached to a product, their columns
 *     and classifications, and whether an index exists for them;
 *   - an agent built on the product gets an azure_ai_search tool pointing at
 *     that index, and instructions that name the columns it can query;
 *   - "Build the index now" on the entry page can create or refresh the index
 *     without a redeploy.
 *
 * Nothing here copies data into Cortex. The index lives in AI Search, is
 * built by an indexer reading the storage account directly, and is read by
 * the Foundry agent through a project connection. Cortex only orchestrates.
 */

import config from '../config.js';
import index, { slug } from '../index/store.js';
import { indexNameFor, indexDefinitionFor } from '../adapters/search.js';
import { connectionArmId, ensureSearchConnection, connectionsConfigured } from '../adapters/foundry-connections.js';

const ASSET_TTL_MS = 5 * 60_000;
const assetMemo = new Map();

/** Grounding is on when a search endpoint is configured; everything degrades cleanly without it. */
export function groundingConfigured() {
  return Boolean(index.search?.configured?.());
}

/** The folder in the sample-data container that holds this product's files. */
export function dataFolderFor(entry) {
  return entry.dataFolder || slug(entry.name);
}

/** The AI Search index name for a data product. */
export function indexFor(entry) {
  return entry.searchIndex || indexNameFor(dataFolderFor(entry));
}

/**
 * The Unified Catalog assets attached to a data product, with their schema.
 * Memoised for five minutes: the catalogue allows 100 list calls per 20s and
 * an entry page should not spend two of them on every load.
 */
export async function assetsFor(entry, { purview = index.purview, force = false } = {}) {
  if (!entry || entry.cat !== 'Data' || entry._source?.system !== 'purview') return [];
  const hit = assetMemo.get(entry.id);
  if (hit && !force && Date.now() - hit.at < ASSET_TTL_MS) return hit.assets;
  let assets = [];
  try {
    assets = await purview.getAssets(entry.id);
  } catch (err) {
    assets = hit?.assets || [];
    assets.error = err.message;
  }
  assetMemo.set(entry.id, { at: Date.now(), assets });
  return assets;
}

export function forgetAssets(entryId) {
  if (entryId) assetMemo.delete(entryId);
  else assetMemo.clear();
}

/**
 * Everything the entry page shows about grounding, in one call.
 * Never throws — each part reports its own failure.
 */
export async function groundingStatus(entry, { search = index.search, purview = index.purview } = {}) {
  const out = {
    configured: groundingConfigured(),
    folder: dataFolderFor(entry),
    index: indexFor(entry),
    exists: false,
    documents: 0,
    indexer: null,
    assets: [],
    errors: []
  };
  out.assets = await assetsFor(entry, { purview });
  if (out.assets.error) out.errors.push(`Purview: ${out.assets.error}`);
  if (!out.configured) return out;
  try {
    const stats = await search.indexStats(out.index);
    if (stats) {
      out.exists = true;
      out.documents = stats.documents;
    }
  } catch (err) {
    out.errors.push(`AI Search: ${err.message}`);
  }
  try {
    out.indexer = await search.indexerStatus(`${out.index}-indexer`);
  } catch (err) {
    out.errors.push(`AI Search indexer: ${err.message}`);
  }
  return out;
}

/**
 * Column names for a product's index: from the Data Map schema when the scan
 * has produced one, otherwise from the CSV header in storage.
 */
export async function columnsFor(entry, { assets, storage = index.storage } = {}) {
  const fromSchema = (assets || []).flatMap((a) => (a.schema || []).map((c) => c.name)).filter(Boolean);
  if (fromSchema.length) return [...new Set(fromSchema)];
  if (!storage?.configured?.()) return [];
  const folder = dataFolderFor(entry);
  const files = await storage.list(config.data.container, `${folder}/`);
  const csv = files.find((f) => /\.csv$/i.test(f.name));
  if (!csv) return [];
  const head = await storage.head(config.data.container, csv.name, 8192);
  return parseCsvHeader(head);
}

/** The first line of a CSV, split into column names. Handles quoted headers. */
export function parseCsvHeader(text) {
  const line = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '';
  return splitCsvLine(line).map((c) => c.trim()).filter(Boolean);
}

/** One CSV line into cells, quotes honoured, empties kept. */
export function splitCsvLine(line) {
  const cols = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      cols.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cols.push(cur);
  return cols;
}

/**
 * Build (or refresh) the index for a data product: index definition, data
 * source over the product's folder, indexer with CSV parsing, and a run.
 * Idempotent — every step is a PUT on a fixed name.
 *
 * @returns {{ index, dataSource, indexer, columns, run }}
 */
export async function buildIndex(entry, { search = index.search, storage = index.storage, purview = index.purview, columns, semantic = /semantic/.test(config.search.queryType) } = {}) {
  if (!groundingConfigured()) throw new Error('Azure AI Search is not configured, so no index can be built.');
  if (!config.data.storageAccount) throw new Error('The sample-data storage account is not configured (DATA_STORAGE_ACCOUNT).');
  const folder = dataFolderFor(entry);
  const name = indexFor(entry);
  const assets = await assetsFor(entry, { purview });
  const cols = columns?.length ? columns : await columnsFor(entry, { assets, storage });
  if (!cols.length) {
    throw new Error(`No columns could be found for ${entry.name}: no schema on its Data Map assets and no CSV under ${folder}/ in storage.`);
  }
  await search.ensureIndex(indexDefinitionFor(name, cols, { semantic }));
  const dataSource = `${name}-source`;
  const storageAccountId =
    `/subscriptions/${config.apim.subscriptionId}/resourceGroups/${config.data.resourceGroup}` +
    `/providers/Microsoft.Storage/storageAccounts/${config.data.storageAccount}`;
  await search.ensureDataSource({ name: dataSource, storageAccountId, container: config.data.container, folder });
  const indexer = `${name}-indexer`;
  await search.ensureIndexer({ name: indexer, dataSourceName: dataSource, targetIndexName: name });
  const run = await search.runIndexer(indexer);
  return { index: name, dataSource, indexer, columns: cols, run };
}

/**
 * The azure_ai_search tools for the data products an agent reads — one per
 * product that has an index. Products without one are reported so the
 * builder sees which knowledge is described-only.
 */
export async function searchToolsFor(knowledge, { search = index.search } = {}) {
  const tools = [];
  const grounded = [];
  const describedOnly = [];
  if (!groundingConfigured() || !connectionsConfigured()) {
    return { tools, grounded, describedOnly: knowledge.filter((e) => e.cat === 'Data').map((e) => e.name), connectionId: null };
  }
  let connectionId = connectionArmId(config.foundry.searchConnection);
  try {
    await ensureSearchConnection();
  } catch (err) {
    // The tool can still be defined against the connection id; Foundry will
    // say clearly if the connection is missing when the agent runs.
    console.warn(`[grounding] search connection: ${err.message}`);
  }
  for (const e of knowledge) {
    if (e.cat !== 'Data' || e._source?.system !== 'purview') continue;
    const name = indexFor(e);
    let stats = null;
    try {
      stats = await search.indexStats(name);
    } catch {
      stats = null;
    }
    if (!stats) {
      describedOnly.push(e.name);
      continue;
    }
    grounded.push({ entry: e.name, index: name, documents: stats.documents });
    tools.push({
      type: 'azure_ai_search',
      azure_ai_search: {
        indexes: [
          {
            project_connection_id: connectionId,
            index_name: name,
            query_type: config.search.queryType,
            top_k: config.search.topK
          }
        ]
      }
    });
  }
  return { tools, grounded, describedOnly, connectionId };
}

/**
 * The paragraph appended to an agent's instructions describing the data it
 * can actually query — assets, columns and the index — so the model knows
 * to search rather than guess.
 */
export function describeGrounding(entry, assets, indexName, columns = []) {
  const lines = [`Data product: ${entry.name}.`];
  if (assets?.length) {
    for (const a of assets.slice(0, 5)) {
      const cols = (a.schema || []).map((c) => c.name).filter(Boolean);
      lines.push(`  Asset: ${a.name}${a.fqn ? ` (${a.fqn})` : ''}${cols.length ? ` — columns: ${cols.slice(0, 30).join(', ')}` : ''}`);
      if (a.classifications?.length) lines.push(`    Classifications: ${a.classifications.join(', ')}`);
    }
  } else if (columns.length) {
    lines.push(`  Columns: ${columns.slice(0, 30).join(', ')}`);
  }
  if (indexName) {
    lines.push(`  Search index: ${indexName}. Use the search tool to look rows up before answering; quote the values you found and say how many rows matched.`);
  } else {
    lines.push('  No search index is attached. You can describe this product but you cannot read its rows; say so if asked for figures.');
  }
  return lines.join('\n');
}
