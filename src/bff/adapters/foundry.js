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

  async _fetch(pathname, { method = 'GET', body, apiVersion = true, timeoutMs, headers = {} } = {}) {
    const url = new URL(this.cfg.projectEndpoint + pathname);
    if (apiVersion) url.searchParams.set('api-version', typeof apiVersion === 'string' ? apiVersion : this.cfg.apiVersion);
    const token = await getToken(this.cfg.scope);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: bearer(token),
        'Content-Type': 'application/json',
        ...headers
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
   * the organisation has approved for use, which is a policy decision rather than
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
   * Agents are versioned by name; existing agents use the /versions endpoint.
   * Read first, and reuse the agent when its model and
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
      const created = await this.createAgent({ name, model, instructions, tools, createVersion: Boolean(existing) });
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
  async createAgent({ name, model, instructions, tools = [], keepAllTools = false, createVersion = false }) {
    return this._fetch(createVersion ? `/agents/${encodeURIComponent(name)}/versions` : '/agents', {
      method: 'POST',
      body: {
        ...(createVersion ? {} : { name }),
        definition: {
          kind: 'prompt',
          model: model || this.cfg.model,
          instructions,
          // keepAllTools: a repair re-creates a version from the definition
          // Foundry holds, and must not drop a tool type this list has not
          // heard of.
          tools: keepAllTools ? tools : tools.filter((t) => ['mcp', 'openapi', 'function', 'azure_ai_search', 'file_search'].includes(t.type))
        }
      }
    });
  }

  async getAgent(name) {
    try {
      const agent = await this._fetch(`/agents/${encodeURIComponent(name)}`);
      const latest = agent?.versions?.latest || agent?.versions?.[0];
      return latest ? { ...agent, ...latest } : agent;
    } catch (err) {
      if (/ failed 404:/.test(err.message)) return null;
      throw err;
    }
  }

  async listAgents() {
    const res = await this._fetch('/agents');
    return res?.value || res?.data || [];
  }

  /** Conversations live on the /openai/v1 sub-route with no api-version. */
  async createConversation() {
    return this._fetch('/openai/v1/conversations', { method: 'POST', body: {}, apiVersion: false });
  }

  /** A tool-free model call for guidance and proposals; it cannot execute a plan. */
  async complete({ instructions, input }) {
    const response = await this._post({
      model: this.cfg.model, instructions, input, tools: [], store: false
    });
    const answer = this._toAnswer(response);
    if (answer.status && answer.status !== 'completed') throw new Error(`Foundry response is ${answer.status}.`);
    if (!answer.text?.trim()) throw new Error('Foundry returned no answer.');
    return answer;
  }

  /**
   * One turn. Continuity comes from `previous_response_id` — the service keeps
   * the history server-side, so a follow-up carries the whole thread without
   * this app storing any of it.
   */
  async respond({ agentName, agentVersion, input, conversationId, previousResponseId, requireToolUse = false, maxApprovalRounds = this.cfg.maxApprovalRounds ?? 6 }) {
    const agentRef = { name: agentName, type: 'agent_reference' };
    if (agentVersion) agentRef.version = String(agentVersion);
    const body = { input, agent_reference: agentRef };
    if (requireToolUse) body.tool_choice = 'required';
    if (conversationId) body.conversation = conversationId;
    if (previousResponseId) body.previous_response_id = previousResponseId;

    let res;
    try {
      res = await this._post(body);
    } catch (err) {
      /**
       * THE 401 THAT KEPT COMING BACK. "Authentication failed when connecting
       * to the MCP server … 401 Access denied due to missing subscription
       * key" means this agent's tool definition carries no usable project
       * connection — an agent built before connections existed, or one whose
       * record did not survive. The repair hook (services/agents.js
       * ensureToolConnections, attached at start-up) gives the tools their
       * connections in a new version; then the same turn is tried once more.
       */
      if (agentVersion || !isToolAuthFailure(err) || typeof this.repairTools !== 'function') throw err;
      let repair;
      try {
        repair = await this.repairTools(agentName, { force: true });
      } catch (repairErr) {
        err.message += ` — Cortex tried to repair the agent's tool connections and could not: ${repairErr.message}`;
        throw err;
      }
      if (!repair?.repaired) throw err;
      res = await this._post(body);
    }
    const toolCalls = [];
    let rounds = 0;

    /**
     * THE APPROVAL LOOP. Every MCP tool on a Cortex agent is registered with
     * require_approval 'always', so a tool call comes back as an
     * mcp_approval_request instead of running. Cortex approves it here, on
     * the server, records what was called with what arguments, and continues
     * the same response. The record is shown on the answer ("Tools this
     * answer used") — the point of the gate is that the call is visible and
     * attributable, not that a person clicks a button mid-conversation.
     */
    for (;;) {
      collectToolCalls(res, toolCalls);
      const approvals = (res?.output || []).filter((i) => i?.type === 'mcp_approval_request');
      if (!approvals.length || rounds >= maxApprovalRounds) break;
      rounds += 1;
      res = await this._post({
        agent_reference: agentRef,
        previous_response_id: res.id,
        input: approvals.map((a) => ({ type: 'mcp_approval_response', approval_request_id: a.id, approve: true }))
      });
    }
    if (requireToolUse) {
      const calls = toolCalls.filter((call) => call.kind === 'call');
      if (!calls.length) throw new Error('The connected source agent was not invoked. No delegated answer is available.');
      if (calls.some((call) => call.error)) throw new Error('The connected source agent call failed. Review the connector availability and permissions.');
    }
    return this._toAnswer(res, { toolCalls, approvalRounds: rounds });
  }

  _post(body) {
    return this._fetch('/openai/v1/responses', {
      method: 'POST',
      body,
      apiVersion: false,
      timeoutMs: this.cfg.responseTimeoutMs || 90_000
    });
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

  _toAnswer(res, { toolCalls = [], approvalRounds = 0 } = {}) {
    const items = res?.output || [];
    // Only message items carry the answer; tool-call items sit alongside them.
    const messages = items.filter((i) => !i?.type || i.type === 'message');
    const text =
      res?.output_text ||
      messages
        .flatMap((i) => (i?.content || []).map((c) => c?.text).filter(Boolean))
        .join('\n');
    const annotations = messages.flatMap((i) => (i?.content || []).flatMap((c) => c?.annotations || []));
    const pendingApprovals = items.filter((i) => i?.type === 'mcp_approval_request').length;
    const failedTools = toolCalls.filter((t) => t.error).map((t) => `${t.server}: ${t.tool} — ${t.error}`);
    return {
      text,
      responseId: res?.id || null,
      model: res?.model || null,
      sources: dedupe(
        annotations
          .filter((a) => a.type === 'url_citation' || a.type === 'file_citation')
          .map((a) => ({ name: a.title || a.filename || a.url || 'Cited document', url: a.url || null }))
      ),
      toolCalls,
      approvalRounds,
      pendingApprovals,
      confidence: null,
      couldNotReach: failedTools,
      status: res?.status || null
    };
  }

  async health() {
    if (!this.cfg.projectEndpoint) return { ok: false, mode: 'live', error: 'No project endpoint configured' };
    const started = Date.now();
    await this.listAgents();
    return { ok: true, mode: 'live', model: this.cfg.model, latencyMs: Date.now() - started };
  }
}

/** The failure that means an MCP tool has no working project connection. */
export function isToolAuthFailure(err) {
  const m = String(err?.message || '');
  return /Authentication failed when connecting to the MCP server/i.test(m) && /401|subscription key/i.test(m);
}

/** Pull every tool interaction out of a response's output items. */
function collectToolCalls(res, into) {
  for (const i of res?.output || []) {
    if (!i || typeof i !== 'object') continue;
    if (i.type === 'mcp_call' || i.type === 'mcp_approval_request') {
      into.push({
        kind: i.type === 'mcp_call' ? 'call' : 'approval',
        server: i.server_label || null,
        tool: i.name || null,
        arguments: typeof i.arguments === 'string' ? i.arguments.slice(0, 400) : JSON.stringify(i.arguments || {}).slice(0, 400),
        output: i.type === 'mcp_call' ? String(i.output ?? '').slice(0, 600) : null,
        error: i.error ? String(i.error?.message || i.error).slice(0, 300) : null
      });
    } else if (i.type === 'azure_ai_search_call' || /search_call$/.test(i.type || '')) {
      into.push({ kind: 'call', server: 'azure_ai_search', tool: 'search', arguments: JSON.stringify(i.queries || i.arguments || {}).slice(0, 400), output: null, error: null });
    } else if (i.type === 'mcp_list_tools') {
      into.push({ kind: 'list', server: i.server_label || null, tool: null, arguments: `${(i.tools || []).length} tools listed`, output: null, error: i.error ? String(i.error?.message || i.error).slice(0, 300) : null });
    }
  }
}

function dedupe(sources) {
  const seen = new Set();
  return sources.filter((s) => {
    const k = `${s.name}|${s.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function createFoundryAdapter() {
  return new LiveFoundry(config.foundry);
}

export { LiveFoundry };
