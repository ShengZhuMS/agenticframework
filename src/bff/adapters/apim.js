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

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import { getToken } from './token.js';

const ARM = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';

/* ------------------------------------------------------------------ seeded */

class SeededApim {
  constructor(seedDir) {
    this.seedDir = seedDir;
    this.name = 'apim:seeded';
  }

  async _entries() {
    if (!this._cache) {
      const raw = await readFile(path.join(this.seedDir, 'entries.json'), 'utf8');
      this._cache = JSON.parse(raw);
    }
    return this._cache;
  }

  async listMcpServers() {
    const all = await this._entries();
    return all
      .filter((e) => e._endpoints?.mcp)
      .map((e) => ({
        id: e.id,
        name: e.name,
        displayName: e.name,
        description: e.desc,
        path: `${e.id}-mcp`,
        url: e._endpoints.mcp,
        type: 'mcp',
        tools: (e.tools || [{ name: e.id.replace(/-/g, '_'), description: e.desc }]),
        cat: e.cat
      }));
  }

  async listApis() {
    const all = await this._entries();
    return all.filter((e) => e.cat === 'Skill' || e.cat === 'App');
  }

  /** In seeded mode publishing is recorded in the index, not in Azure. */
  async importOpenApi({ id, displayName, description, path }) {
    return { id, displayName, description, path, simulated: true };
  }

  async createMcpServer({ id, displayName, description }) {
    return {
      id,
      displayName,
      description,
      path: id,
      url: `https://apim-cortex.azure-api.net/${id}/mcp`,
      type: 'mcp',
      simulated: true
    };
  }

  async addTool(mcpServerId, { toolId, displayName, description }) {
    return { id: toolId, displayName, description, mcpServerId, simulated: true };
  }

  async health() {
    const s = await this.listMcpServers();
    return { ok: true, mode: 'seeded', mcpServers: s.length };
  }
}

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
  return config.adapters.apim === 'live'
    ? new LiveApim(config.apim)
    : new SeededApim(config.seedDir);
}

export { SeededApim, LiveApim };
