/**
 * The Cortex Index — the merged register.
 *
 * Purview, APIM and Foundry have no shared identifier, no shared vocabulary
 * and very different latency. Querying them on page load would be slow and
 * fragile, and the Unified Catalog List operation is capped at 100 calls per
 * 20 seconds — a handful of concurrent users would exhaust it.
 *
 * So: a background refresh populates this index from the live APIs, and every
 * read path is served from it. Writes go direct to the live system and then
 * optimistically upsert here, so a user sees their own change immediately.
 *
 * EVERYTHING IN HERE CAME FROM AZURE. There is no seeded data and no local
 * fallback corpus: if the register is empty it is because nothing is
 * registered, and the Marketplace says so rather than showing something that
 * looks real and is not.
 */

import config from '../config.js';
import { createPurviewAdapter, resolveDomainId } from '../adapters/purview.js';
import { createApimAdapter } from '../adapters/apim.js';
import { createFoundryAdapter } from '../adapters/foundry.js';

class CortexIndex {
  constructor() {
    this.entries = new Map();
    this.domains = [];
    this.accessRequests = [];
    this.gatewayRequests = [];
    this.lastRefresh = null;
    this.lastError = null;
    this.sourceErrors = {};
    this.refreshing = false;

    this.purview = createPurviewAdapter();
    this.apim = createApimAdapter();
    this.foundry = createFoundryAdapter();
  }

  async init() {
    await this.refresh();

    if (config.index.warnIfEmpty && this.entries.size === 0) {
      console.warn('  register is EMPTY — nothing is registered in Purview, APIM or Foundry yet.');
      console.warn('  Run `npm run bootstrap` to create the Defra governance domains and data products.');
    }

    if (config.index.refreshMinutes > 0) {
      this.timer = setInterval(
        () => this.refresh().catch(() => {}),
        config.index.refreshMinutes * 60_000
      );
      this.timer.unref?.();
    }
    return this;
  }

