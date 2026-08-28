/**
 * API Management adapter — MCP servers and APIs.
 *
 * VERIFIED API NOTES (August 2026):
 *   MCP server support is GA (Ignite, 25 Nov 2025), but the MANAGEMENT
 *   api-version is still preview: pin 2025-09-01-preview.
 *
 *   MCP servers are NOT a distinct resource type. They are APIs with
 *   properties.type === 'mcp'. So listing them is:
 *       GET {base}/apis?$filter=type eq 'mcp'
 *
 *   Tools are a child resource, and properties.operationId is a FULL ARM
 *   resource ID, not a short operation name.
 *
 *   Creation is asynchronous — poll the Azure-AsyncOperation header.
 *   Deletes require If-Match: * or return 412.
 *   Not supported in APIM workspaces. Consumption tier not supported.
 */

import config from '../config.js';
import { getToken } from './token.js';

const ARM = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';

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

  async _fetch(pathname, { method = 'GET', body, query = {}, headers = {} } = {}) {
    const url = new URL(this.base + pathname);
    url.searchParams.set('api-version', this.cfg.apiVersion);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const token = await getToken(ARM_SCOPE);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`APIM ${method} ${pathname} failed ${res.status}: ${text.slice(0, 400)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  /** MCP servers are APIs with type 'mcp'. */
  async listMcpServers() {
    const res = await this._fetch('/apis', { query: { $filter: "type eq 'mcp'" } });
    return (res.value || []).map((a) => ({
      id: a.name,
      name: a.properties?.displayName,
      displayName: a.properties?.displayName,
      description: a.properties?.description,
      path: a.properties?.path,
      // Read the URL from the resource. Do NOT construct it — the -mcp
      // suffix is a portal naming default, not a guaranteed rule.
      url: a.properties?.serviceUrl || null,
      type: 'mcp'
    }));
  }

  async listApis() {
    const res = await this._fetch('/apis', { query: { $top: 200 } });
    return (res.value || [])
      .filter((a) => a.properties?.type !== 'mcp')
      .map((a) => ({
        id: a.name,
        name: a.properties?.displayName,
        description: a.properties?.description,
        path: a.properties?.path
      }));
  }

  async listTools(mcpServerId) {
    const res = await this._fetch(`/apis/${mcpServerId}/tools`);
    return (res.value || []).map((t) => ({
      id: t.name,
      displayName: t.properties?.displayName,
      description: t.properties?.description,
      operationId: t.properties?.operationId
    }));
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
   * Create an MCP server. Idempotent by design — the demo will be
   * rehearsed repeatedly, so a PUT over an existing id must update
   * rather than fail.
   *
   * Note MCP servers are NOT a distinct resource type: they are APIs with
   * properties.type === 'mcp'.
   */
  async createMcpServer({ id, displayName, description, subscriptionRequired = true }) {
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
          subscriptionRequired
        }
      }
    });
    await this._waitForProvisioning(id);
    const created = await this._fetch(`/apis/${id}`);
    return {
      id,
      displayName,
      // Read the URL from the resource rather than constructing it — the
      // -mcp suffix is a portal naming default, not a guaranteed rule.
      url: created?.properties?.serviceUrl || `${this.cfg.gatewayUrl}/${created?.properties?.path || id}/mcp`,
      type: 'mcp'
    };
  }

  /**
   * Add a tool to an MCP server.
   *
   * properties.operationId is a FULL ARM RESOURCE ID pointing at the backing
   * REST operation, not a short operation name. Getting this wrong is the
   * most common failure here.
   */
  async addTool(mcpServerId, { toolId, displayName, description, backingApiId, backingOperationId, operationId }) {
    const opId =
      operationId ||
      `/subscriptions/${this.cfg.subscriptionId}` +
        `/resourceGroups/${this.cfg.resourceGroup}` +
        `/providers/Microsoft.ApiManagement/service/${this.cfg.serviceName}` +
        `/apis/${backingApiId}/operations/${backingOperationId}`;

    return this._fetch(`/apis/${mcpServerId}/tools/${toolId}`, {
      method: 'PUT',
      headers: { 'If-Match': '*' },
      body: { properties: { displayName, description, operationId: opId } }
    });
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
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
      const cur = await this._fetch(`/apis/${id}`).catch(() => null);
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
