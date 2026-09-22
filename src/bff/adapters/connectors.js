import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getToken } from './token.js';
import { randomUUID } from 'node:crypto';
import { invokeStudio, probeStudio } from './studio.js';

export function connectors() {
  const values = JSON.parse(process.env.CORTEX_CONNECTORS || '[]');
  if (!Array.isArray(values)) throw new Error('CORTEX_CONNECTORS must be a JSON array.');
  const ids = new Set();
  for (const c of values) {
    if (!/^[a-z0-9-]{1,50}$/.test(c.id) || ids.has(c.id)) throw new Error('Connector IDs must be unique lowercase identifiers.');
    ids.add(c.id);
    const url = new URL(c.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`Connector ${c.id} needs a credential-free HTTPS base URL.`);
    if (!['databricks', 'fabric', 'm365', 'openapi'].includes(c.provider)) throw new Error(`Unsupported connector provider: ${c.provider}`);
  }
  return values;
}

export function connectorById(id) {
  const c = connectors().find((c) => c.id === id);
  if (!c) throw new Error('Select an administrator-configured connector. Arbitrary credential-bearing endpoints are not accepted.');
  return c;
}

export function connectorUrl(c, relative = '') {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('#')) throw new Error('Invalid connector path.');
  const base = new URL(c.baseUrl.replace(/\/$/, '') + '/');
  const url = new URL(relative.replace(/^\//, ''), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password) throw new Error('The request must remain inside the configured connector.');
  return url;
}

export async function connectorHeaders(c) {
  if (c.secretEnv && !/^[A-Z][A-Z0-9_]+$/.test(c.secretEnv)) throw new Error('Invalid connector secret reference.');
  const secret = c.secretEnv ? process.env[c.secretEnv] : null;
  if (c.secretEnv && !secret) throw new Error(`Connector ${c.id} requires its configured secret.`);
  if (c.auth === 'header') {
    if (!/^[A-Za-z][A-Za-z0-9-]+$/.test(c.header || '')) throw new Error('Invalid connector authentication header.');
    return { [c.header]: secret };
  }
  if (c.auth === 'bearer-secret') {
    if (!secret) throw new Error(`Connector ${c.id} requires a bearer secret reference.`);
    return { Authorization: ['Bearer', secret].join(' ') };
  }
  if (c.auth === 'anonymous') return {};
  let token;
  if (c.clientId) {
    if (!/^[0-9a-f-]{36}$/i.test(c.tenantId || '') || !/^[0-9a-f-]{36}$/i.test(c.clientId)) throw new Error('Connector service principal identifiers are invalid.');
    const response = await fetch(`https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      body: new URLSearchParams({ client_id: c.clientId, client_secret: secret, grant_type: 'client_credentials', scope: c.scope })
    });
    if (!response.ok) throw new Error(`Connector ${c.id} authentication failed (${response.status}). Check its service principal and consent.`);
    const value = await response.json();
    if (!value.access_token) throw new Error('The connector token response contained no access token.');
    token = value.access_token;
  } else {
    if (!c.scope) throw new Error(`Connector ${c.id} requires an OAuth scope.`);
    token = await getToken(c.scope);
  }
  return { Authorization: ['Bearer', token].join(' ') };
}

export async function connectorRequest(c, relative, { method = 'GET', body } = {}) {
  const response = await fetch(connectorUrl(c, relative), {
    method, redirect: 'error', signal: AbortSignal.timeout(90000),
    headers: { ...await connectorHeaders(c), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    let code = '';
    try { const value = JSON.parse(text); code = value.errorCode || value.error?.code || ''; } catch { /* Non-JSON errors still retain their HTTP status. */ }
    code = /^[A-Za-z0-9_.-]{1,100}$/.test(code) ? ` (${code})` : '';
    throw new Error(`${c.provider} connector returned HTTP ${response.status}${code}. Check source availability, permissions and the declared API contract.`);
  }
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('Connector response exceeds the 1 MiB limit.');
  return text ? JSON.parse(text) : null;
}

export const probeConnector = (c, sourceId) => invokeConnector(c, sourceId, undefined, { probe: true });

export async function invokeConnector(c, sourceId, question, { probe = false } = {}) {
  if (c.provider === 'databricks') {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(sourceId)) throw new Error('Invalid Databricks serving endpoint name.');
    if (probe) {
      const endpoint = await connectorRequest(c, `api/2.0/serving-endpoints/${encodeURIComponent(sourceId)}`);
      if (endpoint?.name !== sourceId || endpoint.state?.ready !== 'READY') throw new Error('The selected Databricks endpoint is not ready.');
      return { ready: true, provider: c.provider };
    }
    const result = await connectorRequest(c, `serving-endpoints/${encodeURIComponent(sourceId)}/invocations`, {
      method: 'POST', body: { messages: [{ role: 'user', content: question }], max_tokens: 1024 }
    });
    const content = result.choices?.[0]?.message?.content ||
      result.output?.flatMap((o) => (o.content || []).filter((v) => v.type === 'output_text').map((v) => v.text)).join('\n');
    const text = Array.isArray(content) ? content.filter((part) => ['text', 'output_text'].includes(part.type)).map((part) => part.text).join('\n') : content;
    if (!text) throw new Error('The Databricks endpoint returned no supported chat answer.');
    return { answer: text, provider: c.provider, source: sourceId };
  }
  if (c.provider === 'fabric') {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(sourceId)) throw new Error('Fabric source must be workspace-id/data-agent-id.');
    const [workspace, agent] = sourceId.split('/');
    const client = new Client({ name: 'data-cortex', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(connectorUrl(c, `v1/mcp/workspaces/${workspace}/dataagents/${agent}/agent`), {
      requestInit: { headers: await connectorHeaders(c), redirect: 'error' }
    });
    try {
      await client.connect(transport, { timeout: 30000 });
      const result = await client.listTools({}, { timeout: 30000 });
      if (result.tools.length !== 1) throw new Error('Expected the Fabric data agent to expose exactly one question tool.');
      const tool = result.tools[0];
      const properties = tool.inputSchema.properties || {};
      const args = Object.keys(properties).filter((k) => properties[k]?.type === 'string');
      if (args.length !== 1) throw new Error('Unsupported Fabric question schema; configure a reviewed adapter.');
      if (probe) return { ready: true, provider: c.provider };
      const response = await client.callTool({ name: tool.name, arguments: { [args[0]]: question } }, undefined, { timeout: 180000 });
      if (response.isError) throw new Error('Fabric reported a tool error. Check the data agent and underlying data permissions.');
      const text = response.content?.filter((v) => v.type === 'text').map((v) => v.text).join('\n');
      if (!text) throw new Error('Fabric returned no answer.');
      return { answer: text, provider: c.provider, source: sourceId };
    } finally { await client.close(); }
  }
  if (c.provider === 'm365') {
    if (!c.agentId || c.agentId !== sourceId) throw new Error('The Microsoft 365 source does not match its configured channel identity.');
    if (c.protocol === 'direct-engine') {
      const options = { headers: await connectorHeaders(c) };
      if (probe) { await probeStudio(c, options); return { ready: true, provider: c.provider }; }
      return invokeStudio(c, question, options);
    }
    // Copilot Studio agents must expose a published, authenticated Direct Line channel.
    const conversation = await connectorRequest(c, 'v3/directline/conversations', { method: 'POST', body: {} });
    if (!conversation?.conversationId) throw new Error('The Microsoft 365 agent channel returned no conversation.');
    if (probe) return { ready: true, provider: c.provider };
    const path = `v3/directline/conversations/${encodeURIComponent(conversation.conversationId)}/activities`;
    const sent = await connectorRequest(c, path, { method: 'POST', body: { type: 'message', from: { id: `cortex-${randomUUID()}` }, text: question } });
    const deadline = Date.now() + 90000;
    let watermark;
    while (Date.now() < deadline) {
      const page = await connectorRequest(c, path + (watermark ? `?watermark=${encodeURIComponent(watermark)}` : ''));
      const answer = page.activities?.filter((a) => a.type === 'message' && a.from?.role === 'bot' && (!a.replyToId || a.replyToId === sent.id)).map((a) => a.text || '').join('\n');
      if (answer) return { answer, provider: c.provider, source: sourceId };
      watermark = page.watermark;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error('The Microsoft 365 agent did not answer before the channel deadline.');
  }
  throw new Error('This connector is not an agent conversation provider.');
}
