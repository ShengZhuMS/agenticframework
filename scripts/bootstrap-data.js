/**
 * Bootstrap — the data behind the data products, and the wiring that lets an
 * agent reach it. Called from bootstrap.js; each function is one `--only=`
 * section and is safe to re-run.
 *
 *   connections  a Foundry project connection per API Management MCP server,
 *                carrying the gateway key (fixes the agent → tool 401)
 *   data         synthetic sample files → storage → Data Map source + scan →
 *                Unified Catalog assets attached to each data product
 *   link         just the last part of `data` — for when the scan was still
 *                running the first time
 *   search       Foundry → AI Search connection, then one index, data source
 *                and indexer per data product, built from the same files
 *
 * Everything reads configuration the way the app does (config.js), so
 * `. .\scripts\Set-CortexEnv.ps1` is enough to run any of these by hand.
 */

import config from '../src/bff/config.js';
import { createStorageAdapter } from '../src/bff/adapters/storage.js';
import { createDataMapAdapter, adlsQualifiedName, COLLECTION_ROLES } from '../src/bff/adapters/datamap.js';
import { createSearchAdapter, indexNameFor, indexDefinitionFor } from '../src/bff/adapters/search.js';
import { createPurviewAdapter } from '../src/bff/adapters/purview.js';
import { ensureMcpConnection, ensureSearchConnection, connectionsConfigured, connectionNameFor } from '../src/bff/adapters/foundry-connections.js';
import { createApimAdapter } from '../src/bff/adapters/apim.js';
import { generateProduct, SAMPLE_PRODUCTS } from './sample-data.js';

export const DATA_SOURCE_NAME = process.env.PURVIEW_DATA_SOURCE || 'cortex-sample-data';
export const SCAN_NAME = process.env.PURVIEW_SCAN_NAME || 'cortex-sample-scan';

/** What each section needs before it can do anything useful. */
export function missingFor(section) {
  const need = [];
  const f = config.foundry;
  const projectKnown = Boolean(config.apim.subscriptionId && f.accountName && f.projectName && f.resourceGroup);
  if (section === 'connections') {
    if (!projectKnown) need.push('FOUNDRY_ACCOUNT_NAME, FOUNDRY_PROJECT_NAME, FOUNDRY_RESOURCE_GROUP (Foundry project location in ARM)');
    if (!config.apim.subscriptionKey) need.push('APIM_SUBSCRIPTION_KEY');
    if (!config.apim.serviceName) need.push('APIM_SERVICE_NAME');
  }
  if (section === 'data' || section === 'link') {
    if (!config.data.storageAccount) need.push('DATA_STORAGE_ACCOUNT');
    if (!config.purview.accountName && !config.purview.dataMapEndpoint) need.push('PURVIEW_ACCOUNT_NAME');
  }
  if (section === 'data') {
    if (!config.data.resourceGroup) need.push('DATA_RESOURCE_GROUP (or CORTEX_RESOURCE_GROUP)');
  }
  if (section === 'search') {
    if (!config.search.endpoint && !config.search.serviceName) need.push('SEARCH_ENDPOINT');
    if (!config.data.storageAccount) need.push('DATA_STORAGE_ACCOUNT');
    if (!config.data.resourceGroup) need.push('DATA_RESOURCE_GROUP (or CORTEX_RESOURCE_GROUP)');
    if (!projectKnown) need.push('FOUNDRY_ACCOUNT_NAME, FOUNDRY_PROJECT_NAME, FOUNDRY_RESOURCE_GROUP');
  }
  return need;
}

/* ------------------------------------------------------------ connections */

/**
 * One RemoteTool connection per MCP server in API Management. The list comes
 * from API Management itself, so agents published from Cortex are covered as
 * well as the bootstrap skills.
 */
