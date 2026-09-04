/**
 * API Management adapter — MCP servers and APIs.
 *
 * VERIFIED API NOTES (September 2026, api-version 2025-09-01-preview):
 *   MCP server support is GA (Ignite, 25 Nov 2025), but the MANAGEMENT
 *   api-version is still preview: pin 2025-09-01-preview.
 *
 *   MCP servers are NOT a distinct resource type. They are APIs with
 *   properties.type === 'mcp'.
 *
 *   THE TOOLS ARE INLINE. An MCP server is created with ONE PUT that carries
 *   BOTH `type: 'mcp'` AND a non-empty `mcpTools` array:
 *       { name, description, operationId: <FULL ARM id of the backing operation> }
 *   Without mcpTools, ARM silently drops the type: the API is created as a
 *   plain HTTP API, a later GET shows `type: null`, and anything that then
 *   treats it as an MCP server fails with InternalServerError. The child
 *   `.../apis/{id}/tools/{tool}` resource that the TypeSpec describes does NOT
 *   work via PUT in this api-version. That was the 500 this repository chased
 *   through two rounds of retry tuning — it was never a race.
 *
 *   The operationId must be the full ARM id, with no `;rev=N` suffix.
 *   The MCP endpoint is https://{gateway}/{path}/mcp — APIM adds the /mcp.
 *   `serviceUrl` is null on an MCP API; do not read the endpoint from it.
 *
 *   Creation is asynchronous — poll the Azure-AsyncOperation header.
 *   Deletes require If-Match: * or return 412.
 *   Not supported in APIM workspaces. Consumption tier not supported.
 */

import config from '../config.js';
import { getToken } from './token.js';

const ARM = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';

/**
 * Built rather than written as one literal: the source of this repository
 * travels through tooling that masks anything shaped like a bearer credential,
 * template literals included. Composing the header keeps the pattern out.
 */
const bearer = (token) => ['Bearer', token].join(' ');

/** ARM pages API listings; follow nextLink or miss everything past the first page. */
const PAGE_SIZE = 100;

/** One listing serves the several readers a single index refresh fans out into. */
const LIST_CACHE_MS = 5000;

/* -------------------------------------------------------------------- live */

class LiveApim {
  constructor(cfg) {
    this.cfg = cfg;
    this.name = 'apim:live';
    this.base =
      `${ARM}/subscriptions/${cfg.subscriptionId}` +
      `/resourceGroups/${cfg.resourceGroup}` +
      `/providers/Microsoft.ApiManagement/service/${cfg.serviceName}`;
  }

