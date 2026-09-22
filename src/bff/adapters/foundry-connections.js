/**
 * Foundry project connections — how an agent is allowed to call something.
 *
 * THE BUG THIS FIXES
 * An agent built in Cortex was given an APIM MCP server as a tool, and the
 * first test question failed with
 *   "Authentication failed when connecting to the MCP server … 401 Access
 *    denied due to missing subscription key".
 * API Management requires Ocp-Apim-Subscription-Key on every call to a
 * Cortex-published MCP server, and Foundry refuses to carry a raw header on
 * an MCP tool definition. The documented route is a PROJECT CONNECTION of
 * category RemoteTool with CustomKeys credentials; the tool then names the
 * connection through project_connection_id and Agent Service adds the key.
 *
 * ONE CONNECTION PER MCP SERVER. When the connection's target and the tool's
 * server_url differ, Foundry uses the connection's target — so a single
 * shared connection would send every tool call to the same server. Each
 * published MCP server therefore gets its own connection, named from its
 * API Management id, created idempotently whenever an agent is built or an
 * agent is published. Bootstrap creates them for the skills too.
 *
 * Connections are ARM resources:
 *   PUT https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}
 *       /providers/Microsoft.CognitiveServices/accounts/{account}
 *       /projects/{project}/connections/{name}?api-version=2025-06-01
 * The Cortex identity holds Foundry Project Manager on the account for this
 * (infra/modules/foundry-existing.bicep) — that role carries
 * Microsoft.CognitiveServices/accounts/projects/* and nothing wider.
 *
 * The same mechanism connects the project to Azure AI Search (category
 * CognitiveSearch, authType AAD) for the azure_ai_search tool.
 */

import { createHash } from 'node:crypto';
import config from '../config.js';
import { getToken } from './token.js';

const ARM = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';
const API_VERSION = '2025-06-01';

/** Built rather than written as one literal — see foundry.js. */
const bearer = (token) => ['Bearer', token].join(' ');

/**
 * A connection name must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{2,32}$ — 33
 * characters at most. APIM ids can be longer, so the name is a prefix, the
 * start of the id and a short hash of the whole id: readable in the portal,
 * unique, and stable across runs.
 */
export function connectionNameFor(apiId, prefix = 'cx-mcp-') {
  const clean = String(apiId).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const hash = createHash('sha1').update(String(apiId)).digest('hex').slice(0, 5);
  const room = 33 - prefix.length - 1 - hash.length;
  return `${prefix}${clean.slice(0, room).replace(/-+$/, '')}-${hash}`;
}

export function projectArmId(cfg = config) {
  const f = cfg.foundry;
  const sub = cfg.apim.subscriptionId;
  if (!sub || !f.resourceGroup || !f.accountName || !f.projectName) return null;
  return (
    `/subscriptions/${sub}/resourceGroups/${f.resourceGroup}` +
    `/providers/Microsoft.CognitiveServices/accounts/${f.accountName}/projects/${f.projectName}`
  );
}

export function connectionArmId(name, cfg = config) {
  const project = projectArmId(cfg);
  return project ? `${project}/connections/${name}` : null;
}

/** True when the configuration knows where the project lives in ARM. */
export function connectionsConfigured(cfg = config) {
  return Boolean(projectArmId(cfg));
}

/**
 * The value a tool definition carries in project_connection_id for a named
 * connection. The full resource id by default (FOUNDRY_CONNECTION_REF=id) —
 * the same form the azure_ai_search tool has always used here and the form
 * the SDK's connection.id returns — or the bare name (=name). The first
 * round of this fix wrote the bare name for MCP tools while the search tool
 * carried the id; one of the two forms is what Foundry resolves, and the
 * switch makes the other a one-line change rather than a rebuild.
 */
export function connectionRef(name, cfg = config) {
  if (!name) return undefined;
  if ((cfg.foundry.connectionRef || 'id') === 'name') return name;
  return connectionArmId(name, cfg) || name;
}

