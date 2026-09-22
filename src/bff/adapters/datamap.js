/**
 * Purview Data Map adapter — sources, scans and the assets they produce.
 *
 * The Unified Catalog (purview.js) is where a DATA PRODUCT lives: the
 * business description of a dataset. The Data Map is where the DATA ASSET
 * lives: the technical record of a real file or table, with its schema and
 * classifications, produced by scanning a registered source. A data product
 * becomes usable — not just describable — when its Data Map assets are
 * attached to it. This adapter does the Data Map half of that.
 *
 * VERIFIED SHAPES (September 2026)
 *   account endpoint   https://<account>.purview.azure.com
 *   scanning           /scan/datasources/{ds}            PUT, api-version 2023-09-01
 *                      /scan/datasources/{ds}/scans/{s}  PUT  kind AdlsGen2Msi
 *                      /scan/datasources/{ds}/scans/{s}:run  POST, runId and scanLevel query
 *                      /scan/datasources/{ds}/scans/{s}/runs           GET
 *   collections        /account/collections               api-version 2019-11-01-preview
 *   assets             /datamap/api/atlas/v2/entity/uniqueAttribute/type/{type}?attr:qualifiedName=…
 *                      /datamap/api/search/query          POST, api-version 2023-09-01
 *   roles              /policystore/collections/{c}/metadataPolicy      GET
 *                      /policystore/metadataPolicies/{id}               PUT, api-version 2021-07-01
 *   scope              https://purview.azure.net/.default (one token covers both planes)
 *
 * The scan runs as the PURVIEW ACCOUNT's managed identity, which holds
 * Storage Blob Data Reader on the sample-data account (infra/modules/data.bicep).
 * Registering a source and creating a scan needs Data Source Administrator on
 * the collection; ensureCollectionRoles() grants it the same way
 * purview-access.js grants the Unified Catalog roles.
 */

import { randomUUID } from 'node:crypto';
import config from '../config.js';
import { getToken } from './token.js';

const bearer = (token) => ['Bearer', token].join(' ');

export const COLLECTION_ROLES = {
  collectionAdmin: 'purviewmetadatarole_builtin_collection-administrator',
  dataSourceAdmin: 'purviewmetadatarole_builtin_data-source-administrator',
  dataCurator: 'purviewmetadatarole_builtin_data-curator',
  dataReader: 'purviewmetadatarole_builtin_purview-reader'
};

/** The Atlas qualified name of a file in an ADLS Gen2 account. */
export function adlsQualifiedName(account, container, blobPath) {
  return `https://${account}.dfs.core.windows.net/${container}/${String(blobPath).replace(/^\/+/, '')}`;
}

/** The Data Map's name for one file asset — the asset type UC calls ADLSGen2Path. */
export const ADLS_FILE_TYPE = 'azure_datalake_gen2_path';

class LiveDataMap {
  constructor(cfg) {
    this.cfg = cfg;
    this.name = 'datamap:live';
  }

  get endpoint() {
    return this.cfg.dataMapEndpoint || (this.cfg.accountName ? `https://${this.cfg.accountName}.purview.azure.com` : '');
  }

  get collection() {
    return this.cfg.collection || this.cfg.accountName || '';
  }

  configured() {
    return Boolean(this.endpoint);
  }