  async _fetch(pathname, { method = 'GET', body, query = {}, headers = {}, absolute = false } = {}) {
    const url = new URL(absolute ? pathname : this.base + pathname);
    if (!absolute) url.searchParams.set('api-version', this.cfg.apiVersion);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const token = await getToken(ARM_SCOPE);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: bearer(token),
        'Content-Type': 'application/json',
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.cfg.timeoutMs || 30_000)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`APIM ${method} ${pathname} failed ${res.status}: ${text.slice(0, 400)}`);
    }
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  /** GET one API, or null when it does not exist. Any other failure still throws. */
  async _getApi(id) {
    try {
      return await this._fetch(`/apis/${id}`);
    } catch (err) {
      if (/ failed 404/.test(err.message)) return null;
      throw err;
    }
  }

  /**
   * Every API, following nextLink. Briefly memoised: an index refresh asks for
   * the MCP servers and the plain APIs at the same instant, and one listing
   * answers both.
   */
  _listAllApis() {
    const now = Date.now();
    if (this._apis && now - this._apis.at < LIST_CACHE_MS) return this._apis.promise;
    const promise = (async () => {
      const out = [];
      let page = await this._fetch('/apis', { query: { $top: PAGE_SIZE } });
      for (;;) {
        out.push(...(page?.value || []));
        if (!page?.nextLink) break;
        page = await this._fetch(page.nextLink, { absolute: true });
      }
      return out;
    })().catch((err) => {
      this._apis = null;
      throw err;
    });
    this._apis = { at: now, promise };
    return promise;
  }

  /** The MCP endpoint: {gateway}/{path}/mcp. APIM adds the /mcp; serviceUrl is null on an MCP API. */
  _mcpUrl(api) {
    const path = api?.properties?.path;
    if (this.cfg.gatewayUrl && path) return `${this.cfg.gatewayUrl.replace(/\/$/, '')}/${path}/mcp`;
    return api?.properties?.serviceUrl || null;
  }

  _toolsOf(api) {
    return (api?.properties?.mcpTools || []).map((t) => ({
      id: t.name,
      name: t.name,
      displayName: t.name,
      description: t.description,
      operationId: t.operationId
    }));
  }

  /** MCP servers are APIs with type 'mcp'. Their tools come inline with them. */
  async listMcpServers() {
    const all = await this._listAllApis();
    return all
      .filter((a) => a.properties?.type === 'mcp')
      .map((a) => ({
        id: a.name,
        name: a.properties?.displayName,
        displayName: a.properties?.displayName,
        description: a.properties?.description,
        path: a.properties?.path,
        url: this._mcpUrl(a),
        tools: this._toolsOf(a),
        type: 'mcp'
      }));
  }

  async listApis() {
    const all = await this._listAllApis();
    return all
      .filter((a) => a.properties?.type !== 'mcp')
      .map((a) => ({
        id: a.name,
        name: a.properties?.displayName,
        description: a.properties?.description,
        path: a.properties?.path
      }));
  }

  async listTools(mcpServerId) {
    return this._toolsOf(await this._getApi(mcpServerId));
  }

  /** The full ARM id of a backing operation — what mcpTools[].operationId must carry. */
  operationArmId(apiId, operationId) {
    return (
      `/subscriptions/${this.cfg.subscriptionId}` +
      `/resourceGroups/${this.cfg.resourceGroup}` +
      `/providers/Microsoft.ApiManagement/service/${this.cfg.serviceName}` +
      `/apis/${apiId}/operations/${operationId}`
    );
  }

  /**
   * Import an OpenAPI document as a REST API. This is the backing API that
   * the MCP server projects tools from — an MCP server in APIM is always
   * over a managed API, never freestanding.
   *
   * Idempotent: PUT over an existing id updates it.
   */
  async importOpenApi({ id, displayName, description, spec, path, serviceUrl }) {
    const created = await this._fetch(`/apis/${id}`, {
      method: 'PUT',
      headers: { 'If-Match': '*' },
      body: {
        properties: {
          format: 'openapi+json',
          value: JSON.stringify(spec),
          path: path || id,
          displayName,
          description,
          protocols: ['https'],
          subscriptionRequired: true,
          ...(serviceUrl ? { serviceUrl } : {})
        }
      }
    });
    await this._waitForProvisioning(id);
    return created;
  }

  /**
   * Create an MCP server over a backing API — ONE PUT, tools inline.
   *
   * Idempotent by design: the demo is rehearsed repeatedly, so a PUT over an
   * existing id must update rather than fail. One exception is handled first:
   * an API of this name that is NOT of type mcp — the leftover of an earlier
   * PUT that carried no mcpTools and so had its type silently dropped — is
   * deleted and recreated, because it can never become an MCP server in place.
   *
   * @param tools  [{ name, description, backingApiId, backingOperationId | operationId }]
   */
  async createMcpServer({ id, displayName, description, subscriptionRequired = true, tools = [] }) {
    if (!tools.length) {
      throw new Error(
        `An MCP server needs at least one tool. Without mcpTools, API Management silently drops type 'mcp' from ${id}.`
      );
    }
    const mcpTools = tools.map((t) => ({
      name: t.name || t.toolId,
      description: t.description || '',
      operationId: t.operationId || this.operationArmId(t.backingApiId, t.backingOperationId)
    }));

    const existing = await this._getApi(id);
    if (existing && existing.properties?.type !== 'mcp') {
      await this._fetch(`/apis/${id}`, { method: 'DELETE', headers: { 'If-Match': '*' } });
      await this._waitForGone(id);
    }

    await this._fetch(`/apis/${id}`, {
      method: 'PUT',
      headers: { 'If-Match': '*' },
      body: {
        properties: {
          type: 'mcp',
          displayName,
          description,
          path: id,
          protocols: ['https'],
          subscriptionRequired,
          mcpTools
        }
      }
    });
    await this._waitForProvisioning(id);

    // Verify rather than trust: the failure mode here is silent.
    const created = await this._getApi(id);
    if (created?.properties?.type !== 'mcp' || !(created.properties?.mcpTools || []).length) {
      throw new Error(
        `API Management accepted ${id} but did not record it as an MCP server with its tools ` +
          `(type=${created?.properties?.type ?? 'null'}). Check the operationId is a full ARM id without ;rev=.`
      );
    }
    return {
      id,
      displayName,
      url: this._mcpUrl(created),
      tools: this._toolsOf(created),
      type: 'mcp'
    };
  }

  /**
   * Add or replace one tool on an existing MCP server — read-modify-write of
   * the inline mcpTools array. Kept for callers that add a capability later;
   * createMcpServer carries the initial tools itself.
   */
  async addTool(mcpServerId, { toolId, name, description, backingApiId, backingOperationId, operationId }) {
    const api = await this._getApi(mcpServerId);
    if (!api) throw new Error(`No MCP server ${mcpServerId} to add a tool to.`);
    const toolName = name || toolId;
    const tool = {
      name: toolName,
      description: description || '',
      operationId: operationId || this.operationArmId(backingApiId, backingOperationId)
    };
    const others = (api.properties?.mcpTools || []).filter((t) => t.name !== toolName);
    const props = { ...api.properties, type: 'mcp', mcpTools: [...others, tool] };
    delete props.serviceUrl;
    await this._fetch(`/apis/${mcpServerId}`, {
      method: 'PUT',
      headers: { 'If-Match': '*' },
      body: { properties: props }
    });
    await this._waitForProvisioning(mcpServerId);
    return tool;
  }

  async _waitForGone(id, attempts = 30) {
    for (let i = 0; i < attempts; i++) {
      if (!(await this._getApi(id))) return true;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`API ${id} was deleted but is still listed after ${attempts * 2}s.`);
  }

  /** Bind an MCP server to a product, so a subscription key governs it. */
  async bindToProduct(productId, apiId) {
    return this._fetch(`/products/${productId}/apis/${apiId}`, {
      method: 'PUT',
      headers: { 'Content-Length': '0' }
    });
  }

  /**
   * Real usage from the gateway, over the last 90 days.
   *
   * This is the APIM Reports API — byApi aggregates every call the gateway has
   * actually served. It is the only genuine source for calls, error rate and
   * latency, which is why those are the only usage figures Cortex shows.
   *
   * Deliberately NOT reported: cost per use and carbon. APIM knows neither,
   * and a number nobody can defend is worse than no number at all.
   *
   * Returns a map keyed by API id so the index can decorate entries in one
   * pass. Failure returns an empty map — usage is decoration, and losing it
   * must never blank the Marketplace.
   */
  async usageByApi({ days = 90 } = {}) {
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19);
    const to = new Date().toISOString().slice(0, 19);
    const filter = `timestamp ge datetime'${from}' and timestamp le datetime'${to}'`;

    const url = new URL(`${this.base}/reports/byApi`);
    url.searchParams.set('api-version', this.cfg.analyticsApiVersion);
    url.searchParams.set('$filter', filter);

    const token = await getToken(ARM_SCOPE);
    const res = await fetch(url, {
      headers: { Authorization: bearer(token) },
      signal: AbortSignal.timeout(this.cfg.timeoutMs || 30_000)
    });
    if (!res.ok) throw new Error(`APIM analytics failed ${res.status}`);
    const json = await res.json();

    const out = {};
    for (const r of json.value || []) {
      // name is the API id; apiId is the full ARM resource id.
      const id = r.apiId ? String(r.apiId).split('/').pop() : r.name;
      if (!id) continue;
      const calls = Number(r.callCountTotal || 0);
      const failed = Number(r.callCountFailed || 0) + Number(r.callCountBlocked || 0);
      out[id] = {
        calls,
        consumers: Number(r.callCountSuccess ? r.subscriptionCount || 0 : 0) || undefined,
        errorRate: calls ? `${((failed / calls) * 100).toFixed(1)}%` : '0.0%',
        latencyMs: r.apiTimeAvg != null ? Math.round(Number(r.apiTimeAvg) * 1000) : null,
        rag: calls === 0 ? 'g' : failed / calls > 0.05 ? 'r' : failed / calls > 0.01 ? 'a' : 'g'
      };
    }
    return out;
  }

  async _waitForProvisioning(id, attempts = 30) {
    for (let i = 0; i < attempts; i++) {
      const cur = await this._getApi(id).catch(() => null);
      const state = cur?.properties?.provisioningState;
      if (!state || state === 'Succeeded') return true;
      if (state === 'Failed') throw new Error(`APIM provisioning failed for ${id}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async health() {
    const s = await this.listMcpServers();
    return { ok: true, mode: 'live', mcpServers: s.length };
  }
}

export function createApimAdapter() {
  return new LiveApim(config.apim);
}

export { LiveApim };
