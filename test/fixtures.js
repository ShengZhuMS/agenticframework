/**
 * Test fixtures.
 *
 * Cortex has no seeded data path — it reads Purview, API Management and
 * Foundry through their real APIs. So tests stub the HTTP layer instead,
 * returning the shapes those services actually return.
 *
 * This is deliberately at the transport boundary rather than the adapter
 * boundary: stubbing the adapters would test the tests, and would not catch a
 * response-shape mistake, which is the most likely kind of bug in this code.
 */

import index from '../src/bff/index/store.js';
import config from '../src/bff/config.js';

/**
 * Point configuration at the stub. The adapters build real URLs from these,
 * so they must look like the real thing or the test exercises nothing.
 */
export function stubConfig() {
  config.foundry.projectEndpoint = 'https://stub.services.ai.azure.com/api/projects/cortex';
  config.foundry.model = 'gpt-5-mini';
  config.apim.subscriptionId = '00000000-0000-0000-0000-000000000000';
  config.apim.resourceGroup = 'rg-stub';
  config.apim.serviceName = 'apim-stub';
  config.apim.gatewayUrl = 'https://apim-stub.azure-api.net';
  config.apim.subscriptionKey = 'stub-apim-key';
  config.purview.endpoint = 'https://api.purview-service.microsoft.com';
  config.purview.accountName = 'pview-stub';
  config.purview.dataMapEndpoint = 'https://pview-stub.purview.azure.com';
  config.purview.collection = 'pview-stub';
  config.publicBaseUrl = 'https://cortex.stub';
  config.purviewMcpUrl = 'https://mcp.stub/mcp';
  // Round 4: the Foundry project's ARM location, search, sample data.
  config.foundry.accountName = 'fdry-stub';
  config.foundry.projectName = 'proj-stub';
  config.foundry.resourceGroup = 'rg-fdry-stub';
  config.search.endpoint = 'https://srch-stub.search.windows.net';
  config.search.serviceName = 'srch-stub';
  config.data.storageAccount = 'ststubdata';
  config.data.container = 'products';
  config.data.resourceGroup = 'rg-stub';
}

/** What the ARM stub has been asked to store: project connections by name. */
export const CONNECTIONS = new Map();
/** AI Search objects the stub holds, by kind then name. */
export const SEARCH = { indexes: new Map(), datasources: new Map(), indexers: new Map(), runs: [] };
/** Blobs the storage stub holds, by "container/path". */
export const BLOBS = new Map();
/** Data Map assets the stub knows, by qualified name. */
export const DATAMAP_ASSETS = new Map();
/** Unified Catalog data assets registered through the stub, and product relationships. */
export const UC_ASSETS = new Map();
export const UC_RELATIONSHIPS = new Map();

/** Reset every round-4 stub store. */
export function resetRoundFour() {
  CONNECTIONS.clear();
  SEARCH.indexes.clear();
  SEARCH.datasources.clear();
  SEARCH.indexers.clear();
  SEARCH.runs.length = 0;
  BLOBS.clear();
  DATAMAP_ASSETS.clear();
  UC_ASSETS.clear();
  UC_RELATIONSHIPS.clear();
}

const realFetch = globalThis.fetch;

/** Governance domains, as the Unified Catalog returns them. */
export const DOMAINS = [
  { id: 'd-water', name: 'Water', description: 'Water', status: 'PUBLISHED', type: 'DataDomain' },
  { id: 'd-waste', name: 'Waste and resources', description: 'Waste', status: 'PUBLISHED', type: 'DataDomain' },
  { id: 'd-corp', name: 'Corporate services', description: 'Corp', status: 'PUBLISHED', type: 'DataDomain' }
];