export async function bootstrapConnections({ log, counters, dryRun = false, apim = createApimAdapter() }) {
  log.step('Foundry connections to API Management MCP servers');
  const missing = missingFor('connections');
  if (missing.length) {
    log.skip(`not configured — ${missing.join('; ')}`);
    return { created: 0, kept: 0 };
  }
  if (dryRun) {
    log.skip(`would create one RemoteTool connection per MCP server in ${config.apim.serviceName}, e.g. cx-demo-inventory-lookup-mcp → ${connectionNameFor('cx-demo-inventory-lookup-mcp')}`);
    return { created: 0, kept: 0 };
  }
  let servers = [];
  try {
    servers = await apim.listMcpServers();
  } catch (err) {
    log.fail(`could not list MCP servers — ${err.message}`);
    counters.failed++;
    return { created: 0, kept: 0 };
  }
  if (!servers.length) {
    log.skip('no MCP servers in API Management yet — run --only=apim first');
    return { created: 0, kept: 0 };
  }
  let created = 0;
  let kept = 0;
  for (const s of servers) {
    const name = connectionNameFor(s.id);
    if (dryRun) {
      log.skip(`${s.id} → ${name} (${s.url})`);
      continue;
    }
    try {
      const c = await ensureMcpConnection({ apiId: s.id, target: s.url, name });
      if (c.created) {
        created++;
        counters.created++;
        log.ok(`${s.id} → ${c.name} (created)`);
      } else {
        kept++;
        log.ok(`${s.id} → ${c.name} (already there)`);
      }
    } catch (err) {
      counters.failed++;
      log.fail(`${s.id} — ${err.message}`);
    }
  }
  return { created, kept };
}

/* ------------------------------------------------------------------ data */

function productGuid(p, existing, guidFor) {
  const id = guidFor(`product:${p.id}`);
  const hit = existing.find((x) => x.id === id || x.name === p.name);
  return hit?.id || null;
}

/**
 * Sample files in, Data Map scan through, assets attached out.
 */