  /**
   * Rebuild from every source.
   *
   * Each source is independently fault-tolerant: one failing back end leaves
   * that slice as it was and records the error, rather than emptying the
   * register or taking the page down. A partial register is honest — it is
   * labelled on screen — where a blank one would be misleading.
   */
  async refresh() {
    if (this.refreshing) return { entries: this.entries.size, errors: [] };
    this.refreshing = true;
    const errors = [];

    const settle = async (label, fn) => {
      try {
        const out = await fn();
        delete this.sourceErrors[label];
        return out;
      } catch (err) {
        errors.push(`${label}: ${err.message}`);
        this.sourceErrors[label] = err.message;
        return null;
      }
    };

    const [domains, products, mcpServers, apis, agents] = await Promise.all([
      settle('purview-domains', () => this.purview.listDomains()),
      settle('purview-products', () => this.purview.listDataProducts()),
      settle('apim-mcp', () => this.apim.listMcpServers()),
      settle('apim-apis', () => this.apim.listApis()),
      settle('foundry-agents', () => this.foundry.listAgents())
    ]);

    if (domains) {
      this.domains = domains;
      for (const e of this.entries.values()) e.cluster = resolveDomainId(e.cluster, domains);
    }

    if (products) {
      for (const p of products) this.upsert(this.normalise(p));
    }

    // Skills and apps registered as APIs in API Management.
    if (apis) {
      for (const a of apis) {
        if (!a?.id) continue;
        this.upsert(
          this.normalise({
            id: a.id,
            name: a.name || a.id,
            cat: 'Skill',
            cluster: a.cluster || domainOf(a),
            desc: a.description || 'An API registered in API Management.',
            owner: a.owner || 'Not claimed',
            fresh: 'Live',
            sens: 'Official',
            access: 'Open to all staff',
            allowedGroups: ['all-staff'],
            licence: 'Internal only',
            _source: {
              system: 'apim',
              id: a.id,
              maintainedBy: 'agent',
              syncedAt: new Date().toISOString()
            },
            _endpoints: {}
          })
        );
      }
    }

    // MCP endpoints attach to whatever entry they front.
    if (mcpServers) {
      for (const s of mcpServers) {
        const backing = s.id.replace(/-mcp$/, '');
        const target = this.entries.get(s.id) || this.entries.get(backing);
        if (target) {
          target._endpoints = { ...target._endpoints, mcp: s.url };
          target.tools = s.tools || target.tools;
        }
      }
    }

    if (agents) {
      for (const a of agents) {
        if (!a?.name) continue;
        // Cortex's own Ask agent is plumbing, not a part anyone builds with.
        if (a.name === config.ask.agentName || a.name.startsWith('cortex-ask')) continue;
        const id = slug(a.name);
        const existing = this.entries.get(id);
        this.upsert({
          ...(existing || {}),
          id,
          name: a.name,
          cat: 'Agent',
          cluster: existing?.cluster || (this.domains[0]?.id ?? 'unassigned'),
          desc: existing?.desc || a.instructions?.slice(0, 200) || 'An agent built in Cortex.',
          owner: existing?.owner || 'Built in Cortex',
          ownerState: 'confirmed',
          fresh: 'Live',
          sens: existing?.sens || 'Official',
          access: existing?.access || 'Open to the team that built it',
          allowedGroups: existing?.allowedGroups || [],
          licence: existing?.licence || 'Internal only',
          _source: {
            system: 'foundry',
            id: a.name,
            maintainedBy: 'human',
            syncedAt: new Date().toISOString()
          },
          _endpoints: existing?._endpoints || {}
        });
      }
    }

    // Real usage from the gateway. Decoration only — a failure here must never
    // affect what the register contains.
    const usage = await settle('apim-analytics', () => this.apim.usageByApi());
    if (usage) {
      for (const entry of this.entries.values()) {
        const u = usage[entry.id] || usage[`${entry.id}-api`] || usage[`${entry.id}-mcp`];
        if (u) {
          entry.calls = u.calls;
          if (u.consumers !== undefined) entry.consumers = u.consumers;
          entry.err = u.errorRate;
          entry.lat = u.latencyMs != null ? `${u.latencyMs}ms` : null;
          entry.rag = u.rag;
          entry.usageSource = 'API Management analytics';
        }
      }
    }

    this.lastRefresh = new Date().toISOString();
    this.lastError = errors.length ? errors.join(' | ') : null;
    this.refreshing = false;
    return { entries: this.entries.size, errors };
  }

  /**
   * Fill in what a record does not state for itself.
   *
   * Where no owner is named, the owning team of its governance domain is used.
   * That is a derivation, not a fact somebody confirmed, so ownerState becomes
   * 'proposed' and the entry standard shows it as such. An owner nobody has
   * confirmed and an owner somebody has confirmed must never look the same.
   */
  normalise(entry) {
    const e = { ...entry };
    // Purview names a domain by GUID; content files, the MCP tool and a new
    // agent's default name it by slug. One form in the register, or the map
    // shows the same domain twice and an agent lands in "unclustered".
    e.cluster = resolveDomainId(e.cluster, this.domains);
    if (!e.owner) {
      const domain = this.domains.find((d) => d.id === e.cluster);
      e.owner = domain?.owner || 'Not claimed';
      e.ownerState = e.ownerState === 'confirmed' ? 'confirmed' : 'proposed';
      e._ownerDerived = true;
    }
    if (e.owner === 'Not claimed') e.ownerState = 'proposed';
    return e;
  }

  upsert(entry) {
    const existing = this.entries.get(entry.id);
    const merged = existing ? { ...existing, ...prune(entry) } : this.normalise(entry);
    merged.cluster = resolveDomainId(merged.cluster, this.domains);
    this.entries.set(entry.id, merged);
    return merged;
  }

  all() {
    return [...this.entries.values()];
  }

  get(id) {
    return this.entries.get(id) || null;
  }

