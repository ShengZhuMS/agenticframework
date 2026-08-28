/**
 * Configuration. Every integration is independently switchable between the
 * seeded and live adapter, so the UI can be finished and rehearsed while
 * Azure provisioning is still running — and so a single failing back end
 * never takes the demo down.
 */

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

export default config;
