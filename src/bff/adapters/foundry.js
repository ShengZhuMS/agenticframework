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

/**
 * Built rather than written as one literal: the source of this repository
 * travels through tooling that masks anything shaped like a bearer credential,
 * template literals included. Composing the header keeps the pattern out.
 */
const bearer = (token) => ['Bearer', token].join(' ');

/* -------------------------------------------------------------------- live */

class LiveFoundry {
  constructor(cfg) {
    this.cfg = cfg;
    this.name = 'foundry:live';
  }

  async _fetch(pathname, { method = 'GET', body, apiVersion = true, timeoutMs } = {}) {
    const url = new URL(this.cfg.projectEndpoint + pathname);
    if (apiVersion) url.searchParams.set('api-version', this.cfg.apiVersion);
    const token = await getToken(this.cfg.scope);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: bearer(token),
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      // fetch() has no default timeout. A model call is allowed longer than a
      // listing, but neither may hang a page forever.
      signal: AbortSignal.timeout(timeoutMs || this.cfg.timeoutMs || 30_000)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Foundry ${method} ${pathname} failed ${res.status}: ${text.slice(0, 400)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  /**
   * The approved model catalogue.
   *
   * This is a governance list, not a discovery call: it states which models
   * Defra has approved for use, which is a policy decision rather than
   * something the platform can be asked. A model present in Foundry but not
   * here is deliberately not offered.
   */
  async listModels() {
    // Only deployments that exist can be offered. The list used to include a
    // hard-coded 'gpt-5' that was never deployed to this project, so choosing
    // it passed validation and then failed when the agent was created.
    const deployed = [this.cfg.model, ...(this.cfg.extraModels || [])].filter(Boolean);
    const approved = [...new Set(deployed)].map((id, i) => ({
      id,
      name: i === 0 ? 'First-party, small and fast' : 'First-party, general',
      approved: true,
      note:
        i === 0
          ? 'Approved catalogue. Deployed in this Foundry project. Good default for summarise-and-cite work.'
          : 'Approved catalogue. Deployed in this Foundry project.'
    }));
    return [
      ...approved,
      {
        id: 'third-party-review',
        name: 'Third-party model',
        approved: false,
        note: 'Needs review before use. The model catalogue approval gate applies.'
      }
    ];
  }

  /**
   * Make sure a named agent exists with this definition.
   *
   * Agents are versioned by name, and every create of an existing name adds a
   * version. So: read first, and reuse the agent when its model and
   * instructions already match (or when the service does not show them —
   * churning a version on every restart is worse than a stale instruction).
   * Create only when it is absent or visibly different. To force a fresh
   * definition, change ASK_AGENT_NAME or delete the agent in the portal.
   */
  async ensureAgent({ name, model, instructions, tools = [] }) {
    // getAgent swallows a 404 into null; anything without a name is not an agent.
    const found = await this.getAgent(name);
    const existing = found?.name ? found : null;
    if (existing) {
      const def = existing.definition || existing.versions?.[0]?.definition || null;
      const same =
        !def ||
        ((def.instructions === undefined || def.instructions === instructions) &&
          (def.model === undefined || def.model === model));
      if (same) return { agent: existing, created: false };
    }
    try {
      const created = await this.createAgent({ name, model, instructions, tools });
      return { agent: created, created: true };
    } catch (err) {
      if (existing) return { agent: existing, created: false, warning: err.message };
      throw err;
    }
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

  /**
   * One turn. Continuity comes from `previous_response_id` — the service keeps
   * the history server-side, so a follow-up carries the whole thread without
   * this app storing any of it.
   */
  async respond({ agentName, input, conversationId, previousResponseId }) {
    const body = {
      input,
      agent_reference: { name: agentName, type: 'agent_reference' }
    };
    if (conversationId) body.conversation = conversationId;
    if (previousResponseId) body.previous_response_id = previousResponseId;
    const res = await this._fetch('/openai/v1/responses', {
      method: 'POST',
      body,
      apiVersion: false,
      timeoutMs: this.cfg.responseTimeoutMs || 90_000
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
      headers: { Authorization: bearer(token), 'Content-Type': 'application/json' },
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
    // Only message items carry the answer; tool-call items sit alongside them.
    const messages = items.filter((i) => !i?.type || i.type === 'message');
    const text =
      res?.output_text ||
      messages
        .flatMap((i) => (i?.content || []).map((c) => c?.text).filter(Boolean))
        .join('\n');
    const annotations = messages.flatMap((i) => (i?.content || []).flatMap((c) => c?.annotations || []));
    return {
      text,
      responseId: res?.id || null,
      model: res?.model || null,
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
  return new LiveFoundry(config.foundry);
}

export { LiveFoundry };