async function armFetch(pathname, { method = 'GET', body, timeoutMs, apiVersion = API_VERSION } = {}) {
  const url = `${ARM}${pathname}?api-version=${apiVersion}`;
  const token = await getToken(ARM_SCOPE);
  const res = await fetch(url, {
    method,
    headers: { Authorization: bearer(token), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs || config.foundry.timeoutMs || 30_000)
  });
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Foundry connection ${method} ${pathname.split('/').pop()} failed ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function getConnection(name) {
  const id = connectionArmId(name);
  if (!id) return null;
  return armFetch(id);
}

/**
 * Make sure a RemoteTool connection exists for one MCP server, carrying the
 * APIM subscription key. Returns { name, id, created }.
 *
 * Idempotent: an existing connection with the same target is left alone. A
 * different target or a rotated key is written over — the PUT is a full
 * replace and the credential is never read back, so "same" can only be
 * judged on the target.
 */
export async function ensureMcpConnection({ apiId, target, key = config.apim.subscriptionKey, name }) {
  const originalName = name || connectionNameFor(apiId);
  for (let generation = 0; generation < 5; generation++) {
    const connName = generation ? connectionNameFor(`${originalName}:${generation}`, 'cx-r-') : originalName;
    try {
      return await ensureNamedMcpConnection({ apiId, target, key, connName });
    } catch (err) {
      if (!/failed 400:/.test(err.message) || !/secret.*deleted state.*purge protection/i.test(err.message)) throw err;
      if (generation === 4) throw new Error(`Foundry connection names remain purge-protected after five attempts: ${originalName}`, { cause: err });
      console.warn(`[foundry] ${connName} has a purge-protected deleted secret; trying a stable replacement name.`);
    }
  }
}

async function ensureNamedMcpConnection({ apiId, target, key, connName }) {
  const id = connectionArmId(connName);
  if (!id) throw new Error('Foundry project location is not configured (FOUNDRY_ACCOUNT_NAME / FOUNDRY_PROJECT_NAME / FOUNDRY_RESOURCE_GROUP).');
  if (!key) throw new Error('No API Management subscription key is configured, so the connection cannot carry one.');

  const existing = await getConnection(connName);
  if (existing && existing.properties?.target === target && existing.properties?.authType === 'CustomKeys') {
    return { name: connName, id, created: false };
  }
  await armFetch(id, {
    method: 'PUT',
    body: {
      properties: {
        category: 'RemoteTool',
        authType: 'CustomKeys',
        target,
        isSharedToAll: true,
        useWorkspaceManagedIdentity: false,
        credentials: { keys: { 'Ocp-Apim-Subscription-Key': key } },
        metadata: { type: 'custom_MCP', createdBy: 'cortex', apiId: String(apiId) }
      }
    }
  });
  return { name: connName, id, created: !existing };
}

/**
 * The project's connection to Azure AI Search — keyless. The Foundry
 * ACCOUNT's system-assigned identity holds Search Index Data Contributor and
 * Search Service Contributor on the service (infra/modules/search.bicep).
 */
export async function ensureSearchConnection({ target = config.search.endpoint, name = config.foundry.searchConnection } = {}) {
  const id = connectionArmId(name);
  if (!id) throw new Error('Foundry project location is not configured.');
  if (!target) throw new Error('No Azure AI Search endpoint is configured.');
  const existing = await getConnection(name);
  if (existing && existing.properties?.target === target && existing.properties?.authType === 'AAD') {
    return { name, id, created: false };
  }
  await armFetch(id, {
    method: 'PUT',
    body: {
      properties: {
        category: 'CognitiveSearch',
        authType: 'AAD',
        target,
        isSharedToAll: true,
        metadata: { ApiType: 'Azure', createdBy: 'cortex' }
      }
    }
  });
  return { name, id, created: !existing };
}

export async function listConnections() {
  const project = projectArmId();
  if (!project) return [];
  const res = await armFetch(`${project}/connections`);
  return res?.value || [];
}

export async function ensureKnowledgeConnection({ name, target }) {
  const id = connectionArmId(name);
  if (!id) throw new Error('Foundry project location is not configured.');
  const allowed = new URL(config.search.endpoint);
  const url = new URL(target);
  if (url.origin !== allowed.origin || !url.pathname.startsWith('/knowledgebases/')) throw new Error('Knowledge connection must target the configured Search service.');
  await armFetch(id, {
    method: 'PUT', apiVersion: '2025-10-01-preview',
    body: { properties: { category: 'RemoteTool', authType: 'ProjectManagedIdentity',
      target, audience: 'https://search.azure.com/', isSharedToAll: true, metadata: { ApiType: 'Azure', createdBy: 'cortex' } } }
  });
  return { name, id };
}