  /** Governance domains, from Purview. Named 'clusters' in the interface copy. */
  get clusters() {
    return this.domains;
  }

  clusterById(id) {
    const resolved = resolveDomainId(id, this.domains);
    return this.domains.find((c) => c.id === resolved) || null;
  }

  search({ q, cats, clusters, visStates, sort = 'name' } = {}, user = null) {
    let out = this.all();
    if (q) {
      const needle = q.toLowerCase();
      out = out.filter((e) =>
        [e.name, e.desc, e.owner, e.cluster, this.clusterById(e.cluster)?.name]
          .filter(Boolean)
          .some((f) => String(f).toLowerCase().includes(needle))
      );
    }
    if (cats?.length) out = out.filter((e) => cats.includes(e.cat));
    if (clusters?.length) out = out.filter((e) => clusters.includes(e.cluster));
    if (visStates?.length && user) out = out.filter((e) => visStates.includes(e.vis));

    const dir = sort.startsWith('-') ? -1 : 1;
    const key = sort.replace(/^-/, '');
    out.sort((a, b) => {
      const av = a[key] ?? '';
      const bv = b[key] ?? '';
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return out;
  }

  /**
   * Cross-cluster dependency count — the honest test of joining up.
   *
   * Only dependencies that resolve to a registered entry can be counted. One
   * that points at an unregistered system is real but unmeasurable, so it is
   * reported separately rather than silently dropped.
   */
  crossClusterLinks() {
    const byName = new Map(this.all().map((e) => [e.name.toLowerCase(), e]));
    const resolve = (d) =>
      this.entries.get(String(d)) || byName.get(String(d).toLowerCase()) || null;

    let count = 0;
    let unresolved = 0;
    const links = [];
    for (const e of this.all()) {
      for (const d of e.deps || []) {
        const target = resolve(d);
        if (!target) {
          unresolved++;
          continue;
        }
        if (target.cluster !== e.cluster) {
          count++;
          links.push({ from: e.cluster, to: target.cluster, via: e.name, target: target.name });
        }
      }
    }
    return { count, links, unresolved };
  }

  /**
   * What is registered, by category and domain.
   *
   * Deliberately NOT a percentage of a "believed estate". That figure had no
   * source — it was an estimate nobody could produce evidence for — so it is
   * gone. What is registered is a fact; what exists unregistered is unknown,
   * and saying so is more useful than a number that invites a question nobody
   * can answer.
   */
  coverage() {
    const byCat = {};
    const byDomain = {};
    for (const e of this.all()) {
      byCat[e.cat] = (byCat[e.cat] || 0) + 1;
      byDomain[e.cluster] = (byDomain[e.cluster] || 0) + 1;
    }
    return { registered: this.entries.size, byCat, byDomain };
  }

  /** A request to register a source through the gateway. */
  addGatewayRequest(req) {
    const record = {
      ref: `GW-${String(this.gatewayRequests.length + 1).padStart(4, '0')}`,
      status: 'Pending',
      raisedAt: new Date().toISOString(),
      ...req
    };
    this.gatewayRequests.push(record);
    return record;
  }

  addAccessRequest(req) {
    const record = {
      ref: `CTX-${String(this.accessRequests.length + 1).padStart(4, '0')}`,
      status: 'Pending',
      raisedAt: new Date().toISOString(),
      ...req
    };
    this.accessRequests.push(record);
    return record;
  }

  stats() {
    const byCat = {};
    for (const e of this.all()) byCat[e.cat] = (byCat[e.cat] || 0) + 1;
    return {
      entries: this.entries.size,
      byCat,
      domains: this.domains.length,
      lastRefresh: this.lastRefresh,
      lastError: this.lastError,
      sourceErrors: this.sourceErrors
    };
  }
}

function domainOf(a) {
  return a.domain || a.cluster || 'unassigned';
}

function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) out[k] = v;
  }
  return out;
}

export function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export const index = new CortexIndex();
export default index;