export async function bootstrapData({
  products,
  log,
  counters,
  dryRun = false,
  wait = true,
  principal = '',
  signedInObjectId,
  guidFor,
  listAllDataProducts,
  storage = createStorageAdapter(),
  datamap = createDataMapAdapter(),
  purview = createPurviewAdapter()
}) {
  log.step('Sample data → storage → Data Map → data products');
  const missing = missingFor('data');
  if (missing.length) {
    log.skip(`not configured — ${missing.join('; ')}`);
    return { uploaded: 0, linked: 0 };
  }
  const container = config.data.container;
  const known = products.filter((p) => SAMPLE_PRODUCTS[p.id]);
  const unknown = products.filter((p) => !SAMPLE_PRODUCTS[p.id]).map((p) => p.id);
  if (unknown.length) log.warn(`no sample generator for: ${unknown.join(', ')} — they will have no data behind them`);

  // 1. collection roles for whoever is running this, and for the Cortex identity
  if (!dryRun) {
    try {
      const me = await signedInObjectId();
      const principals = [me, principal].filter(Boolean);
      const r = await datamap.ensureCollectionRoles({
        principalIds: principals,
        roles: [COLLECTION_ROLES.dataSourceAdmin, COLLECTION_ROLES.dataCurator, COLLECTION_ROLES.dataReader]
      });
      log.ok(`Data Map roles on collection "${datamap.collection}": ${r.changed ? 'granted' : 'already held'} (Data Source Administrator, Data Curator, Data Reader)`);
    } catch (err) {
      log.warn(`could not grant Data Map collection roles — ${err.message}`);
      log.warn('if registration below is refused, grant yourself Data Source Administrator + Data Curator on the root collection in the Purview portal (Data Map → Domains and collections → Role assignments)');
    }
  }

  // 2. the files
  let uploaded = 0;
  if (dryRun) {
    for (const p of known) {
      const g = generateProduct(p.id, p);
      log.skip(`${p.id}/${p.id}.csv — ${g.rowCount} rows, ${g.columns.length} columns, ${(g.bytes / 1024).toFixed(0)} KB (+ README.md)`);
    }
  } else {
    try {
      const c = await storage.ensureContainer(container);
      log.ok(`container ${container} ${c.created ? 'created' : 'exists'} in ${config.data.storageAccount}`);
    } catch (err) {
      counters.failed++;
      log.fail(`storage — ${err.message}`);
      if (err.blocked) {
        log.warn('nothing else against this account can work until its network rules are repaired — the scan and the indexes are skipped this run');
      }
      return { uploaded: 0, linked: 0, blocked: true, reason: err.message };
    }
    for (const p of known) {
      try {
        const g = generateProduct(p.id, p);
        await storage.upload(container, `${p.id}/${p.id}.csv`, g.csv, 'text/csv; charset=utf-8');
        await storage.upload(container, `${p.id}/README.md`, g.readme, 'text/markdown; charset=utf-8');
        uploaded++;
        log.ok(`${p.id}/${p.id}.csv — ${g.rowCount} rows uploaded (+ README.md)`);
      } catch (err) {
        counters.failed++;
        log.fail(`${p.id} — ${err.message}`);
        // The network code will not change between products. One failure is
        // the diagnosis; thirteen more are noise.
        if (err.blocked) {
          log.warn(`stopping — ${config.data.storageAccount} refuses this machine, so every remaining upload would fail the same way`);
          return { uploaded, linked: 0, blocked: true, reason: err.message };
        }
      }
    }
    if (known.length && uploaded === 0) {
      log.warn('no sample file reached storage, so there is nothing for the Data Map to scan or AI Search to index this run');
      return { uploaded: 0, linked: 0, blocked: true, reason: 'no sample file was uploaded' };
    }
  }

  // 3. register the source and scan it
  if (dryRun) {
    log.skip(`Data Map source ${DATA_SOURCE_NAME} (AdlsGen2) + scan ${SCAN_NAME} (AdlsGen2Msi, system ruleset) in collection ${datamap.collection}`);
    return { uploaded: 0, linked: 0 };
  }
  let scanRun = null;
  try {
    const src = await datamap.ensureAdlsSource({
      name: DATA_SOURCE_NAME,
      storageAccount: config.data.storageAccount,
      resourceGroup: config.data.resourceGroup,
      subscriptionId: config.apim.subscriptionId,
      location: process.env.DATA_STORAGE_LOCATION || process.env.AZURE_LOCATION || 'northeurope'
    });
    log.ok(`Data Map source ${DATA_SOURCE_NAME} ${src.created ? 'registered' : 'already registered'}`);
    const scan = await datamap.ensureAdlsScan({ dataSourceName: DATA_SOURCE_NAME, scanName: SCAN_NAME });
    log.ok(`scan ${SCAN_NAME} ${scan.created ? 'created' : 'exists'} (runs as the Purview account identity)`);
    scanRun = await datamap.runScan(DATA_SOURCE_NAME, SCAN_NAME);
    counters.created++;
    log.ok(`scan run ${scanRun.runId} started (${scanRun.status})`);
  } catch (err) {
    counters.failed++;
    log.fail(`Data Map — ${err.message}`);
    log.warn('The uploaded files are preserved. Repair the reported API/access error and rerun the data section; source registration and scanning are automated.');
    return { uploaded, linked: 0 };
  }

  if (!wait) {
    log.warn('not waiting for the scan (--no-wait). When it has finished (Purview portal → Data Map → Sources), run: node scripts/bootstrap.js --only=link');
    return { uploaded, linked: 0 };
  }

  log.ok('waiting for the scan — a few small files usually take 3 to 10 minutes, most of it queueing');
  const result = await datamap.waitForScan(DATA_SOURCE_NAME, SCAN_NAME, scanRun.runId, {
    onTick: (status, run) => console.log(`          scan ${status}${run?.discovered != null ? ` — ${run.discovered} assets discovered` : ''}`)
  });
  if (!result.done) {
    log.warn(`the scan is still ${result.status} after the wait budget. Run --only=link once it has finished.`);
    return { uploaded, linked: 0 };
  }
  if (!/Succeeded|Completed/i.test(result.status)) {
    counters.failed++;
    log.fail(`scan ${result.status}${result.run?.error ? ` — ${result.run.error}` : ''}`);
    log.warn('common cause: the Purview account identity lacks Storage Blob Data Reader on the storage account (infra/modules/data.bicep grants it; re-provision)');
    return { uploaded, linked: 0 };
  }
  log.ok(`scan ${result.status}${result.run?.discovered != null ? ` — ${result.run.discovered} assets discovered` : ''}`);

  const linked = await linkAssets({ products: known, log, counters, signedInObjectId, guidFor, listAllDataProducts, datamap, purview });
  return { uploaded, linked };
}

/**
 * Attach the scanned file behind each product to the product itself:
 * Data Map asset → Unified Catalog data asset → relationship on the product.
 */
