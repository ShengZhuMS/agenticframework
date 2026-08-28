/**
 * Azure Key Vault — the source of truth for endpoints and keys.
 *
 * Zero dependency: the Key Vault data plane is a plain REST API, and the
 * managed identity already in token.js is the only credential needed. No
 * client secret, no connection string, nothing to rotate in the app itself.
 *
 *   GET https://<vault>.vault.azure.net/secrets/<name>?api-version=7.4
 *   Authorization: Bearer <token for https://vault.azure.net/.default>
 *
 * DESIGN NOTES
 *
 * 1. Key Vault wins, environment is the fallback. If you have onboarded a
 *    value to the vault, that is the value the app uses. An environment
 *    variable is a local-development convenience and a safety net, never a
 *    silent override of what operations put in the vault.
 *
 * 2. A vault that is unreachable must not stop the app. Every lookup falls
 *    back to the environment and records the failure. Cortex then runs on
 *    whatever it has — seeded data at worst — rather than failing to boot in
 *    front of an audience.
 *
 * 3. Secret names are NOT environment variable names. Key Vault permits only
 *    letters, digits and hyphens (`^[0-9a-zA-Z-]+$`), so FOUNDRY_PROJECT_ENDPOINT
 *    becomes `foundry-project-endpoint`. The mapping is explicit below rather
 *    than derived, so the list of secrets to create is readable and fixed.
 *
 * 4. Values are cached with a TTL so a rotated secret is picked up without a
 *    restart, and so a page load never waits on the vault.
 *
 * 5. Secret VALUES are never logged, never returned by a health endpoint, and
 *    never rendered. Only names and whether they resolved.
 */

import { getToken } from './token.js';

const KV_SCOPE = 'https://vault.azure.net/.default';
const KV_API_VERSION = '7.4';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Timeouts. These are not tuning — they are the difference between a container
 * that starts and one that never becomes ready.
 *
 * fetch() has no default timeout, so an unreachable vault hangs forever. A
 * container app whose startup awaits that hang never passes its readiness
 * probe, never serves, and never falls back to seeded data — the exact
 * opposite of what the fallback exists for.
 *
 * PER_REQUEST bounds one secret. TOTAL bounds the whole hydration, so even a
 * pathological vault costs a fixed, small delay at boot.
 */
const PER_REQUEST_TIMEOUT_MS = Number(process.env.KEYVAULT_TIMEOUT_MS || 5000);
const TOTAL_HYDRATION_BUDGET_MS = Number(process.env.KEYVAULT_BUDGET_MS || 15000);

/** Resolve to `fallback` if `promise` has not settled within `ms`. */
function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The secret catalogue.
 *
 * `secret`  — the name to create in Key Vault
 * `env`     — the environment variable used when the vault has no value
 * `sensitive` — true for anything that grants access. False entries are
 *               configuration that is merely centralised here; they are not
 *               secret and would be safe in plain configuration.
 * `required` — whether a live (non-demo) deployment needs it.
 */
