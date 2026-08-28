/**
 * The Cortex Index — the merged register.
 *
 * Purview, APIM and Foundry have no shared identifier, no shared vocabulary
 * and very different latency. Querying them on page load would be slow and
 * fragile, and the Unified Catalog List operation is capped at 100 calls per
 * 20 seconds — a handful of concurrent users would exhaust it.
 *
 * So: a background refresh populates this index, and every read path is
 * served from it. Writes go direct to the live system and then optimistically
 * upsert here, so a user sees their own change immediately. That is what
 * makes the publish step of the demo feel instant.
 *
 * Serving from the index also means a back end going down degrades to stale
 * data rather than an error page.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import { createPurviewAdapter } from '../adapters/purview.js';
import { createApimAdapter } from '../adapters/apim.js';
import { createFoundryAdapter } from '../adapters/foundry.js';

class CortexIndex {
  constructor() {
    this.entries = new Map();
    this.clusters = [];
    this.personas = [];
    this.accessRequests = [];
    this.lastRefresh = null;
    this.lastError = null;
    this.refreshing = false;

    this.purview = createPurviewAdapter();
    this.apim = createApimAdapter();
    this.foundry = createFoundryAdapter();
  }

  async init() {
    const dir = config.seedDir;
    this.clusters = JSON.parse(await readFile(path.join(dir, 'clusters.json'), 'utf8'));
    this.personas = JSON.parse(await readFile(path.join(dir, 'personas.json'), 'utf8'));

    // The seed corpus is the baseline register. Live refresh merges over it
    // rather than replacing it, so the Marketplace is never empty.
    const seeded = JSON.parse(await readFile(path.join(dir, 'entries.json'), 'utf8'));
    for (const e of seeded) this.entries.set(e.id, this.normalise(e));

    await this.refresh();
    if (config.index.refreshMinutes > 0 && !config.demoMode) {
      this.timer = setInterval(
        () => this.refresh().catch(() => {}),
        config.index.refreshMinutes * 60_000
      );
      this.timer.unref?.();
    }
    return this;
  }

  /**
   * Rebuild from every source. Each source is independently fault-tolerant:
   * one failing back end degrades that slice to seeded data and records the
   * error, rather than taking the page down.
   */
  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    const errors = [];

    const settle = async (label, fn) => {
      try {
        return await fn();
      } catch (err) {
        errors.push(`${label}: ${err.message}`);
        return null;
      }
    };

    const [products, mcpServers, agents] = await Promise.all([
      settle('purview', () => this.purview.listDataProducts()),
      settle('apim', () => this.apim.listMcpServers()),
      settle('foundry', () => this.foundry.listAgents())
    ]);

    if (products) for (const p of products) this.upsert(p);

    if (mcpServers) {
      for (const s of mcpServers) {
        const existing = this.entries.get(s.id);
        if (existing) {
          existing._endpoints = { ...existing._endpoints, mcp: s.url || existing._endpoints?.mcp };
          existing.tools = s.tools || existing.tools;
        }
      }
    }

    if (agents) {
      for (const a of agents) {
        if (!a?.name) continue;
        const id = slug(a.name);
        const existing = this.entries.get(id);
        this.upsert({
          ...(existing || {}),
          id,
          name: a.name,
          cat: 'Agent',
          cluster: existing?.cluster || 'corp',
          desc: existing?.desc || a.instructions?.slice(0, 200) || 'An agent built in Cortex.',
          owner: existing?.owner || 'Built in Cortex',
          ownerState: 'confirmed',
          fresh: 'Live',
          sens: existing?.sens || 'Official',
          access: existing?.access || 'Open to all staff',
          vis: existing?.vis || 'available',
          licence: existing?.licence || 'Internal only',
          _source: { system: 'foundry', id: a.name, maintainedBy: 'human', syncedAt: new Date().toISOString() },
          _endpoints: existing?._endpoints || {},
          _illustrative: ['calls', 'consumers', 'cpu', 'err', 'lat', 'carbon']
        });
      }
    }

    this.lastRefresh = new Date().toISOString();
    this.lastError = errors.length ? errors.join(' | ') : null;
    this.refreshing = false;
    return { entries: this.entries.size, errors };
  }

  /**
   * Fill in what an entry does not state for itself.
   *
   * Where an entry names no owner, the owning team of its cluster is used.
   * That is a derivation, not a fact somebody confirmed, so ownerState is
   * marked 'proposed' and the entry standard shows it as such. An owner
   * nobody has confirmed and an owner somebody has confirmed must never look
   * the same on screen — the whole point of the provenance column is that a
   * reader can tell them apart.
   */
  normalise(entry) {
    const e = { ...entry };
    if (!e.owner) {
      const cluster = this.clusters.find((c) => c.id === e.cluster);
      e.owner = cluster?.owner || 'Not claimed';
      e.ownerState = e.ownerState === 'confirmed' ? 'confirmed' : 'proposed';
      e._ownerDerived = true;
    }
    if (e.owner === 'Not claimed') e.ownerState = 'proposed';
    return e;
  }

  /** Merge a record in, preserving seeded fields the live source does not carry. */
  upsert(entry) {
    const existing = this.entries.get(entry.id);
    const merged = existing ? { ...existing, ...prune(entry) } : this.normalise(entry);
    this.entries.set(entry.id, merged);
    return merged;
  }

  all() {
    return [...this.entries.values()];
  }

  get(id) {
    return this.entries.get(id) || null;
  }

  clusterById(id) {
    return this.clusters.find((c) => c.id === id) || null;
  }

  personaById(id) {
    return this.personas.find((p) => p.id === id) || null;
  }

  /**
   * Search and filter. This mirrors the shape of the Purview
   * dataProducts/query call, so swapping the seeded path for the live one
   * does not change the caller.
   */
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
   * Dependencies are recorded as an entry id, an entry name, or an external
   * system not in the register. Only the first two can be counted; an
   * external dependency is real but unmeasurable, so it is reported
   * separately rather than silently dropped.
   */
  crossClusterLinks() {
    const byName = new Map(this.all().map((e) => [e.name.toLowerCase(), e]));
    const resolve = (d) => this.entries.get(String(d)) || byName.get(String(d).toLowerCase()) || null;

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

  coverage() {
    const registered = this.entries.size;
    const believed = this.clusters.reduce((a, c) => a + c.count, 0);
    return {
      registered,
      believed,
      percent: believed ? Math.round((registered / believed) * 1000) / 10 : 0,
      illustrative: true
    };
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
      clusters: this.clusters.length,
      lastRefresh: this.lastRefresh,
      lastError: this.lastError
    };
  }
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
