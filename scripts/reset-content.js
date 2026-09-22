import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config, { hydrateConfig } from '../src/bff/config.js';
import { getToken } from '../src/bff/adapters/token.js';
import { LiveStorage } from '../src/bff/adapters/storage.js';
import { listAllDomains, listAllDataProducts, guidFor } from './bootstrap.js';
import { toAttributeMap, createPurviewAdapter } from '../src/bff/adapters/purview.js';
import { connectionNameFor } from '../src/bff/adapters/foundry-connections.js';
import { createDataMapAdapter, adlsQualifiedName } from '../src/bff/adapters/datamap.js';

const readPack = (name) => JSON.parse(readFileSync(new URL(`../bootstrap/${name}.json`, import.meta.url), 'utf8'));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const segment = (value) => encodeURIComponent(value);
const LEGACY_DOMAINS = ['Water', 'Flood and coastal', 'Marine and fisheries', 'Waste and resources', 'Air quality', 'Land and biodiversity', 'Farming and countryside', 'Animal and plant health', 'Corporate services'];
const LEGACY_FOLDERS = ['ammonia-emissions-grid','bathing-water-results','catchment-land-cover','flood-risk-model-outputs','hydrology-flow-level','livestock-movements','marine-catch-returns','national-forest-inventory','rural-land-parcels','servicenow-incidents','waste-carrier-registrations','water-quality-archive'];

export function cortexOwnedAgentIds(records, artefacts = []) {
  const ids = new Set(records.filter((record) => {
    const id = record._source?.id || record.id;
    return record._agent?.definition?.builtById ||
      record._agent?.apimApiId === `${id}-api` || record._agent?.apimMcpId === `${id}-mcp`;
  }).map((record) => record._source?.id || record.id));
  for (const record of artefacts) if (record.agentId) ids.add(record.agentId);
  return ids;
}

export function targetScope(c = config) {
  return {
    subscription: c.apim.subscriptionId,
    apimGroup: c.apim.resourceGroup, apim: c.apim.serviceName,
    foundry: c.foundry.projectEndpoint, foundryAccount: c.foundry.accountName,
    foundryProject: c.foundry.projectName, foundryGroup: c.foundry.resourceGroup,
    purview: c.purview.endpoint, dataMap: c.purview.dataMapEndpoint,
    search: c.search.endpoint, dataAccount: c.data.storageAccount, dataContainer: c.data.container,
    stateAccount: c.state.blobAccount, stateContainer: c.state.blobContainer,
    stateContainers: c.state.resetContainers || [c.state.blobContainer],
    web: c.publicBaseUrl
  };
}

