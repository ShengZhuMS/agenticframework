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
  config.purview.endpoint = 'https://api.purview-service.microsoft.com';
  config.publicBaseUrl = 'https://cortex.stub';
  config.purviewMcpUrl = 'https://mcp.stub/mcp';
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
    if (!/\.azure\.com|\.azure-api\.net|management\.azure\.com|purview-service|services\.ai/.test(url)) {
      return realFetch(input, init);
    }
    for (const f of failing) {
      if (url.includes(f)) return json({ error: 'stubbed failure' }, 503);
    }

    // Purview Unified Catalog
    if (url.includes('/datagovernance/catalog/businessdomains')) {
      return json({ value: DOMAINS, nextLink: null });
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
        return json({ name: body.name, version: 1, object: 'agent.version' });
      }
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
