/**
 * Configuration.
 *
 * Cortex runs live. There is no demo mode and no seeded data path: every
 * screen is rendered from Microsoft Purview, Azure API Management and
 * Microsoft Foundry through their real APIs.
 *
 * Endpoints and keys come from Azure Key Vault, read once at startup with the
 * app's managed identity. Environment variables remain the fallback so the app
 * can be run locally against the same Azure resources with `az login`.
 *
 * The object below is the shape and the defaults. hydrateConfig() overlays the
 * vault on top of it before the server listens, mutating in place so every
 * synchronous `config.x.y` reader keeps working.
 */

import { resolveSecrets, setPath, SECRET_CATALOGUE } from './adapters/keyvault.js';
import { parseGroupNames, parseDefaultGroups } from './services/identity.js';

const env = process.env;

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}

export const config = {
  port: Number(env.PORT || 3000),
  nodeEnv: env.NODE_ENV || 'development',
  maintenance: bool(env.CORTEX_MAINTENANCE),

  purview: {
    // NOT the account-scoped host — that form is legacy.
    endpoint: env.PURVIEW_ENDPOINT || 'https://api.purview-service.microsoft.com',
    apiVersion: env.PURVIEW_API_VERSION || '2026-03-20-preview',
    scope: 'https://purview.azure.net/.default',
    /**
     * The Purview ACCOUNT, for the Data Map (sources, scans, assets). The
     * Unified Catalog is tenant-level and needs no account name; the Data Map
     * still lives at https://<account>.purview.azure.com.
     */
    accountName: env.PURVIEW_ACCOUNT_NAME || '',
    dataMapEndpoint:
      env.PURVIEW_DATAMAP_ENDPOINT || (env.PURVIEW_ACCOUNT_NAME ? `https://${env.PURVIEW_ACCOUNT_NAME}.purview.azure.com` : ''),
    dataMapApiVersion: env.PURVIEW_DATAMAP_API_VERSION || '2023-09-01',
    /** Data Map collection the sample sources are registered in. Defaults to the root collection (= account name). */
    collection: env.PURVIEW_COLLECTION || env.PURVIEW_ACCOUNT_NAME || '',
    /** No outbound call may hang a page or the index refresh. */
    timeoutMs: Number(env.PURVIEW_TIMEOUT_MS || 30_000)
  },

  apim: {
    subscriptionId: env.AZURE_SUBSCRIPTION_ID || '',
    resourceGroup: env.AZURE_RESOURCE_GROUP || '',
    serviceName: env.APIM_SERVICE_NAME || '',
    // MCP server management requires this preview api-version even though the
    // feature itself is GA. Pin it.
    apiVersion: env.APIM_API_VERSION || '2025-09-01-preview',
    // Analytics lives on the stable management api-version, not the preview one.
    analyticsApiVersion: env.APIM_ANALYTICS_API_VERSION || '2024-05-01',
    gatewayUrl: env.APIM_GATEWAY_URL || '',
    subscriptionKey: env.APIM_SUBSCRIPTION_KEY || '',
    productId: env.APIM_PRODUCT_ID || 'cortex'
  },

  foundry: {
    // https://<resource>.services.ai.azure.com/api/projects/<project>
    projectEndpoint: env.FOUNDRY_PROJECT_ENDPOINT || '',
    apiVersion: 'v1',
    scope: 'https://ai.azure.com/.default',
    /**
     * How a tool names its project connection. 'id' (default) is the full
     * connection resource id, which is what the Foundry SDK's connection.id
     * returns and what the REST samples show; 'name' is the bare connection
     * name. Switch with FOUNDRY_CONNECTION_REF=name if Foundry reports the
     * connection as not found in the id form.
     */
    connectionRef: env.FOUNDRY_CONNECTION_REF === 'name' ? 'name' : 'id',
    model: env.FOUNDRY_MODEL || 'gpt-5-mini',
    /**
     * Further deployments the approved catalogue may offer, comma-separated.
     * Only deployments that exist in the project belong here — an agent built
     * on a model that is not deployed fails at creation, not at selection.
     */
    extraModels: (env.FOUNDRY_MODELS || '').split(',').map((m) => m.trim()).filter(Boolean),
    /**
     * Project connection of kind 'remote-tool' carrying the APIM subscription
     * key, so an agent can call an APIM MCP server.
     */
    mcpConnection: env.FOUNDRY_MCP_CONNECTION || '',
    /**
     * Where the project lives in ARM, so Cortex can create project
     * connections itself: one per MCP server (carrying the APIM key) and one
     * to Azure AI Search. Without these the agent → MCP call has no key and
     * API Management answers 401.
     */
    accountName: env.FOUNDRY_ACCOUNT_NAME || '',
    projectName: env.FOUNDRY_PROJECT_NAME || '',
    resourceGroup: env.FOUNDRY_RESOURCE_GROUP || '',
    /** Name of the project connection to Azure AI Search (authType AAD). */
    searchConnection: env.FOUNDRY_SEARCH_CONNECTION || 'cortex-search',
    /** How many MCP approval rounds Cortex will answer on the user's behalf in one turn. */
    maxApprovalRounds: Number(env.FOUNDRY_MAX_APPROVAL_ROUNDS || 6),
    timeoutMs: Number(env.FOUNDRY_TIMEOUT_MS || 30_000),
    /** A model answer takes longer than a listing. Bounded all the same. */
    responseTimeoutMs: Number(env.FOUNDRY_RESPONSE_TIMEOUT_MS || 90_000)
  },

  ask: {
    /** The Foundry agent that answers the Ask page. Created on first use. */
    agentName: env.ASK_AGENT_NAME || 'cortex-ask',
    /**
     * Attach the Cortex Purview MCP server to the Ask agent as a tool, so the
     * model can look the catalogue up itself. Off by default: the answer is
     * grounded by passing the reachable entries inline, which is faster and has
     * one failure mode fewer in front of an audience. Turn on to demonstrate an
     * agent calling the catalogue live.
     */
    usePurviewMcp: bool(env.ASK_USE_PURVIEW_MCP, false)
  },

  /**
   * Azure AI Search — one index per data product, built from the files the
   * Data Map scanned. The Foundry agent reads it through the azure_ai_search
   * tool, so an answer can cite the underlying rows.
   */
  search: {
    endpoint: env.SEARCH_ENDPOINT || (env.SEARCH_SERVICE_NAME ? `https://${env.SEARCH_SERVICE_NAME}.search.windows.net` : ''),
    serviceName: env.SEARCH_SERVICE_NAME || '',
    apiVersion: env.SEARCH_API_VERSION || '2024-07-01',
    scope: 'https://search.azure.com/.default',
    /** simple | semantic | vector | vector_simple_hybrid | vector_semantic_hybrid. Keyword by default: no embedding model needed. */
    queryType: env.SEARCH_QUERY_TYPE || 'simple',
    knowledgeModelName: env.SEARCH_KNOWLEDGE_MODEL_NAME || '',
    knowledgeModelEndpoint: env.SEARCH_KNOWLEDGE_MODEL_ENDPOINT || '',
    topK: Number(env.SEARCH_TOP_K || 5),
    indexPrefix: env.SEARCH_INDEX_PREFIX || 'cortex-',
    timeoutMs: Number(env.SEARCH_TIMEOUT_MS || 30_000)
  },

  /**
   * The sample-data storage account (ADLS Gen2). Bootstrap writes one folder
   * per data product here; the Data Map scans it and AI Search indexes it.
   */
  data: {
    storageAccount: env.DATA_STORAGE_ACCOUNT || '',
    container: env.DATA_CONTAINER || 'products',
    resourceGroup: env.DATA_RESOURCE_GROUP || env.CORTEX_RESOURCE_GROUP || '',
    scope: 'https://storage.azure.com/.default'
  },

  /**
   * Where application state is written. A blob account (STATE_STORAGE_ACCOUNT,
   * read and written with the managed identity — the deployed shape), or a
   * directory (CORTEX_STATE_DIR, local development), or neither = memory only.
   */
  state: {
    dir: env.CORTEX_STATE_DIR || '',
    blobAccount: env.STATE_STORAGE_ACCOUNT || '',
    blobContainer: env.STATE_CONTAINER || 'state',
    scope: 'https://storage.azure.com/.default',
    /** How long startup waits for the state blobs before serving with memory state. */
    primeTimeoutMs: Number(env.STATE_PRIME_TIMEOUT_MS || 20_000)
  },

  /**
   * Who may chat with an agent. `all-staff` (the default for this phase) lets
   * every signed-in person open a chat with every agent. `visibility` applies
   * the same rules as the Marketplace: only agents you could attach.
   */
  chat: {
    policy: env.CORTEX_CHAT_POLICY || 'all-staff',
    maxTurns: Number(env.CORTEX_CHAT_MAX_TURNS || 40)
  },

  /** Automations: propose-only, run by a timer inside the web app. */
  automations: {
    enabled: !/^(0|false|no|off)$/i.test(String(env.CORTEX_AUTOMATIONS || 'true')),
    tickSeconds: Number(env.CORTEX_AUTOMATION_TICK_SECONDS || 60),
    maxRunsKept: Number(env.CORTEX_AUTOMATION_HISTORY || 30)
  },

  /**
   * GLUE 1 — the Cortex Purview MCP server.
   * There is no official Purview MCP server and no Purview knowledge source
   * inside Foundry agents, so a data product is reached through this.
   */
  purviewMcpUrl: env.PURVIEW_MCP_URL || '',

  /** Public base URL of this app. APIM calls back to it. */
  publicBaseUrl: env.PUBLIC_BASE_URL || '',

  appInsightsConnectionString: env.APPLICATIONINSIGHTS_CONNECTION_STRING || '',

  entra: {
    clientId: env.ENTRA_CLIENT_ID || '',
    clientSecret: env.ENTRA_CLIENT_SECRET || '',
    tenantId: env.ENTRA_TENANT_ID || '',
    /**
     * Entra emits group OBJECT IDs. Access rules read far better against
     * names, so this maps one to the other.
     *   CORTEX_GROUP_NAMES="<guid>=waste-crime,<guid>=all-staff"
     */
    groupNames: parseGroupNames(env.CORTEX_GROUP_NAMES),
    /**
     * Groups every signed-in person is treated as holding, on top of Entra.
     * Default `all-staff`: a signed-in user is a member of staff. Set to an
     * empty string for strict mode, where only Entra groups count.
     */
    defaultGroups: parseDefaultGroups(env.CORTEX_DEFAULT_GROUPS),
    /**
     * Allow running without platform authentication in front of the app —
     * for local development against real Azure back ends, where there is no
     * Easy Auth to inject the headers. NEVER set this in a deployed
     * environment: it makes every page render as a fixed local identity.
     */
    allowUnauthenticated: bool(env.ALLOW_UNAUTHENTICATED, false),
    localUser: env.LOCAL_DEV_USER || '',
    localGroups: (env.LOCAL_DEV_GROUPS || '').split(',').filter(Boolean)
  },

  keyVault: {
    name: env.KEYVAULT_NAME || env.KEYVAULT_URI || '',
    hydrated: false,
    report: [],
    errors: []
  },

  index: {
    refreshMinutes: Number(env.INDEX_REFRESH_MINUTES || 15),
    /** Fail fast on an empty register rather than showing an empty marketplace silently. */
    warnIfEmpty: bool(env.INDEX_WARN_IF_EMPTY, true)
  },

  /** Input to the bootstrap script. Not a runtime data source. */
  bootstrapDir: env.BOOTSTRAP_DIR || 'bootstrap'
};

/**
 * Read configuration from Key Vault and overlay it onto `config`.
 * Never throws. A vault that is unreachable leaves environment values in place
 * and records the failure.
 */
export async function hydrateConfig({ vault = config.keyVault.name, env: e = env } = {}) {
  const { resolved, report, errors } = await resolveSecrets(vault, e);

  for (const entry of SECRET_CATALOGUE) {
    const value = resolved[entry.secret];
    if (value !== undefined && value !== null && value !== '') {
      setPath(config, entry.path, value);
    }
  }

  config.keyVault.hydrated = true;
  config.keyVault.report = report;
  config.keyVault.errors = errors;
  return config;
}

/** Required values still missing after hydration. */
export function missingRequired() {
  return config.keyVault.report.filter((r) => r.required && !r.present).map((r) => r.secret);
}

export default config;