export function resourceUrl(item, scope) {
  if (typeof item.id !== 'string' || !item.id || /[\r\n]/.test(item.id)) throw new Error('Invalid reset resource id.');
  const id = segment(item.id);
  const apim = `https://management.azure.com/subscriptions/${segment(scope.subscription)}/resourceGroups/${segment(scope.apimGroup)}/providers/Microsoft.ApiManagement/service/${segment(scope.apim)}`;
  const project = `https://management.azure.com/subscriptions/${segment(scope.subscription)}/resourceGroups/${segment(scope.foundryGroup)}/providers/Microsoft.CognitiveServices/accounts/${segment(scope.foundryAccount)}/projects/${segment(scope.foundryProject)}`;
  const catalogue = `${scope.purview}/datagovernance/catalog`;
  const paths = {
    api: [`${apim}/apis/${id}?api-version=2025-09-01-preview`, 'https://management.azure.com/.default'],
    agent: [`${scope.foundry}/agents/${id}?api-version=v1`, 'https://ai.azure.com/.default'],
    connection: [`${project}/connections/${id}?api-version=2025-06-01`, 'https://management.azure.com/.default'],
    product: [`${catalogue}/dataProducts/${id}?api-version=2026-03-20-preview`, 'https://purview.azure.net/.default'],
    domain: [`${catalogue}/businessdomains/${id}?api-version=2026-03-20-preview`, 'https://purview.azure.net/.default'],
    asset: [`${catalogue}/dataAssets/${id}?api-version=2026-03-20-preview`, 'https://purview.azure.net/.default'],
    relationship: [`${catalogue}/dataProducts/${segment(item.parent || '')}/relationships?api-version=2026-03-20-preview&entityType=DATAASSET&entityId=${id}`, 'https://purview.azure.net/.default'],
    mapAsset: [`${scope.dataMap}/datamap/api/atlas/v2/entity/guid/${id}?api-version=2023-09-01`, 'https://purview.azure.net/.default'],
    scan: [`${scope.dataMap}/scan/datasources/${segment(item.parent || '')}/scans/${id}?api-version=2023-09-01`, 'https://purview.azure.net/.default'],
    source: [`${scope.dataMap}/scan/datasources/${id}?api-version=2023-09-01`, 'https://purview.azure.net/.default'],
    evaluation: [`${scope.foundry}/openai/evals/${id}?api-version=2025-11-15-preview`, 'https://ai.azure.com/.default'],
    taxonomy: [`${scope.foundry}/evaluationtaxonomies/${id}?api-version=2025-11-15-preview`, 'https://ai.azure.com/.default']
  };
  paths.response = [`${scope.foundry}/openai/v1/responses/${id}`, 'https://ai.azure.com/.default'];
  paths.conversation = [`${scope.foundry}/openai/v1/conversations/${id}`, 'https://ai.azure.com/.default'];
  for (const kind of ['indexers', 'indexes', 'datasources']) paths[kind] = [`${scope.search}/${kind}/${id}?api-version=2024-07-01`, 'https://search.azure.com/.default'];
  for (const kind of ['knowledgebases', 'knowledgesources']) paths[kind] = [`${scope.search}/${kind}/${id}?api-version=2026-08-01-preview`, 'https://search.azure.com/.default'];
  for (const kind of ['dataBlob', 'stateBlob']) {
    const state = kind === 'stateBlob';
    const container = state ? item.parent || scope.stateContainer : scope.dataContainer;
    if (item.kind === 'stateBlob' && state && !(scope.stateContainers || [scope.stateContainer]).includes(container)) throw new Error('State container is outside the reviewed reset scope.');
    paths[kind] = [`https://${state ? scope.stateAccount : scope.dataAccount}.blob.core.windows.net/${segment(container)}/${item.id.split('/').map(segment).join('/')}`, 'https://storage.azure.com/.default'];
  }
  if (!Object.hasOwn(paths, item.kind)) throw new Error(`Unsupported reset resource kind: ${item.kind}`);
  const [url, tokenScope] = paths[item.kind];
  if (new URL(url).protocol !== 'https:') throw new Error('Reset endpoints must use HTTPS.');
  return { url, tokenScope };
}

