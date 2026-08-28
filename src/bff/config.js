/**
 * Configuration. Every integration is independently switchable between the
 * seeded and live adapter, so the UI can be finished and rehearsed while
 * Azure provisioning is still running — and so a single failing back end
 * never takes the demo down.
 *
 * ENDPOINTS AND KEYS COME FROM AZURE KEY VAULT.
 * Set KEYVAULT_NAME (or KEYVAULT_URI) and the app reads its configuration
 * from the vault at startup, falling back to environment variables for local
 * development and as a safety net. See adapters/keyvault.js for the catalogue
 * of secret names.
 *
 * The object below is the shape and the defaults. hydrateConfig() overlays
 * the vault on top of it before the server starts listening, and mutates in
 * place so that every existing synchronous `config.x.y` reader keeps working.
 */

import { resolveSecrets, setPath, SECRET_CATALOGUE } from './adapters/keyvault.js';

const env = process.env;

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}

export const config = {
  port: Number(env.PORT || 3000),
  nodeEnv: env.NODE_ENV || 'development',

  /**
   * DEMO_MODE pins every adapter to seeded data. One switch, no external
   * calls, runs on a hostile venue network. Set this for the first CTO demo.
   */
  demoMode: bool(env.DEMO_MODE, true),

  /** Show the persona switcher. Always on in demo mode. */
  personaSwitcher: bool(env.PERSONA_SWITCHER, true),

  adapters: {
    purview: env.ADAPTER_PURVIEW || 'seeded',
    apim: env.ADAPTER_APIM || 'seeded',
    foundry: env.ADAPTER_FOUNDRY || 'seeded',
    entra: env.ADAPTER_ENTRA || 'seeded'
  },

  purview: {
    // NOT the account-scoped host — that form is legacy.
    endpoint: env.PURVIEW_ENDPOINT || 'https://api.purview-service.microsoft.com',
    apiVersion: env.PURVIEW_API_VERSION || '2026-03-20-preview',
    scope: 'https://purview.azure.net/.default',
    dataMapEndpoint: env.PURVIEW_DATAMAP_ENDPOINT || '',
    dataMapApiVersion: env.PURVIEW_DATAMAP_API_VERSION || '2023-09-01'
  },

  apim: {
    subscriptionId: env.AZURE_SUBSCRIPTION_ID || '',
    resourceGroup: env.AZURE_RESOURCE_GROUP || '',
    serviceName: env.APIM_SERVICE_NAME || '',
    // MCP server management requires this preview api-version even though
    // the feature itself is GA. Pin it.
    apiVersion: env.APIM_API_VERSION || '2025-09-01-preview',
    gatewayUrl: env.APIM_GATEWAY_URL || '',
    subscriptionKey: env.APIM_SUBSCRIPTION_KEY || ''
  },

  foundry: {
    // https://<resource>.services.ai.azure.com/api/projects/<project>
    projectEndpoint: env.FOUNDRY_PROJECT_ENDPOINT || '',
    apiVersion: 'v1',
    scope: 'https://ai.azure.com/.default',
    model: env.FOUNDRY_MODEL || 'gpt-5-mini',
    /**
     * A project connection of kind 'remote-tool' carrying the APIM
     * subscription key, so Foundry can call an APIM MCP server:
     *   azd ai connection create cortex-apim --kind remote-tool \
     *     --target <mcp-url> --auth-type custom-keys \
     *     --custom-key "Ocp-Apim-Subscription-Key=<key>"
     */
    mcpConnection: env.FOUNDRY_MCP_CONNECTION || ''
  },

  /**
   * GLUE 1 — the Cortex Purview MCP server.
   * There is no official Purview MCP server and no Purview knowledge source
   * inside Foundry agents, so a data product is reached through this.
   */
  purviewMcpUrl: env.PURVIEW_MCP_URL || '',

  /** Public base URL of this app, used when generating the OpenAPI servers block. */
  publicBaseUrl: env.PUBLIC_BASE_URL || '',

  /** Cosmos DB endpoint for the Cortex Index. Auth is managed identity — no key. */
  cosmosEndpoint: env.COSMOS_ENDPOINT || '',

  /** Contains an instrumentation key, so it is treated as a credential. */
  appInsightsConnectionString: env.APPLICATIONINSIGHTS_CONNECTION_STRING || '',

  entra: {
    clientId: env.ENTRA_CLIENT_ID || '',
    clientSecret: env.ENTRA_CLIENT_SECRET || '',
    tenantId: env.ENTRA_TENANT_ID || ''
  },

  keyVault: {
    /** Vault name (cortex-kv) or full URI (https://cortex-kv.vault.azure.net). */
    name: env.KEYVAULT_NAME || env.KEYVAULT_URI || '',
    hydrated: false,
    /** Per-secret record of what resolved and from where. Never holds a credential value. */
    report: [],
    errors: []
  },

  index: {
    refreshMinutes: Number(env.INDEX_REFRESH_MINUTES || 15),
    store: env.INDEX_STORE || 'memory'
  },

  seedDir: env.SEED_DIR || 'seed'
};

/** In demo mode nothing is live, whatever the individual adapter settings say. */
if (config.demoMode) {
  for (const k of Object.keys(config.adapters)) config.adapters[k] = 'seeded';
  config.personaSwitcher = true;
}

/**
 * Read configuration from Key Vault and overlay it onto `config`.
 *
 * Call once, before the server listens. Safe to call when no vault is
 * configured — it then simply records that everything came from the
 * environment.
 *
 * Never throws. A vault that is unreachable leaves the environment values in
 * place and records the failure, because a demo that boots on stale
 * configuration is better than one that does not boot at all.
 */
export async function hydrateConfig({ vault = config.keyVault.name, env: e = env } = {}) {
  // Demo mode makes no external calls at all — including to Key Vault.
  if (config.demoMode) {
    config.keyVault.hydrated = true;
    config.keyVault.report = [];
    return config;
  }

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

/**
 * Which required values are still missing after hydration. Used by the health
 * endpoint and printed at startup so a misconfiguration is visible before
 * somebody clicks something and gets a confusing failure.
 */
export function missingRequired() {
  return config.keyVault.report.filter((r) => r.required && !r.present).map((r) => r.secret);
}

export default config;