export const SECRET_CATALOGUE = [
  {
    secret: 'azure-subscription-id',
    env: 'AZURE_SUBSCRIPTION_ID',
    path: 'apim.subscriptionId',
    sensitive: false,
    required: true,
    description: 'Subscription holding APIM and Foundry. Used to build ARM resource IDs.'
  },
  {
    secret: 'azure-resource-group',
    env: 'AZURE_RESOURCE_GROUP',
    path: 'apim.resourceGroup',
    sensitive: false,
    required: true,
    description: 'Resource group holding APIM. Used to build ARM resource IDs.'
  },
  {
    secret: 'apim-service-name',
    env: 'APIM_SERVICE_NAME',
    path: 'apim.serviceName',
    sensitive: false,
    required: true,
    description: 'API Management instance name, e.g. apim-cortex-poc.'
  },
  {
    secret: 'apim-gateway-url',
    env: 'APIM_GATEWAY_URL',
    path: 'apim.gatewayUrl',
    sensitive: false,
    required: true,
    description: 'APIM gateway base URL, e.g. https://apim-cortex.azure-api.net.'
  },
  {
    secret: 'apim-subscription-key',
    env: 'APIM_SUBSCRIPTION_KEY',
    path: 'apim.subscriptionKey',
    sensitive: true,
    required: true,
    description:
      'APIM subscription key for the Cortex product. The one genuine secret in the set — it is a bearer credential for every published MCP server.'
  },
  {
    secret: 'foundry-project-endpoint',
    env: 'FOUNDRY_PROJECT_ENDPOINT',
    path: 'foundry.projectEndpoint',
    sensitive: false,
    required: true,
    description:
      'https://<resource>.services.ai.azure.com/api/projects/<project> — note the services.ai.azure.com host, not the legacy form.'
  },
  {
    secret: 'foundry-model',
    env: 'FOUNDRY_MODEL',
    path: 'foundry.model',
    sensitive: false,
    required: false,
    description: 'Deployed model name, e.g. gpt-5-mini. Defaults to gpt-5-mini.'
  },
  {
    secret: 'foundry-mcp-connection',
    env: 'FOUNDRY_MCP_CONNECTION',
    path: 'foundry.mcpConnection',
    sensitive: false,
    required: false,
    description:
      'Id of the Foundry project connection (kind remote-tool) that carries the APIM subscription key, so an agent can call an APIM MCP server.'
  },
  {
    secret: 'purview-endpoint',
    env: 'PURVIEW_ENDPOINT',
    path: 'purview.endpoint',
    sensitive: false,
    required: false,
    description:
      'Unified Catalog endpoint. Defaults to https://api.purview-service.microsoft.com — override only for a private endpoint.'
  },
  {
    secret: 'purview-datamap-endpoint',
    env: 'PURVIEW_DATAMAP_ENDPOINT',
    path: 'purview.dataMapEndpoint',
    sensitive: false,
    required: false,
    description:
      'Data Map base URL. The host and path prefix vary by portal generation, so this is runtime configuration rather than a constant.'
  },
  {
    secret: 'purview-mcp-url',
    env: 'PURVIEW_MCP_URL',
    path: 'purviewMcpUrl',
    sensitive: false,
    required: true,
    description:
      'The Cortex Purview MCP server (Glue 1), e.g. https://cortex-purview-mcp.<region>.azurecontainerapps.io/mcp.'
  },
  {
    secret: 'public-base-url',
    env: 'PUBLIC_BASE_URL',
    path: 'publicBaseUrl',
    sensitive: false,
    required: true,
    description:
      'Public URL of this app. APIM calls back to it, so the generated OpenAPI must carry a reachable address.'
  },
  {
    secret: 'appinsights-connection-string',
    env: 'APPLICATIONINSIGHTS_CONNECTION_STRING',
    path: 'appInsightsConnectionString',
    sensitive: true,
    required: false,
    description:
      'Application Insights connection string. Contains an instrumentation key, so treat it as a credential.'
  },
  {
    secret: 'entra-client-id',
    env: 'ENTRA_CLIENT_ID',
    path: 'entra.clientId',
    sensitive: false,
    required: false,
    description: 'App registration used for user sign-in. Not needed while running with the persona switcher.'
  },
  {
    secret: 'entra-client-secret',
    env: 'ENTRA_CLIENT_SECRET',
    path: 'entra.clientSecret',
    sensitive: true,
    required: false,
    description:
      'Client secret for the sign-in app registration. Prefer federated credentials so this can be omitted entirely.'
  },
  {
    secret: 'entra-tenant-id',
    env: 'ENTRA_TENANT_ID',
    path: 'entra.tenantId',
    sensitive: false,
    required: false,
    description: 'Tenant id for sign-in and for the validate-azure-ad-token policy in APIM.'
  }
];

/** Values that are safe to print in a log line or a health payload. */
const NON_SENSITIVE = new Set(SECRET_CATALOGUE.filter((s) => !s.sensitive).map((s) => s.secret));

export class KeyVault {
  /**
   * @param {string} vault  vault name or full https URI
   * @param {object} opts   { ttlMs }
   */
  constructor(vault, { ttlMs = DEFAULT_TTL_MS } = {}) {
    this.uri = normaliseVaultUri(vault);
    this.ttlMs = ttlMs;
    this.cache = new Map();
    this.errors = [];
    this.enabled = Boolean(this.uri);
  }