export async function requestResource(item, scope, method = 'GET', { fetchFn = fetch, tokenFn = getToken } = {}) {
  const { url, tokenScope } = resourceUrl(item, scope);
  const res = await fetchFn(url, {
    method,
    headers: {
      Authorization: ['Bearer', await tokenFn(tokenScope)].join(' '),
      'x-ms-version': '2023-11-03',
      ...(['evaluation', 'taxonomy'].includes(item.kind) ? { 'Foundry-Features': 'Evaluations=V1Preview' } : {}),
      ...(method === 'DELETE' ? { 'If-Match': item.etag || '*' } : {})
    },
    signal: AbortSignal.timeout(60000)
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${item.kind} ${item.id}: ${method} failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  let body = text;
  if (text && res.headers.get('content-type')?.includes('json')) body = JSON.parse(text);
  if (method === 'DELETE' && body?.deleted === false) throw new Error(`${item.kind} ${item.id}: provider returned deleted:false; the object must not be reported as deleted.`);
  if (item.kind === 'relationship' && method === 'GET') {
    body = body?.value?.find((relation) => relation.entityId === item.id);
    if (!body) return null;
  }
  return { body, etag: res.headers.get('etag'), status: res.status };
}

export async function buildPlan({ includeLegacy = false, reviewedItems = [] } = {}) {
  const scope = targetScope();
  if (Object.values(scope).some((v) => !v)) throw new Error('Load the complete deployed configuration (including Foundry ARM names, data and state containers) before planning a full reset.');
  const products = readPack('data-products');
  const domains = readPack('domains');
  const skills = readPack('skills');
  const state = new LiveStorage({ storageAccount: scope.stateAccount, container: scope.stateContainer, scope: config.state.scope });
  const data = new LiveStorage(config.data);
  const stateFiles = [];
  const stateDocs = {};
  for (const container of scope.stateContainers) {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(container)) throw new Error('Invalid state container.');
    const files = await state.list(container);
    stateFiles.push(...files.map((file) => ({ ...file, container })));
    for (const file of files.filter((f) => f.name.endsWith('.json') && !f.name.includes('/'))) {
      const value = JSON.parse(await state.download(container, file.name));
      if (!stateDocs[file.name]) stateDocs[file.name] = [];
      stateDocs[file.name].push(value);
    }
  }
  const recordsOf = (name) => (stateDocs[name] || []).flatMap((value) => Object.values(value || {}));
  const candidates = reviewedItems.map((item) => ({ kind: item.kind, id: item.id, ...(item.parent ? { parent: item.parent } : {}), reason: 'Explicit operator-reviewed orphan resource' }));
  const add = (kind, id, reason, parent) => { if (id) candidates.push({ kind, id: String(id), reason, ...(parent ? { parent } : {}) }); };
  const warnings = [
    'Review every resource before applying. Selection is based on this demo pack and this app state, not ownership of the entire shared Azure estate.',
    'Legacy content and agents whose Cortex state was lost cannot be identified reliably. Use --include-legacy for legacy catalogue domains; add exact reviewed kind/id entries for other orphaned resources, then create a new plan.',
    'This deletes active content, not platform audit logs, backups, soft-delete retention or provider telemetry. Azure retention policies still apply.',
    'Quiesce ALL apps and jobs that write shared demo content before applying. This plan includes only its explicitly named state containers.'
  ];
  const allDomains = await listAllDomains();
  const allProducts = await listAllDataProducts();
  const selectedDomains = allDomains.filter((d) => domains.some((p) => d.id === guidFor(`domain:${p.id}`) || d.name === p.name) || (includeLegacy && LEGACY_DOMAINS.includes(d.name)));
  const selectedProducts = allProducts.filter((p) => selectedDomains.some((d) => p.domain === d.id) &&
    (toAttributeMap(p.managedAttributes).cortexDataFolder || domains.some((d) => guidFor(`domain:${d.id}`) === p.domain)));
  const purview = createPurviewAdapter();
  const dataMap = createDataMapAdapter();
  const indexNames = new Set();
  const folders = new Set(products.map((p) => p.id));
  if (includeLegacy) for (const folder of LEGACY_FOLDERS) {
    folders.add(folder);
    indexNames.add(`${config.search.indexPrefix}${folder}`);
  }
  for (const p of selectedProducts) {
    add('product', p.id, `Product inside selected demo domain: ${p.name}`);
    const attrs = toAttributeMap(p.managedAttributes);
    if (attrs.cortexSearchIndex) indexNames.add(attrs.cortexSearchIndex);
    if (attrs.cortexDataFolder) folders.add(attrs.cortexDataFolder);
    for (const asset of await purview.getAssets(p.id)) {
      const prefix = `https://${scope.dataAccount}.dfs.core.windows.net/${scope.dataContainer}/`;
      const mapped = asset.dataMapAssetId ? await requestResource({ kind: 'mapAsset', id: asset.dataMapAssetId }, scope) : null;
      const qualifiedName = mapped?.body?.entity?.attributes?.qualifiedName;
      if ([asset.fqn, asset.openInUrl, qualifiedName].some((url) => url?.startsWith(prefix))) {
        add('relationship', asset.id, `Binding between selected product ${p.name} and its selected sample asset`, p.id);
        add('asset', asset.id, `Sample asset attached to ${p.name}`);
        add('mapAsset', asset.dataMapAssetId, 'Data Map asset in the exact sample-data container');
      } else warnings.push(`Asset ${asset.id} attached to ${p.name} has no verified sample-storage URL; it is preserved. Review explicitly.`);
    }
  }
  for (const d of selectedDomains) {
    if (allProducts.some((p) => p.domain === d.id && !selectedProducts.includes(p))) warnings.push(`Domain ${d.name} contains unrelated products and will be preserved.`);
    else add('domain', d.id, `Selected demo domain: ${d.name}`);
  }
  for (const p of products) indexNames.add(`${config.search.indexPrefix}${p.id}`);
  for (const name of indexNames) {
    add('indexers', `${name}-indexer`, 'Indexer for selected demo data');
    add('indexes', name, 'Selected demo grounding index');
    add('datasources', `${name}-source`, 'Data source for selected demo data');
  }
  const agentRecords = recordsOf('agents.json');
  const artefacts = recordsOf('artefacts.json').filter((record) => record.ownerId && /^cx-art-[a-f0-9-]+$/.test(record.id || ''));
  const ownedAgentIds = cortexOwnedAgentIds(agentRecords, artefacts);
  for (const a of agentRecords) {
    if (!ownedAgentIds.has(a._source?.id || a.id)) {
      warnings.push(`Agent ${a._source?.id || a.id} has no recorded Cortex builder/publication provenance; preserved unless explicitly reviewed.`);
      continue;
    }
    add('agent', a._source?.id || a.id, 'Agent recorded by this Cortex app');
    if (a._agent?.published) {
      add('api', `${a.id}-api`, 'Published agent backing API');
      add('api', `${a.id}-mcp`, 'Published agent MCP API');
      add('connection', connectionNameFor(`${a.id}-mcp`), 'Published agent MCP connection');
    }
    for (const connection of a._agent?.connections || []) add('connection', connection.name || connection.connection, 'Connection recorded for this agent');
  }
  for (const record of artefacts) {
    add('api', record.id, `Cortex artefact backing API: ${record.name}`);
    add('api', `${record.id}-mcp`, `Cortex artefact MCP: ${record.name}`);
    add('connection', record.connection || connectionNameFor(`${record.id}-mcp`), 'Cortex artefact connection');
    if (record.agentId) add('agent', record.agentId, 'Cortex wrapper agent recorded by artefact publisher');
  }
  for (const record of recordsOf('knowledge-artefacts.json')) {
    if (!record._knowledge || record._source?.system !== 'cortex') continue;
    add('knowledgebases', record._knowledge.name, 'Foundry IQ base recorded by Cortex');
    add('knowledgesources', record._knowledge.sourceName, 'Foundry IQ source recorded by Cortex');
    add('connection', record._knowledge.connectionId?.split('/').pop(), 'Foundry IQ project connection recorded by Cortex');
  }
  for (const record of recordsOf('knowledge-jobs.json')) {
    if (!record.ownerId || !/^cx-iq-[a-f0-9-]+$/.test(record.id || '')) continue;
    add('knowledgebases', record.id, 'Completed or partial Cortex knowledge publication');
    add('knowledgesources', `${record.id}-source`, 'Completed or partial Cortex knowledge publication');
    add('connection', connectionNameFor(record.id, 'cx-iq-'), 'Completed or partial Cortex knowledge connection');
  }
  for (const product of products) {
    const name = `cx-kb-${product.id}`;
    add('knowledgebases', name, 'Bootstrap-owned per-product knowledge base');
    add('knowledgesources', `${name}-source`, 'Bootstrap-owned per-product knowledge source');
    add('connection', connectionNameFor(name, 'cx-iq-'), 'Bootstrap-owned knowledge connection');
  }
  add('agent', config.ask.agentName, 'Configured Cortex Ask agent (shared by variants)');
  const inspectHistory = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['responseId', 'lastResponseId'].includes(key) && typeof child === 'string') add('response', child, 'Provider response referenced by application history');
      else if (key === 'conversationId' && typeof child === 'string') add('conversation', child, 'Provider conversation referenced by application history');
      else if (typeof child === 'object') inspectHistory(child);
    }
  };
  for (const name of ['chats.json', 'ask-threads.json', 'automations.json', 'requests.json']) inspectHistory(stateDocs[name]);
  for (const skill of skills) {
    add('api', skill.id, 'Current bootstrap skill API');
    add('api', `${skill.id}-mcp`, 'Current bootstrap skill MCP API');
    add('connection', connectionNameFor(`${skill.id}-mcp`), 'Bootstrap skill connection');
  }
  if (includeLegacy) {
    for (const id of ['permit-history-lookup','catchment-summariser','address-matching','catchment-data-explorer','magic-map','air-quality-dashboard']) {
      add('api', id, 'Explicitly included legacy demo API');
      add('api', `${id}-mcp`, 'Explicitly included legacy demo MCP API');
      add('connection', connectionNameFor(`${id}-mcp`), 'Legacy demo connection');
    }
  }
  add('connection', config.foundry.searchConnection, 'Configured Cortex grounding connection');
  for (const r of recordsOf('redteam-runs.json')) {
    add('evaluation', r.evalId, 'Cortex red team evaluation and its runs');
    add('taxonomy', r.taxonomyName, 'Cortex red team taxonomy');
  }
  const source = process.env.PURVIEW_DATA_SOURCE || 'cortex-sample-data';
  add('scan', process.env.PURVIEW_SCAN_NAME || 'cortex-sample-scan', 'Configured Cortex sample scan', source);
  add('source', source, 'Configured Cortex sample data source');
  for (const file of await data.list(scope.dataContainer)) {
    // HNS exposes directory markers as zero-byte blobs; preserve empty folders.
    if (folders.has(file.name) && !file.name.includes('/') && file.size === 0) continue;
    if (folders.has(file.name.split('/')[0])) {
      add('dataBlob', file.name, 'File under selected demo product folder');
      const asset = await dataMap.getAssetByQualifiedName(adlsQualifiedName(scope.dataAccount, scope.dataContainer, file.name));
      if (asset) add('mapAsset', asset.id, 'Scanned file in the exact selected sample folder, including unattached files');
    }
    else warnings.push(`Unmatched sample-container file ${file.name} preserved; review its ownership.`);
  }
  for (const file of stateFiles) add('stateBlob', file.name, 'Application state in an explicitly selected state container', file.container);
  const order = ['scan','source','indexers','api','response','conversation','agent','connection','evaluation','taxonomy','relationship','asset','product','mapAsset','domain','knowledgebases','knowledgesources','indexes','datasources','dataBlob','stateBlob'];
  const unique = [...new Map(candidates.map((c) => [`${c.kind}:${c.parent || ''}:${c.id}`, c])).values()]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.kind === 'api' ? Number(b.id.endsWith('-mcp')) - Number(a.id.endsWith('-mcp')) : a.kind === 'dataBlob' ? b.id.split('/').length - a.id.split('/').length : 0));
  const items = [];
  const responseIds = new Set(unique.filter((item) => item.kind === 'response').map((item) => item.id));
  for (const item of unique) {
    const snapshot = await requestResource(item, scope);
    if (snapshot && item.kind === 'scan') await assertScanIdle(item);
    if (snapshot) items.push({ ...item, etag: snapshot.etag, fingerprint: hash(snapshot.body) });
    const previous = item.kind === 'response' && snapshot?.body?.previous_response_id;
    if (previous && !responseIds.has(previous)) {
      if (responseIds.size >= 10000) throw new Error('Response history exceeds 10,000 items. Review and reset it separately before retrying.');
      responseIds.add(previous);
      unique.push({ kind: 'response', id: previous, reason: 'Previous response in a recorded conversation chain' });
    }
  }
  return { version: 1, createdAt: new Date().toISOString(), scope, warnings, items };
}