/** Data products, with the managed attributes the bootstrap writes. */
export const PRODUCTS = [
  {
    id: 'p-water-quality',
    name: 'Water quality archive',
    domain: 'd-water',
    description: 'Sampling results for rivers, lakes, estuaries and groundwater.',
    status: 'PUBLISHED',
    updateFrequency: 'Daily',
    managedAttributes: {
      cortexSensitivity: 'Official',
      cortexLicence: 'Open Government Licence — covers all staff and contractors',
      cortexAccessRoute: 'Open to all staff',
      cortexOwnerTeam: 'EA Water Quality',
      cortexAllowedGroups: 'all-staff',
      cortexLimitations: 'Sampling is not uniform in space or time.',
      cortexFreshness: 'Daily'
    }
  },
  {
    id: 'p-waste-carriers',
    name: 'Waste carrier registrations',
    domain: 'd-waste',
    description: 'Registered waste carriers, brokers and dealers.',
    status: 'PUBLISHED',
    updateFrequency: 'Daily',
    managedAttributes: {
      cortexSensitivity: 'Official',
      cortexLicence: 'Open Government Licence — all staff',
      cortexAccessRoute: 'Open to the waste crime team',
      cortexOwnerTeam: 'EA Waste Regulation',
      cortexAllowedGroups: 'waste-crime,ea-waste-regulation',
      cortexDependsOn: 'p-water-quality',
      cortexFreshness: 'Daily'
    }
  },
  {
    id: 'p-livestock',
    name: 'Livestock movement records',
    domain: 'd-waste',
    description: 'Animal movement records between holdings.',
    status: 'PUBLISHED',
    updateFrequency: 'Daily',
    managedAttributes: {
      cortexSensitivity: 'Official–Sensitive',
      cortexLicence: 'Internal only',
      cortexAccessRoute: 'No route in your current role',
      cortexOwnerTeam: 'APHA Surveillance',
      cortexAllowedGroups: 'apha-surveillance',
      cortexFreshness: 'Daily'
    }
  },
  {
    id: 'p-sickness',
    name: 'Sickness absence records',
    domain: 'd-corp',
    description: 'Individual sickness absence records per employee.',
    status: 'PUBLISHED',
    updateFrequency: 'Daily',
    managedAttributes: {
      cortexSensitivity: 'Official',
      cortexLicence: 'Internal only',
      cortexAccessRoute: 'No direct route. Answers available from the holder.',
      cortexOwnerTeam: 'DDTS Performance',
      cortexAllowedGroups: 'ddts-performance,analysts',
      cortexAskable: 'Average days sick per employee, by directorate|Absence rate by month',
      cortexMinimumAggregation: 'Directorate level. No answer covers fewer than 10 people.',
      cortexFreshness: 'Daily'
    }
  }
];

/**
 * An MCP server as API Management returns it: an API of type 'mcp' whose tools
 * are INLINE in mcpTools, each pointing at a backing operation by full ARM id.
 * serviceUrl is null on an MCP API — the endpoint is {gateway}/{path}/mcp.
 */
export const MCP_SERVERS = [
  {
    name: 'permit-history-lookup-mcp',
    properties: {
      type: 'mcp',
      displayName: 'Permit history lookup',
      description: 'Look up permit history for a site.',
      path: 'permit-history-lookup-mcp',
      serviceUrl: null,
      mcpTools: [
        {
          name: 'invoke',
          description: 'Look up permit history for a site.',
          operationId:
            '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-stub/providers/Microsoft.ApiManagement/service/apim-stub/apis/permit-history-lookup/operations/invoke'
        }
      ]
    }
  }
];

/** APIs the stub has been asked to create, by id, so a later GET reads back what was PUT. */
export const CREATED_APIS = new Map();

export const APIS = [
  {
    name: 'permit-history-lookup',
    properties: {
      displayName: 'Permit history lookup',
      description: 'Look up permit history for a site.',
      path: 'permit-history-lookup'
    }
  }
];

export const USAGE = {
  value: [
    { name: 'permit-history-lookup', callCountTotal: 41200, callCountFailed: 80, apiTimeAvg: 0.24 }
  ]
};

