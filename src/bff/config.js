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
import { parseGroupNames } from './services/identity.js';

const env = process.env;

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}

export const config = {
  port: Number(env.PORT || 3000),
  nodeEnv: env.NODE_ENV || 'development',

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
    model: env.FOUNDRY_MODEL || 'gpt-5-mini',
    /**
     * Project connection of kind 'remote-tool' carrying the APIM subscription
     * key, so an agent can call an APIM MCP server.
     */
    mcpConnection: env.FOUNDRY_MCP_CONNECTION || ''
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