export async function assertScanIdle(item) {
  const runs = await createDataMapAdapter().scanRuns(item.parent, item.id);
  if (runs.some((run) => !/^(Succeeded|Completed|Failed|Cancelled|Canceled|CompletedWithExceptions)$/i.test(run.status || ''))) {
    throw new Error(`Scan ${item.id} has an active or unknown-status run. Stop it before creating/applying a reset plan.`);
  }
}

export async function applyPlan(plan, { confirmation, writersStopped, request = requestResource, save = () => {}, scanCheck = assertScanIdle, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (plan.version !== 1 || !Array.isArray(plan.items)) throw new Error('Invalid reset plan.');
  if (hash(plan.scope) !== hash(targetScope())) throw new Error('Configured targets differ from the reset plan. Load the original environment.');
  if (confirmation !== hash({ scope: plan.scope, items: plan.items.map(({ done, ...item }) => item) }) || !writersStopped) throw new Error('Pass the exact plan confirmation hash and --writers-stopped. No content was deleted.');
  // Verify the entire plan before deleting anything, so a stale state blob does not fail only at the end.
  for (const item of plan.items.filter((i) => !i.done)) {
    const current = await request(item, plan.scope);
    if (current && item.kind === 'scan') await scanCheck(item);
    if (current && current.body?.entity?.status !== 'DELETED' && hash(current.body) !== item.fingerprint) throw new Error(`Resource changed since planning: ${item.kind} ${item.id}. Create and review a new plan.`);
  }
  for (const item of plan.items.filter((i) => !i.done)) {
    await request(item, plan.scope, 'DELETE');
    let gone = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = await request(item, plan.scope);
      if (!current || current.body?.entity?.status === 'DELETED') { gone = true; break; }
      await sleep(2000);
    }
    if (!gone) throw new Error(`Deletion not confirmed: ${item.kind} ${item.id}. Plan progress saved; do not rebootstrap yet.`);
    item.done = true;
    save(plan);
  }
  return plan.items.length;
}