export async function linkAssets({
  products,
  log,
  counters,
  signedInObjectId,
  guidFor,
  listAllDataProducts,
  datamap = createDataMapAdapter(),
  purview = createPurviewAdapter()
}) {
  log.step('Attaching Data Map assets to the data products');
  const missing = missingFor('link');
  if (missing.length) {
    log.skip(`not configured — ${missing.join('; ')}`);
    return 0;
  }
  let existing = [];
  try {
    existing = await listAllDataProducts();
  } catch (err) {
    log.fail(`could not list data products — ${err.message}`);
    counters.failed++;
    return 0;
  }
  let me = null;
  try {
    me = await signedInObjectId();
  } catch {
    me = null;
  }
  const account = config.data.storageAccount;
  const container = config.data.container;
  let linked = 0;
  let pending = 0;
  for (const p of products.filter((x) => SAMPLE_PRODUCTS[x.id])) {
    const productId = productGuid(p, existing, guidFor);
    if (!productId) {
      log.warn(`${p.name} — not in the catalogue yet (run --only=purview first)`);
      continue;
    }
    const fqn = adlsQualifiedName(account, container, `${p.id}/${p.id}.csv`);
    try {
      let asset = await datamap.getAssetByQualifiedName(fqn);
      if (!asset) {
        // Some scans record the file under a resource-set or a slightly
        // different casing; a keyword search under the folder prefix catches it.
        const found = await datamap.searchAssets({ keywords: `${p.id}.csv`, prefix: adlsQualifiedName(account, container, `${p.id}/`) });
        asset = found.find((a) => /\.csv$/i.test(a.qualifiedName || '')) || found[0] || null;
      }
      if (!asset) {
        pending++;
        log.warn(`${p.name} — the Data Map has no asset for ${fqn} yet (scan not finished or failed)`);
        continue;
      }
      const reg = await purview.registerDataAsset({
        dataMapAssetId: asset.id,
        name: asset.name || `${p.id}.csv`,
        qualifiedName: asset.qualifiedName,
        assetType: asset.type,
        columns: asset.columns || [],
        ownerId: me,
        ownerName: p.owner || 'Cortex bootstrap',
        openInUrl: `https://purview.microsoft.com/datacatalog/governance/main/catalog/dataasset/${asset.id}`
      });
      const link = await purview.linkAsset(productId, reg.asset.id, `Sample file scanned from ${fqn}`);
      if (link.linked) {
        linked++;
        counters.created++;
        log.ok(`${p.name} ← ${asset.name} (${reg.created ? 'registered and ' : ''}attached)`);
      } else {
        log.ok(`${p.name} ← ${asset.name} (already attached)`);
      }
    } catch (err) {
      counters.failed++;
      log.fail(`${p.name} — ${err.message}`);
    }
  }
  if (pending) log.warn(`${pending} product(s) have no asset yet — re-run: node scripts/bootstrap.js --only=link`);
  return linked;
}

/* ---------------------------------------------------------------- search */

/**
 * One AI Search index per product, over the product's folder, plus the
 * Foundry connection that lets an agent read it.
 */