  /**
   * Read one secret. Returns null when the vault has no such secret, which is
   * a normal condition — the caller falls back to the environment.
   */
  async get(name) {
    if (!this.enabled) return null;

    const hit = this.cache.get(name);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;

    try {
      // Bound token acquisition too: the managed identity endpoint can be slow
      // to fail, and the Azure CLI fallback shells out to a process that may
      // not exist in the container at all.
      const token = await withTimeout(getToken(KV_SCOPE), PER_REQUEST_TIMEOUT_MS, null);
      if (!token) throw new Error(`No token for Key Vault within ${PER_REQUEST_TIMEOUT_MS}ms`);

      const url = `${this.uri}/secrets/${encodeURIComponent(name)}?api-version=${KV_API_VERSION}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS)
      });

      if (res.status === 404) {
        this.cache.set(name, { value: null, at: Date.now() });
        return null;
      }
      if (res.status === 403) {
        // Almost always a missing role assignment rather than a missing secret,
        // so say which role, because the message is what a person acts on.
        throw new Error(
          'Access denied. The app identity needs the "Key Vault Secrets User" role on the vault.'
        );
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();
      const value = json?.value ?? null;
      this.cache.set(name, { value, at: Date.now() });
      return value;
    } catch (err) {
      // Record and continue. A vault problem degrades to environment values.
      this.errors.push({ name, message: err.message, at: new Date().toISOString() });
      return null;
    }
  }

  /** Read many secrets concurrently. */
  async getMany(names) {
    const out = {};
    await Promise.all(
      names.map(async (n) => {
        out[n] = await this.get(n);
      })
    );
    return out;
  }

  clearCache() {
    this.cache.clear();
  }

  /**
   * Health, safe to expose. Reports which secrets resolved and from where,
   * and the VALUE of non-sensitive entries only — an endpoint URL is useful
   * to see, an APIM key never is.
   */
  status() {
    return {
      enabled: this.enabled,
      vault: this.uri || null,
      cached: this.cache.size,
      errors: this.errors.slice(-5)
    };
  }
}

export function normaliseVaultUri(vault) {
  if (!vault) return '';
  const v = String(vault).trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}.vault.azure.net`;
}

/**
 * Resolve every catalogued value, Key Vault first and environment second, and
 * return both the values and a per-secret record of where each came from.
 *
 * Never throws. A vault that is entirely unavailable yields an all-environment
 * result and a populated `errors` array.
 */
export async function resolveSecrets(vault, env = process.env) {
  const kv = new KeyVault(vault);
  const resolved = {};
  const report = [];

  // Hard budget for the whole read. Whatever has not arrived by then is
  // treated as absent and filled from the environment. Startup must not be
  // hostage to a vault having a bad day.
  const fromVault = kv.enabled
    ? await withTimeout(
        kv.getMany(SECRET_CATALOGUE.map((s) => s.secret)),
        TOTAL_HYDRATION_BUDGET_MS,
        {}
      )
    : {};

  if (kv.enabled && Object.keys(fromVault).length === 0 && kv.errors.length === 0) {
    kv.errors.push({
      name: '(all)',
      message: `Key Vault did not respond within ${TOTAL_HYDRATION_BUDGET_MS}ms. Using environment values.`,
      at: new Date().toISOString()
    });
  }

  for (const entry of SECRET_CATALOGUE) {
    const vaultValue = fromVault[entry.secret];
    const envValue = env[entry.env];

    let value = null;
    let source = 'unset';
    if (vaultValue !== null && vaultValue !== undefined && vaultValue !== '') {
      value = vaultValue;
      source = 'keyvault';
    } else if (envValue !== undefined && envValue !== '') {
      value = envValue;
      source = 'environment';
    }

    if (value !== null) resolved[entry.secret] = value;
    report.push({
      secret: entry.secret,
      env: entry.env,
      source,
      sensitive: entry.sensitive,
      required: entry.required,
      // Show the value only where it is not a credential, so a health page is
      // genuinely useful for diagnosing a wrong endpoint.
      value: value && NON_SENSITIVE.has(entry.secret) ? value : undefined,
      present: value !== null
    });
  }

  return { kv, resolved, report, errors: kv.errors };
}

/** Set a dotted path on an object, creating intermediate objects. */
export function setPath(target, path, value) {
  const parts = path.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

export default KeyVault;