/** People, defined by group membership exactly as Entra would supply it. */
export const USERS = {
  analyst: {
    id: 'analyst',
    name: 'Sarah Okonjo',
    email: 'sarah@defra.gov.uk',
    groups: ['all-staff', 'waste-crime', 'analysts'],
    clearance: 'Official',
    licences: ['ogl', 'internal'],
    team: 'Waste Crime observatory'
  },
  consumer: {
    id: 'consumer',
    name: 'David Whitfield',
    email: 'david@defra.gov.uk',
    groups: ['all-staff'],
    clearance: 'Official',
    licences: ['ogl', 'internal'],
    team: 'COO Management Information'
  },
  owner: {
    id: 'owner',
    name: 'Michael Brennan',
    email: 'michael@defra.gov.uk',
    groups: ['all-staff', 'waste-crime', 'ea-waste-regulation', 'apha-surveillance'],
    clearance: 'Official–Sensitive',
    licences: ['ogl', 'internal', 'commercial'],
    team: 'EA Waste Regulation'
  }
};

/**
 * Stub every Azure call this app makes.
 * Returns a restore function.
 */
export function stubAzure({ agents = [], failing = [] } = {}) {
  stubConfig();
  process.env.IDENTITY_ENDPOINT = 'http://localhost/IDENTITY';
  process.env.IDENTITY_HEADER = 'stub';

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const json = (body, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body)
    });

    if (url.includes('IDENTITY')) {
      return json({ access_token: 'stub-token', expires_on: '99999999999' });
    }

    // Anything that is not an Azure endpoint goes to the real network. That
    // lets a test boot the actual server and drive it over HTTP while its
    // outbound Azure calls stay stubbed.
    if (!/\.azure\.com|\.azure-api\.net|management\.azure\.com|purview-service|services\.ai|search\.windows\.net|core\.windows\.net/.test(url)) {
      return realFetch(input, init);
    }
    for (const f of failing) {
      if (url.includes(f)) return json({ error: 'stubbed failure' }, 503);
    }
    const method = init.method || 'GET';
    const body = () => JSON.parse(init.body || '{}');
    const host = new URL(url).hostname;

    // Foundry project connections (ARM)
    const conn = url.match(/\/connections\/([^/?]+)\?/);
    if (conn && url.includes('management.azure.com')) {
      const name = conn[1];
      if (method === 'PUT') {
        CONNECTIONS.set(name, { name, ...body() });
        return json(CONNECTIONS.get(name));
      }
      return CONNECTIONS.has(name) ? json(CONNECTIONS.get(name)) : json({ error: { code: 'NotFound' } }, 404);
    }
    if (url.includes('management.azure.com') && /\/connections\?/.test(url)) {
      return json({ value: [...CONNECTIONS.values()] });
    }

    // Azure AI Search
    if (host.endsWith('search.windows.net')) {
      const m = url.match(/\/(indexes|datasources|indexers)(?:\/([^/?]+))?(?:\/(stats|status|run|docs\/search))?\?/);
      if (m) {
        const [, kind, rawName, action] = m;
        const name = rawName ? decodeURIComponent(rawName) : null;
        const store = SEARCH[kind];
        if (!name) return json({ value: [...store.values()].map((x) => ({ name: x.name })) });
        if (action === 'run') {
          if (!SEARCH.indexers.has(name)) return json({ error: 'no such indexer' }, 404);
          SEARCH.runs.push(name);
          return json(null, 202);
        }
        if (action === 'stats') return store.has(name) ? json({ documentCount: 42, storageSize: 1000 }) : json({}, 404);
        if (action === 'status') {
          return store.has(name)
            ? json({ status: 'running', lastResult: { status: 'success', itemsProcessed: 42, itemsFailed: 0, startTime: '2026-09-11T08:00:00Z', endTime: '2026-09-11T08:00:05Z', errors: [] } })
            : json({}, 404);
        }
        if (action === 'docs/search') {
          return json({ value: [{ '@search.score': 1, id: 'a', title: 'row', url: 'https://ststubdata.blob.core.windows.net/products/x.csv', registration_number: 'CBDU000001' }] });
        }
        if (method === 'PUT') {
          store.set(name, { ...body(), name });
          return json(store.get(name), store.has(name) ? 200 : 201);
        }
        if (method === 'DELETE') {
          store.delete(name);
          return json(null, 204);
        }
        return store.has(name) ? json(store.get(name)) : json({}, 404);
      }
    }

    // Storage (blob REST) — by HOST: a Data Map qualified name in a query
    // string also contains core.windows.net and must not land here.
    if (host.endsWith('core.windows.net')) {
      const u = new URL(url);
      const [, container, ...rest] = u.pathname.split('/');
      const key = `${container}/${rest.map(decodeURIComponent).join('/')}`;
      if (u.searchParams.get('restype') === 'container' && u.searchParams.get('comp') === 'list') {
        const prefix = u.searchParams.get('prefix') || '';
        const items = [...BLOBS.entries()].filter(([k]) => k.startsWith(`${container}/${prefix}`));
        const xml = `<EnumerationResults><Blobs>${items
          .map(([k, v]) => `<Blob><Name>${k.slice(container.length + 1)}</Name><Properties><Content-Length>${v.length}</Content-Length></Properties></Blob>`)
          .join('')}</Blobs></EnumerationResults>`;
        return { ok: true, status: 200, text: async () => xml, json: async () => ({}) };
      }
      if (u.searchParams.get('restype') === 'container') return json(null, 201);
      if (method === 'PUT') {
        BLOBS.set(key, typeof init.body === 'string' ? init.body : Buffer.from(init.body || '').toString('utf8'));
        return json(null, 201);
      }
      if (BLOBS.has(key)) return { ok: true, status: 200, text: async () => BLOBS.get(key), json: async () => ({}) };
      return json({}, 404);
    }

    // Purview Data Map (account endpoint)
    if (host.endsWith('.purview.azure.com')) {
      if (url.includes('/account/collections')) return json({ value: [{ name: 'pview-stub', friendlyName: 'Root' }] });
      if (url.includes('/policystore/collections/')) {
        return json({
          id: 'policy-1',
          name: 'policy-1',
          properties: {
            attributeRules: [
              { id: 'purviewmetadatarole_builtin_data-source-administrator:pview-stub', dnfCondition: [[{ attributeName: 'principal.microsoft.id', attributeValueIncludedIn: ['existing-oid'] }]] },
              { id: 'purviewmetadatarole_builtin_data-curator:pview-stub', dnfCondition: [[{ attributeName: 'principal.microsoft.id', attributeValueIncludedIn: [] }]] },
              { id: 'purviewmetadatarole_builtin_purview-reader:pview-stub', dnfCondition: [[{ attributeName: 'derived.purview.role', attributeValueIncludes: 'purviewmetadatarole_builtin_purview-reader' }]] }
            ]
          }
        });
      }
      if (url.includes('/policystore/metadataPolicies/')) {
        DATAMAP_ASSETS.set('__policy_put__', body());
        return json(body());
      }
      if (/\/scan\/datasources\/[^/]+\/scans\/[^/]+:run\?/.test(url) && (init.method || 'GET') === 'POST') return json({ scanResultId: 'run-1', status: 'Queued' });
      if (/\/scan\/datasources\/[^/]+\/scans\/[^/]+\/runs\?/.test(url)) {
        return json({ value: [{ id: 'run-1', status: 'Succeeded', startTime: '2026-09-11T08:00:00Z', assetsDiscovered: 28 }] });
      }
      if (/\/scan\/datasources\/[^/]+\/scans\/[^/?]+\?/.test(url)) {
        if (method === 'PUT') return json({ ...body(), name: 'scan' }, 201);
        return json({}, 404);
      }
      if (/\/scan\/datasources\/[^/?]+\?/.test(url)) {
        if (method === 'PUT') return json({ ...body() }, 201);
        return json({}, 404);
      }
      if (url.includes('/entity/uniqueAttribute/type/')) {
        const qn = decodeURIComponent(new URL(url).searchParams.get('attr:qualifiedName') || '');
        const a = DATAMAP_ASSETS.get(qn);
        return a ? json({ entity: a, referredEntities: {} }) : json({}, 404);
      }
      if (url.includes('/search/query')) return json({ value: [] });
    }

    // Purview Unified Catalog
    if (url.includes('/datagovernance/catalog/businessdomains')) {
      return json({ value: DOMAINS, nextLink: null });
    }
    const rel = url.match(/\/dataProducts\/([^/]+)\/relationships\?/);
    if (rel) {
      const list = UC_RELATIONSHIPS.get(rel[1]) || [];
      if (method === 'POST') {
        list.push(body());
        UC_RELATIONSHIPS.set(rel[1], list);
        return json(body());
      }
      return json({ value: list });
    }
    if (url.includes('/datagovernance/catalog/dataAssets/query')) {
      const b = body();
      const all = [...UC_ASSETS.values()];
      return json({ value: b.ids ? all.filter((a) => b.ids.includes(a.id)) : all });
    }
    if (url.includes('/datagovernance/catalog/dataAssets') && method === 'POST') {
      const b = body();
      const id = `uc-${UC_ASSETS.size + 1}`;
      const asset = { id, name: `asset ${id}`, type: 'ADLSGen2Path', source: { type: 'DataMap', assetId: b.source.assetId, assetType: 'adls_gen2_path', fqn: 'https://ststubdata.dfs.core.windows.net/products/x/x.csv' }, schema: [{ name: 'registration_number' }, { name: 'status' }] };
      UC_ASSETS.set(id, asset);
      return json(asset, 201);
    }
    if (url.includes('/dataProducts/query')) {
      return json({ value: PRODUCTS });
    }
    if (url.includes('/datagovernance/catalog/dataProducts')) {
      return json({ value: PRODUCTS });
    }

    // APIM management
    if (url.includes('/reports/byApi')) return json(USAGE);
    const oneApi = url.match(/\/apis\/([^/?]+)(\?|$)/);
    if (oneApi) {
      const id = decodeURIComponent(oneApi[1]);
      if (init.method === 'PUT') {
        // Behave like ARM: type 'mcp' survives only when mcpTools is present.
        const body = JSON.parse(init.body || '{}');
        const props = { ...(body.properties || {}), provisioningState: 'Succeeded' };
        if (props.type === 'mcp' && !(props.mcpTools || []).length) props.type = null;
        CREATED_APIS.set(id, { name: id, properties: props });
        return json(CREATED_APIS.get(id), 201);
      }
      if (init.method === 'DELETE') {
        CREATED_APIS.delete(id);
        return json(null, 204);
      }
      const known = CREATED_APIS.get(id) || [...APIS, ...MCP_SERVERS].find((a) => a.name === id);
      return known ? json(known) : json({ error: { code: 'ResourceNotFound' } }, 404);
    }
    if (url.includes('/apis')) {
      return json({ value: [...APIS, ...MCP_SERVERS, ...CREATED_APIS.values()] });
    }
    if (url.includes('/products/')) return json({});

    // Foundry
    if (url.includes('/agents')) {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        const versionPath = new URL(url).pathname.match(/\/agents\/([^/]+)\/versions$/);
        const name = versionPath ? decodeURIComponent(versionPath[1]) : body.name;
        const version = versionPath ? Math.max(0, ...agents.filter((agent) => agent.name === name).map((agent) => Number(agent.version))) + 1 : 1;
        agents.push({ name, version, definition: body.definition });
        return json({ name, version, object: 'agent.version' });
      }
      const single = new URL(url).pathname.match(/\/agents\/([^/]+)$/);
      if (single) return json(agents.find((a) => a.name === decodeURIComponent(single[1])) || {}, agents.some((a) => a.name === decodeURIComponent(single[1])) ? 200 : 404);
      return json({ value: agents });
    }
    if (url.includes('/openai/v1/conversations')) return json({ id: 'conv_stub' });
    if (url.includes('/openai/v1/responses')) {
      return json({
        output_text: 'A stubbed answer naming its sources.',
        output: [{ content: [{ text: 'A stubbed answer.', annotations: [] }] }]
      });
    }

    return json({ error: `unstubbed: ${url}` }, 404);
  };

  return () => {
    globalThis.fetch = realFetch;
  };
}

/** Build the index from the stubbed services. */
export async function loadIndex(opts = {}) {
  const restore = stubAzure(opts);
  index.entries.clear();
  index.domains = [];
  index.accessRequests.length = 0;
  index.gatewayRequests.length = 0;
  await index.refresh();
  return restore;
}

export { index };
