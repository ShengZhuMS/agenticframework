/**
 * Purview adapter — governance domains and data products.
 *
 * Live only. Reads the Unified Catalog API (public preview — there is no GA
 * version). Tests stub at the HTTP boundary rather than swapping this out.
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

/**
 * Managed attributes come back as an ARRAY of { name, value } — the same shape
 * the write path sends. Reading them as a plain dictionary returned undefined
 * for every one, which is silent: the Marketplace simply showed the fallback
 * for each field, so sensitivity read as Official, access as open to all
 * staff, and — the one that matters — allowedGroups and askable came back
 * empty. Empty allowedGroups is not a cosmetic default; it is an input to
 * visibilityFor().
 *
 * Both shapes are accepted, because a tenant written by an older run of
 * bootstrap may still hold the dictionary form.
 */
function toAttributeMap(managedAttributes) {
  if (!managedAttributes) return {};
  if (!Array.isArray(managedAttributes)) return managedAttributes;
  const out = {};
  for (const item of managedAttributes) {
    if (!item || typeof item !== 'object') continue;
    const name = item.name ?? item.attributeName;
    if (!name) continue;
    out[name] = item.value ?? item.attributeValue ?? '';
  }
  return out;
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

  /**
   * Map a Purview data product onto the canonical Cortex Entry.
   *
   * The Unified Catalog has no column for several things the entry standard
   * requires — licence coverage, minimum aggregation, what a holder can answer.
   * Those are carried as managed attributes so they live in Purview, governed
   * alongside everything else, rather than only in this application.
   */
  _toEntry(p) {
    const a = toAttributeMap(p.managedAttributes);
    const attr = (k) => {
      const v = a[k];
      if (v === undefined || v === null || v === '') return null;
      return Array.isArray(v) ? v[0] : String(v);
    };
    const list = (k, sep = ',') => {
      const v = attr(k);
      return v ? v.split(sep).map((x) => x.trim()).filter(Boolean) : [];
    };

    return {
      id: p.id,
      name: p.name,
      cat: 'Data',
      cluster: p.domain,
      desc: p.description,
      businessUse: p.businessUse,
      owner:
        attr('cortexOwnerTeam') ||
        (p.contacts?.owner || []).map((c) => c.description).join(', ') ||
        null,
      ownerState: attr('cortexOwnerTeam') || p.contacts?.owner?.length ? 'confirmed' : 'proposed',
      fresh: attr('cortexFreshness') || p.updateFrequency || '—',
      sens: attr('cortexSensitivity') || p.sensitivityLabel || 'Official',
      access: attr('cortexAccessRoute') || 'Open to all staff',
      allowedGroups: list('cortexAllowedGroups'),
      licence: attr('cortexLicence') || (p.termsOfUse || []).map((t) => t.name).join(', ') || '—',
      limits: attr('cortexLimitations'),
      minAgg: attr('cortexMinimumAggregation'),
      askable: list('cortexAskable', '|'),
      deps: list('cortexDependsOn'),
      location: attr('cortexLocation'),
      endorsed: p.endorsed,
      consumers: p.activeSubscriberCount ?? 0,
      audience: p.audience || [],
      status: p.status,
      // Purview knows nothing about usage. Real figures come from APIM
      // analytics in the index refresh, and are absent until they do.
      calls: 0,
      err: null,
      lat: null,
      rag: 'g',
      flags: [],
      _source: {
        system: 'purview',
        id: p.id,
        maintainedBy: attr('cortexOwnerTeam') ? 'human' : 'agent',
        syncedAt: new Date().toISOString()
      },
      _endpoints: {}
    };
  }

  async health() {
    const d = await this.listDomains();
    const p = await this.listDataProducts();
    return { ok: true, mode: 'live', domains: d.length, dataProducts: p.length };
  }
}

export function createPurviewAdapter() {
  return new LivePurview(config.purview);
}

export { CLUSTER_DOMAINS, LivePurview, toAttributeMap };