  async _fetch(pathname, { method = 'GET', body, apiVersion = this.cfg.dataMapApiVersion, query = {}, ok404 = false } = {}) {
    if (!this.endpoint) throw new Error('The Purview account is not configured (PURVIEW_ACCOUNT_NAME).');
    const url = new URL(pathname, this.endpoint);
    if (apiVersion) url.searchParams.set('api-version', apiVersion);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const token = await getToken(this.cfg.scope);
    const res = await fetch(url, {
      method,
      headers: { Authorization: bearer(token), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.cfg.timeoutMs || 30_000)
    });
    if (res.status === 404 && ok404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const hint =
        res.status === 403
          ? ' — the signed-in account needs Data Source Administrator and Data Curator on the collection (bootstrap grants them; or Data Map → Collections → Role assignments in the Purview portal)'
          : '';
      throw new Error(`Data Map ${method} ${pathname} failed ${res.status}: ${text.slice(0, 400)}${hint}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /* -------------------------------------------------------- collections */

  async listCollections() {
    const res = await this._fetch('/account/collections', { apiVersion: '2019-11-01-preview' });
    return (res?.value || []).map((c) => ({
      name: c.name,
      friendlyName: c.friendlyName || c.name,
      parent: c.parentCollection?.referenceName || null
    }));
  }

  /**
   * Grant collection roles to principals, read-modify-write on the metadata
   * policy — the same mechanism the Purview portal uses. Idempotent.
   * Returns { changed: boolean, roles: { roleId: [added principal ids] } }.
   */
  async ensureCollectionRoles({ collection = this.collection, principalIds, roles = Object.values(COLLECTION_ROLES), dryRun = false }) {
    const policy = await this._fetch(`/policystore/collections/${encodeURIComponent(collection)}/metadataPolicy`, {
      apiVersion: '2021-07-01'
    });
    if (!policy?.id) throw new Error(`No metadata policy found for collection ${collection}.`);
    const rules = policy.properties?.attributeRules || [];
    const added = {};
    let changed = false;

    for (const roleId of roles) {
      const rule = rules.find((r) => String(r.id || '').startsWith(`${roleId}:`) || r.id === roleId);
      if (!rule) {
        added[roleId] = { missing: true };
        continue;
      }
      // Every clause set that names principals for this role.
      const clauses = (rule.dnfCondition || []).flat().filter((c) => c.attributeName === 'principal.microsoft.id');
      if (!clauses.length) {
        // A rule with no principal clause yet: add one alongside the role clause.
        const principalClause = { attributeName: 'principal.microsoft.id', attributeValueIncludedIn: [] };
        if (!rule.dnfCondition?.length) rule.dnfCondition = [[]];
        rule.dnfCondition[0].push(principalClause);
        clauses.push(principalClause);
      }
      const target = clauses[0];
      target.attributeValueIncludedIn = target.attributeValueIncludedIn || [];
      const before = new Set(target.attributeValueIncludedIn.map((x) => String(x).toLowerCase()));
      const news = principalIds.filter((p) => !before.has(String(p).toLowerCase()));
      if (news.length) {
        target.attributeValueIncludedIn.push(...news);
        changed = true;
      }
      added[roleId] = news;
    }

    if (changed && !dryRun) {
      await this._fetch(`/policystore/metadataPolicies/${encodeURIComponent(policy.id)}`, {
        method: 'PUT',
        apiVersion: '2021-07-01',
        body: policy
      });
    }
    return { changed, roles: added, policyId: policy.id };
  }

  /* ------------------------------------------------------------ sources */

  async getDataSource(name) {
    return this._fetch(`/scan/datasources/${encodeURIComponent(name)}`, { ok404: true });
  }

  /**
   * Register an ADLS Gen2 account as a source. `location` is the storage
   * account's region, `resourceGroup`/`subscriptionId` its ARM home.
   */
  async ensureAdlsSource({ name, storageAccount, resourceGroup, subscriptionId, location, collection = this.collection }) {
    if (!storageAccount || !resourceGroup || !subscriptionId) throw new Error('Data Map source registration requires storage account, resource group and subscription ID.');
    const existing = await this.getDataSource(name);
    const endpoint = `https://${storageAccount}.dfs.core.windows.net/`;
    const resourceId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccount}`;
    if (existing && existing.properties?.endpoint === endpoint && existing.properties?.resourceId?.toLowerCase() === resourceId.toLowerCase()) return { name, created: false };
    await this._fetch(`/scan/datasources/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: {
        kind: 'AdlsGen2',
        name,
        properties: {
          endpoint,
          resourceId,
          resourceGroup,
          subscriptionId,
          location,
          resourceName: storageAccount,
          collection: { type: 'CollectionReference', referenceName: collection }
        }
      }
    });
    return { name, created: !existing };
  }

  /* -------------------------------------------------------------- scans */

  async getScan(dataSourceName, scanName) {
    return this._fetch(`/scan/datasources/${encodeURIComponent(dataSourceName)}/scans/${encodeURIComponent(scanName)}`, { ok404: true });
  }

  /** A scan that runs as the Purview account's managed identity. */
  async ensureAdlsScan({ dataSourceName, scanName, collection = this.collection }) {
    const existing = await this.getScan(dataSourceName, scanName);
    if (existing?.kind === 'AdlsGen2Msi') return { name: scanName, created: false };
    await this._fetch(`/scan/datasources/${encodeURIComponent(dataSourceName)}/scans/${encodeURIComponent(scanName)}`, {
      method: 'PUT',
      body: {
        kind: 'AdlsGen2Msi',
        name: scanName,
        properties: {
          scanRulesetName: 'AdlsGen2',
          scanRulesetType: 'System',
          collection: { type: 'CollectionReference', referenceName: collection }
        }
      }
    });
    return { name: scanName, created: !existing };
  }

  async runScan(dataSourceName, scanName, { level = 'Full' } = {}) {
    const runId = randomUUID();
    const res = await this._fetch(
      `/scan/datasources/${encodeURIComponent(dataSourceName)}/scans/${encodeURIComponent(scanName)}:run`,
      { method: 'POST', query: { runId, scanLevel: level } }
    );
    return { runId, status: res?.status || 'Queued', raw: res };
  }

  async scanRuns(dataSourceName, scanName) {
    const res = await this._fetch(
      `/scan/datasources/${encodeURIComponent(dataSourceName)}/scans/${encodeURIComponent(scanName)}/runs`
    );
    return (res?.value || [])
      .map((r) => ({
        id: r.id || r.parentId || r.scanResultId,
        status: r.status,
        started: r.startTime,
        ended: r.endTime,
        discovered: r.assetsDiscovered ?? r.discoveryExecutionDetails?.statistics?.assets?.discovered ?? null,
        classified: r.assetsClassified ?? r.discoveryExecutionDetails?.statistics?.assets?.classified ?? null,
        error: r.error?.message || r.errorMessage || null
      }))
      .sort((a, b) => new Date(b.started || 0) - new Date(a.started || 0));
  }

  /**
   * Wait for a run to finish. Scans of a few small files take 3–10 minutes —
   * most of it queueing — so the default budget is generous and the caller
   * gets progress through onTick.
   */
  async waitForScan(dataSourceName, scanName, runId, { timeoutMs = 20 * 60_000, pollMs = 20_000, onTick } = {}) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      const runs = await this.scanRuns(dataSourceName, scanName);
      last = runs.find((r) => r.id === runId) || null;
      const status = String(last?.status || 'Queued');
      onTick?.(status, last);
      if (/^(Succeeded|Completed)$/i.test(status)) return { done: true, status, run: last };
      if (/^(Failed|Cancelled|Canceled|CompletedWithExceptions)$/i.test(status)) return { done: true, status, run: last };
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { done: false, status: last?.status || 'Unknown', run: last };
  }

  /* -------------------------------------------------------------- assets */

  /** Look one file up by its exact qualified name. Null when the scan has not produced it yet. */
  async getAssetByQualifiedName(qualifiedName, type = ADLS_FILE_TYPE) {
    const res = await this._fetch(`/datamap/api/atlas/v2/entity/uniqueAttribute/type/${encodeURIComponent(type)}`, {
      query: { 'attr:qualifiedName': qualifiedName },
      ok404: true
    });
    const e = res?.entity;
    if (!e || e.status === 'DELETED') return null;
    return this._toAsset(e, res.referredEntities);
  }

  /** Search assets by keyword, optionally narrowed to a qualified-name prefix. */
  async searchAssets({ keywords = '*', prefix, types = [ADLS_FILE_TYPE], limit = 50 } = {}) {
    const body = { keywords, limit };
    if (types.length) body.filter = { or: types.map((t) => ({ entityType: t })) };
    const res = await this._fetch('/datamap/api/search/query', { method: 'POST', body });
    return (res?.value || [])
      .filter((v) => !prefix || String(v.qualifiedName || '').startsWith(prefix))
      .map((v) => ({
        id: v.id,
        name: v.name,
        type: v.entityType,
        qualifiedName: v.qualifiedName,
        classifications: v.classification || [],
        description: v.description || null
      }));
  }

  /** Full entity, for the schema (columns) the scan extracted. */
  async getAsset(guid) {
    const res = await this._fetch(`/datamap/api/atlas/v2/entity/guid/${encodeURIComponent(guid)}`, { ok404: true });
    return res?.entity && res.entity.status !== 'DELETED' ? this._toAsset(res.entity, res.referredEntities) : null;
  }

  _toAsset(e, referred = {}) {
    const attrs = e.attributes || {};
    // Columns hang off a tabular_schema referred entity for file assets.
    const columns = [];
    for (const r of Object.values(referred || {})) {
      if (r.typeName === 'column' || /column/i.test(r.typeName || '')) {
        columns.push({ name: r.attributes?.name, type: r.attributes?.type || r.attributes?.data_type || null });
      }
    }
    return {
      id: e.guid,
      name: attrs.name,
      type: e.typeName,
      qualifiedName: attrs.qualifiedName,
      description: attrs.description || attrs.userDescription || null,
      classifications: (e.classifications || []).map((c) => c.typeName),
      columns,
      size: attrs.size ?? null,
      modified: attrs.modifiedTime || attrs.lastModifiedTime || null
    };
  }

  async health() {
    if (!this.configured()) return { ok: false, mode: 'live', error: 'No Purview account configured' };
    const started = Date.now();
    const cols = await this.listCollections();
    return { ok: true, mode: 'live', collections: cols.length, latencyMs: Date.now() - started };
  }
}

export function createDataMapAdapter() {
  return new LiveDataMap(config.purview);
}

export { LiveDataMap };