export function confirmationFor(plan) {
  return hash({ scope: plan.scope, items: plan.items.map(({ done, ...item }) => item) });
}

export async function main(args = process.argv.slice(2)) {
  const option = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  if (option('--state-containers')) config.state.resetContainers = [...new Set(option('--state-containers').split(','))];
  const file = option('--plan');
  if (!file) throw new Error('Usage: node scripts/reset-content.js --plan=<file.json> [--include-legacy] to create a READ-ONLY inventory; then --apply --confirm=<hash> --writers-stopped to delete that reviewed content.');
  await hydrateConfig();
  if (!args.includes('--apply')) {
    const reviewedItems = option('--include') ? JSON.parse(readFileSync(option('--include'), 'utf8')) : [];
    if (!Array.isArray(reviewedItems)) throw new Error('--include must name a JSON array of explicitly reviewed kind/id entries.');
    const plan = await buildPlan({ includeLegacy: args.includes('--include-legacy'), reviewedItems });
    writeFileSync(file, JSON.stringify(plan, null, 2), { flag: 'wx' });
    console.log(`READ-ONLY plan: ${plan.items.length} resources in ${file}. No content deleted.\n${plan.warnings.join('\n')}\nConfirmation: ${confirmationFor(plan)}`);
  } else {
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    const count = await applyPlan(plan, {
      confirmation: option('--confirm'), writersStopped: args.includes('--writers-stopped'),
      save: (p) => writeFileSync(file, JSON.stringify(p, null, 2))
    });
    console.log(`${count} planned resources deleted or already absent. Infrastructure, roles and app registrations retained. Review plan warnings for preserved or retained content.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => { console.error(err.message); process.exitCode = 1; });
