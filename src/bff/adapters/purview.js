/**
 * Purview adapter — governance domains and data products.
 *
 * Two implementations behind one interface:
 *   seeded  — reads seed/entries.json, no network
 *   live    — Unified Catalog API (public preview, no GA version exists)
 *
 * VERIFIED API NOTES (August 2026) — do not substitute remembered shapes:
 *   base      https://api.purview-service.microsoft.com   (NOT {account}.purview.azure.com)
 *   root      /datagovernance/catalog/
 *   version   2026-03-20-preview
 *   scope     https://purview.azure.net/.default  (one token also covers Data Map)
 *   casing    'businessdomains' is lowercase; 'dataProducts' is camelCase
 *   status    entity reads DRAFT|PUBLISHED|EXPIRED, query filters use Draft|Published|Expired
 *   publish   there is NO publish verb — it is a status transition on a full-replace PUT
 *   policies  the Policies group is RBAC role assignment, NOT data access policy
 *   rate      List is only 100 calls / 20s — which is why the Cortex Index exists
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import { getToken } from './token.js';

const CLUSTER_DOMAINS = {
  water: 'Water',
  flood: 'Flood and coastal',
  marine: 'Marine and fisheries',
  waste: 'Waste and resources',
  air: 'Air quality',
  land: 'Land and biodiversity',
  farm: 'Farming and countryside',
  animal: 'Animal and plant health',
  corp: 'Corporate services'
};

/* ------------------------------------------------------------------ seeded */

class SeededPurview {
  constructor(seedDir) {
    this.seedDir = seedDir;
    this.name = 'purview:seeded';
  }

  async _entries() {
    if (!this._cache) {
      const raw = await readFile(path.join(this.seedDir, 'entries.json'), 'utf8');
      this._cache = JSON.parse(raw);
    }
    return this._cache;
  }

  async listDataProducts() {
    const all = await this._entries();
    return all.filter((e) => e.cat === 'Data');
  }

  async listDomains() {
    const raw = await readFile(path.join(this.seedDir, 'clusters.json'), 'utf8');
    return JSON.parse(raw).map((c) => ({
      id: c.id,
      name: c.name,
      owner: c.owner,
      count: c.count,
      status: 'PUBLISHED'
    }));
  }

  async health() {
    const p = await this.listDataProducts();
    const d = await this.listDomains();
    return { ok: true, mode: 'seeded', dataProducts: p.length, domains: d.length };
  }
}

/* -------------------------------------------------------------------- live */

class LivePurview {
  constructor(cfg) {
    this.cfg = cfg;
    this.name = 'purview:live';
  }

  async _fetch(pathname, { method = 'GET', body, query = {} } = {}) {
    const url = new URL(pathname, this.cfg.endpoint);
    url.searchParams.set('api-version', this.cfg.apiVersion);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
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
      throw new Error(`Purview ${method} ${pathname} failed ${res.status}: ${text.slice(0, 400)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async listDomains() {
    // Lowercase 'businessdomains'. The API still says "business domain"
    // where the product UI says "governance domain" — same object.
    const out = [];
    let skipToken;
    do {
      const page = await this._fetch('/datagovernance/catalog/businessdomains', {
        query: { $skipToken: skipToken }
      });
      out.push(...(page.value || []));
      skipToken = page.nextLink ? new URL(page.nextLink).searchParams.get('$skipToken') : null;
    } while (skipToken);
    return out.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      status: d.status,
      type: d.type
    }));
  }

  /**
   * The whole Marketplace search and filter surface in one call.
   * Note the title-case status filter against the upper-case entity field.
   */
  async queryDataProducts({ nameKeyword, domainIds, owners, types, skip = 0, top = 100 } = {}) {
    const body = { skip, top, multiStatus: ['Published'] };
    if (nameKeyword) body.nameKeyword = nameKeyword;
    if (domainIds?.length) body.domainIds = domainIds;
    if (owners?.length) body.owners = owners;
    if (types?.length) body.types = types;
    const res = await this._fetch('/datagovernance/catalog/dataProducts/query', {
      method: 'POST',
      body
    });
    return (res.value || []).map((p) => this._toEntry(p));
  }

  async listDataProducts() {
    return this.queryDataProducts({ top: 200 });
  }

  async getDataProduct(id) {
    const p = await this._fetch(`/datagovernance/catalog/dataProducts/${id}`);
    return this._toEntry(p);
  }

  /**
   * listRelationships returns only entityId — assets must be hydrated
   * separately. Two round-trips per entry page, so cache the result.
   */
  async getAssets(dataProductId) {
    const rel = await this._fetch(
      `/datagovernance/catalog/dataProducts/${dataProductId}/relationships`,
      { query: { entityType: 'DATAASSET' } }
    );
    const ids = (rel.value || []).map((r) => r.entityId);
    if (!ids.length) return [];
    const assets = await this._fetch('/datagovernance/catalog/dataAssets/query', {
      method: 'POST',
      body: { ids }
    });
    return (assets.value || []).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      openInUrl: a.openInUrl,
      classifications: a.classifications || [],
      schema: a.schema || [],
      // source.assetId is the join key back into the Data Map
      dataMapAssetId: a.source?.assetId,
      fqn: a.source?.fqn
    }));
  }

  /** Map a Purview data product onto the canonical Cortex Entry. */
  _toEntry(p) {
    return {
      id: p.id,
      name: p.name,
      cat: 'Data',
      cluster: p.domain,
      desc: p.description,
      businessUse: p.businessUse,
      owner: (p.contacts?.owner || []).map((c) => c.description).join(', ') || 'Not claimed',
      ownerState: p.contacts?.owner?.length ? 'confirmed' : 'proposed',
      fresh: p.updateFrequency || '—',
      sens: p.sensitivityLabel || 'Official',
      licence: (p.termsOfUse || []).map((t) => t.name).join(', ') || '—',
      endorsed: p.endorsed,
      consumers: p.activeSubscriberCount ?? 0,
      audience: p.audience || [],
      status: p.status,
      _source: {
        system: 'purview',
        id: p.id,
        maintainedBy: 'human',
        syncedAt: new Date().toISOString()
      },
      _endpoints: {},
      _illustrative: ['calls', 'cpu', 'err', 'lat', 'carbon']
    };
  }

  async health() {
    const d = await this.listDomains();
    const p = await this.listDataProducts();
    return { ok: true, mode: 'live', domains: d.length, dataProducts: p.length };
  }
}

export function createPurviewAdapter() {
  return config.adapters.purview === 'live'
    ? new LivePurview(config.purview)
    : new SeededPurview(config.seedDir);
}

export { CLUSTER_DOMAINS, SeededPurview, LivePurview };