export async function bootstrapSearch({
  products,
  log,
  counters,
  dryRun = false,
  verify = true,
  verifySeconds = 90,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  search = createSearchAdapter()
}) {
  log.step('Azure AI Search — one index per data product');
  const missing = missingFor('search');
  if (missing.length) {
    log.skip(`not configured — ${missing.join('; ')}`);
    return { built: 0 };
  }
  const known = products.filter((p) => SAMPLE_PRODUCTS[p.id]);
  if (dryRun) {
    for (const p of known) {
      const g = generateProduct(p.id, p, { rows: 1 });
      log.skip(`${indexNameFor(p.id)} — ${g.columns.length} columns, source ${config.data.container}/${p.id}/, indexer CSV`);
    }
    return { built: 0 };
  }

  try {
    const c = await ensureSearchConnection();
    log.ok(`Foundry connection ${c.name} → ${config.search.endpoint || config.search.serviceName} (${c.created ? 'created' : 'already there'}, keyless)`);
  } catch (err) {
    counters.failed++;
    log.fail(`Foundry → AI Search connection — ${err.message}`);
  }

  // Preflight the whole pack before partially creating it or starting indexers.
  try {
    const have = await search.listIndexes();
    const ours = new Set(have.filter((n) => n.startsWith(config.search.indexPrefix)));
    const wanted = known.map((p) => indexNameFor(p.id));
    const newOnes = wanted.filter((n) => !ours.has(n)).length;
    const capacity = search.capacity ? await search.capacity() : { limit: 15 };
    if (!Number.isFinite(capacity.limit)) throw new Error('Search did not report its index quota.');
    if (have.length + newOnes > capacity.limit) {
      throw new Error(`${have.length} indexes exist and ${newOnes} more are needed, but the service quota is ${capacity.limit}. Run the reviewed legacy-index migration or approve a capacity upgrade. No indexes were changed.`);
    }
  } catch (err) {
    counters.failed++;
    log.fail(`Search capacity preflight: ${err.message}`);
    return { built: 0, indexed: 0, failed: 1 };
  }

  const storageAccountId =
    `/subscriptions/${config.apim.subscriptionId}/resourceGroups/${config.data.resourceGroup}` +
    `/providers/Microsoft.Storage/storageAccounts/${config.data.storageAccount}`;
  const semantic = /semantic/.test(config.search.queryType);
  let built = 0;
  const started = [];
  for (const p of known) {
    const name = indexNameFor(p.id);
    try {
      const g = generateProduct(p.id, p, { rows: 1 });
      await search.ensureIndex(indexDefinitionFor(name, g.columns.map((c) => c.name), { semantic }));
      await search.ensureDataSource({ name: `${name}-source`, storageAccountId, container: config.data.container, folder: p.id });
      await search.ensureIndexer({ name: `${name}-indexer`, dataSourceName: `${name}-source`, targetIndexName: name });
      const run = await search.runIndexer(`${name}-indexer`);
      built++;
      counters.created++;
      started.push(name);
      log.ok(`${name} — ${g.columns.length} columns; indexer ${run.started ? 'started' : run.reason}`);
    } catch (err) {
      counters.failed++;
      log.fail(`${name} — ${err.message}`);
    }
  }
  if (!built) return { built, indexed: 0, failed: 0 };
  if (!verify) {
    log.ok('indexers run in the background (not waiting — --no-wait). Check them with --only=search later. Agents pick indexes up on "Rebuild tools".');
    return { built, indexed: 0, failed: 0, verified: false };
  }

  // "Rows appear within a minute or two" used to be the last word, and on the
  // first live run every indexer failed silently because the storage account
  // refused the search service. So wait for each indexer's first run and
  // report what it did — rows in, or the error — instead of hoping.
  const outcome = await verifyIndexers({ names: started, search, log, sleep, verifySeconds });
  if (outcome.indexed) log.ok(`${outcome.indexed} of ${built} indexes hold rows. Agents pick indexes up on "Rebuild tools".`);
  if (outcome.failed) {
    counters.failed += outcome.failed;
    if (outcome.networkBlocked) {
      log.fail(`${outcome.failed} indexer(s) were refused by ${config.data.storageAccount} — its network rules block the search service. Repair with .\\scripts\\Set-CortexStorageAccess.ps1, then run --only=search again.`);
    } else {
      log.fail(`${outcome.failed} indexer(s) failed — see the errors above, fix the cause and run --only=search again`);
    }
  }
  if (outcome.pending) log.warn(`${outcome.pending} indexer(s) had not finished after ${verifySeconds}s — check later with --only=search`);
  return { built, indexed: outcome.indexed, failed: outcome.failed, pending: outcome.pending, verified: true };
}

/**
 * Poll each indexer until its most recent run has a terminal status, or the
 * budget runs out. Exported for tests; the search adapter is injected.
 */
export async function verifyIndexers({ names, search, log, sleep, verifySeconds = 90, intervalMs = 10_000 }) {
  const remaining = new Set(names);
  const result = { indexed: 0, failed: 0, pending: 0, networkBlocked: false };
  const deadline = Date.now() + verifySeconds * 1000;
  const terminal = /^(success|transientFailure|persistentFailure|reset)$/i;
  while (remaining.size && Date.now() < deadline) {
    for (const name of [...remaining]) {
      let s = null;
      try {
        s = await search.indexerStatus(`${name}-indexer`);
      } catch (err) {
        log.warn(`${name} — could not read the indexer status: ${err.message}`);
        remaining.delete(name);
        result.pending++;
        continue;
      }
      const last = s?.lastRun;
      if (!last || !terminal.test(String(last.status || ''))) continue;
      remaining.delete(name);
      const errors = last.errors || [];
      if (/^success$/i.test(last.status) && !last.failed) {
        const stats = search.indexStats ? await search.indexStats(name) : { documents: last.processed };
        if (stats?.documents > 0) {
          result.indexed++;
          log.ok(`${name} — ${stats.documents} rows indexed`);
        } else {
          // Search statistics lag a successful indexer. Wait before declaring an empty index.
          remaining.add(name);
        }
      } else {
        result.failed++;
        const first = errors[0] || `status ${last.status}`;
        if (/not authorized to perform this operation|AuthorizationFailure|403/i.test(first)) result.networkBlocked = true;
        log.fail(`${name} — ${first}`);
      }
    }
    if (remaining.size) await sleep(intervalMs);
  }
  for (const name of remaining) {
    const stats = search.indexStats ? await search.indexStats(name) : null;
    if (stats?.documents === 0) {
      result.failed++;
      log.fail(`${name} — no indexed rows appeared before the verification deadline; check source folder and file parsing.`);
    } else {
      result.pending++;
    }
  }
  return result;
}

/** True when API Management knows a connection name — used by tests. */
export { connectionNameFor, connectionsConfigured };
