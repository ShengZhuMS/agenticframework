/**
 * Microsoft Foundry Agent Service adapter.
 *
 * VERIFIED API NOTES (August 2026) — this surface was rewritten, and older
 * samples will not work:
 *
 *   endpoint   https://<resource>.services.ai.azure.com/api/projects/<project>
 *   version    api-version=v1   (a literal string, not a date)
 *   scope      https://ai.azure.com/.default
 *
 *   Threads / messages / runs are GONE. The model is now:
 *       agents + conversations + responses   (an OpenAI Responses API superset)
 *
 *   Agents are identified by NAME + VERSION. There is no GUID agent id.
 *
 *   Agent CRUD lives at  {ENDPOINT}/agents?api-version=v1
 *   Conversations and responses live at  {ENDPOINT}/openai/v1/...  (no api-version)
 *
 *   RBAC: use Foundry User / Foundry Project Manager / Foundry Agent Consumer.
 *   Do NOT use 'Azure AI Developer' — it targets ML workspaces and hubs and
 *   will fail against a Foundry project.
 *
 *   SECURITY: treat MCP tool descriptions and results as untrusted input.
 *   Indirect prompt injection through retrieved content is the live risk and
 *   is one of the seven assurance gates.
 */

import config from '../config.js';
import { getToken } from './token.js';

/* ------------------------------------------------------------------ seeded */

class SeededFoundry {
  constructor() {
    this.name = 'foundry:seeded';
    this.agents = new Map();
  }

  async listModels() {
    return [
      {
        id: 'gpt-5-mini',
        name: 'First-party, small and fast',
        approved: true,
        note: 'Approved catalogue. Good default for summarise-and-cite work.'
      },
      {
        id: 'gpt-5',
        name: 'First-party, general',
        approved: true,
        note: 'Approved catalogue. Slower and dearer; use where reasoning matters.'
      },
      {
        id: 'third-party-review',
        name: 'Third-party model',
        approved: false,
        note: 'Needs review before use. Model catalogue approval gate applies.'
      }
    ];
  }

  async createAgent({ name, model, instructions, tools = [] }) {
    const agent = {
      name,
      version: (this.agents.get(name)?.version || 0) + 1,
      model,
      instructions,
      tools,
      createdAt: new Date().toISOString(),
      simulated: true
    };
    this.agents.set(name, agent);
    return agent;
  }

  async getAgent(name) {
    return this.agents.get(name) || null;
  }

  async listAgents() {
    return [...this.agents.values()];
  }

  async createConversation() {
    return { id: `conv_seeded_${Date.now()}` };
  }

  /**
   * A seeded response that demonstrates the provenance panel honestly:
   * it names its sources, states freshness, and says what it could not reach.
   */
  async respond({ agentName, input }) {
    const agent = this.agents.get(agentName);
    const knowledge = (agent?.tools || [])
      .filter((t) => t.type === 'knowledge')
      .map((t) => t.name);
    return {
      text:
        `Based on the sources this agent can reach, here is what I can tell you about "${input}".\n\n` +
        `This is a seeded response — the app is running with DEMO_MODE on, so no ` +
        `model was called. With the live adapter this answer comes from Foundry, ` +
        `streamed, with url_citation annotations driving the panel below.`,
      sources: knowledge.map((k) => ({ name: k, freshness: 'Daily', used: 'Summary statistics only' })),
      confidence: 'Medium',
      couldNotReach: ['Permit history lookup — you have not requested access to it yet'],
      simulated: true
    };
  }

  async health() {
    return { ok: true, mode: 'seeded', model: config.foundry.model, agents: this.agents.size };
  }
}

/* -------------------------------------------------------------------- live */

class LiveFoundry {
  constructor(cfg) {
    this.cfg = cfg;
    this.name = 'foundry:live';
  }

  async _fetch(pathname, { method = 'GET', body, apiVersion = true } = {}) {
    const url = new URL(this.cfg.projectEndpoint + pathname);
    if (apiVersion) url.searchParams.set('api-version', this.cfg.apiVersion);
    const token = await getToken(this.cfg.scope);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Foundry ${method} ${pathname} failed ${res.status}: ${text.slice(0, 400)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async listModels() {
    return new SeededFoundry().listModels();
  }

  /**
   * Create an agent. The tools array carries MCP tool definitions in the
   * documented shape:
   *   { type: 'mcp', server_label, server_url, require_approval,
   *     allowed_tools, project_connection_id }
   */
  async createAgent({ name, model, instructions, tools = [] }) {
    return this._fetch('/agents', {
      method: 'POST',
      body: {
        name,
        definition: {
          kind: 'prompt',
          model: model || this.cfg.model,
          instructions,
          tools: tools.filter((t) => t.type === 'mcp' || t.type === 'openapi' || t.type === 'function')
        }
      }
    });
  }

  async getAgent(name) {
    return this._fetch(`/agents/${name}`).catch(() => null);
  }

  async listAgents() {
    const res = await this._fetch('/agents');
    return res?.value || res?.data || [];
  }

  /** Conversations live on the /openai/v1 sub-route with no api-version. */
  async createConversation() {
    return this._fetch('/openai/v1/conversations', { method: 'POST', body: {}, apiVersion: false });
  }

  async respond({ agentName, input, conversationId }) {
    const body = {
      input,
      agent_reference: { name: agentName, type: 'agent_reference' }
    };
    if (conversationId) body.conversation = conversationId;
    const res = await this._fetch('/openai/v1/responses', {
      method: 'POST',
      body,
      apiVersion: false
    });
    return this._toAnswer(res);
  }

  /**
   * Stream a response. The events that matter for the provenance panel are
   * response.output_text.delta, response.output_item.done (which carries
   * url_citation annotations), and response.completed.
   */
  async *stream({ agentName, input, conversationId }) {
    const url = new URL(this.cfg.projectEndpoint + '/openai/v1/responses');
    const token = await getToken(this.cfg.scope);
    const body = {
      input,
      stream: true,
      agent_reference: { name: agentName, type: 'agent_reference' }
    };
    if (conversationId) body.conversation = conversationId;

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok || !res.body) throw new Error(`Foundry stream failed ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload);
        } catch {
          /* partial frame — ignore */
        }
      }
    }
  }

  _toAnswer(res) {
    const items = res?.output || [];
    const text = res?.output_text || items.map((i) => i?.content?.[0]?.text).filter(Boolean).join('\n');
    const annotations = items.flatMap((i) => i?.content?.[i.content.length - 1]?.annotations || []);
    return {
      text,
      sources: annotations
        .filter((a) => a.type === 'url_citation')
        .map((a) => ({ name: a.title || a.url, url: a.url })),
      confidence: null,
      couldNotReach: []
    };
  }

  async health() {
    if (!this.cfg.projectEndpoint) return { ok: false, mode: 'live', error: 'No project endpoint configured' };
    const started = Date.now();
    await this.listAgents();
    return { ok: true, mode: 'live', model: this.cfg.model, latencyMs: Date.now() - started };
  }
}

export function createFoundryAdapter() {
  return config.adapters.foundry === 'live'
    ? new LiveFoundry(config.foundry)
    : new SeededFoundry();
}

export { SeededFoundry, LiveFoundry };
