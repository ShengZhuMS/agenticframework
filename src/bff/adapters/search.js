/**
 * Azure AI Search adapter — one index per data product, built from the files
 * the Purview Data Map scanned.
 *
 * WHAT THIS IS FOR
 * A data product in the Unified Catalog describes data; it does not hold it.
 * When someone builds an agent on a data product, the agent needs a way to
 * READ the underlying asset, not just its description. This adapter turns
 * the CSV file behind a product (the same blob the Data Map scanned and
 * attached to the product) into a search index the Foundry agent reads
 * through the azure_ai_search tool, so an answer can cite the rows.
 *
 * VERIFIED SHAPES (September 2026)
 *   endpoint    https://<service>.search.windows.net
 *   version     2024-07-01 (GA)
 *   auth        Entra bearer token, scope https://search.azure.com/.default
 *               — the service is deployed with aadOrApiKey and the Cortex
 *               identity holds Search Service Contributor + Search Index
 *               Data Contributor (infra/modules/search.bicep)
 *   CSV         indexer parsingMode delimitedText, firstLineContainsHeaders;
 *               every row becomes a document; the key is the generated
 *               AzureSearch_DocumentKey, base64-encoded
 *   storage     data source type adlsgen2, credentials.connectionString
 *               "ResourceId=<storage account ARM id>;" — the SEARCH service's
 *               system-assigned identity reads the blobs (Storage Blob Data
 *               Reader), no key anywhere
 *
 * LIMITS THAT MATTER
 *   Basic tier: 15 indexes, 15 indexers, 15 data sources. Fourteen data
 *   products fit; a fifteenth product needs Standard S1. bootstrap says so
 *   rather than failing half way.
 *
 * Everything here is a PUT on a fixed name, so re-running is an update.
 */

import config from '../config.js';
import { getToken } from './token.js';

const bearer = (token) => ['Bearer', token].join(' ');

/** An index name: lower-case letters, digits and dashes, 2–128 characters, no leading dash. */
export function indexNameFor(productId, prefix = config.search.indexPrefix) {
  const clean = String(productId).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${prefix}${clean}`.slice(0, 128).replace(/-+$/, '');
}

/** A field name: letters, digits, underscore; must start with a letter; not "azureSearch…". */
export function fieldNameFor(column) {
  let f = String(column)
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!f) f = 'column';
  if (!/^[A-Za-z]/.test(f)) f = `c_${f}`;
  if (/^azuresearch/i.test(f)) f = `c_${f}`;
  return f.slice(0, 128);
}

/** The reserved fields every product index carries, alongside its own columns. */
export const RESERVED_FIELDS = ['id', 'title', 'url'];

/** Build the index definition for a product from its column names. */
export function indexDefinitionFor(name, columns, { semantic = false } = {}) {
  const own = [...new Set(columns.map(fieldNameFor))].filter((c) => !RESERVED_FIELDS.includes(c));
  const fields = [
    { name: 'id', type: 'Edm.String', key: true, searchable: false, filterable: false, retrievable: true, sortable: false, facetable: false },
    { name: 'title', type: 'Edm.String', searchable: true, filterable: true, retrievable: true, sortable: false, facetable: false },
    { name: 'url', type: 'Edm.String', searchable: false, filterable: false, retrievable: true, sortable: false, facetable: false },
    ...own.map((c) => ({
      name: c,
      type: 'Edm.String',
      searchable: true,
      filterable: true,
      retrievable: true,
      sortable: false,
      facetable: false,
      analyzer: 'en.microsoft'
    }))
  ];
  const def = { name, fields };
  if (semantic) {
    def.semantic = {
      defaultConfiguration: 'default',
      configurations: [
        {
          name: 'default',
          prioritizedFields: {
            titleField: { fieldName: 'title' },
            prioritizedContentFields: own.slice(0, 10).map((c) => ({ fieldName: c }))
          }
        }
      ]
    };
  }
  return def;
}

class LiveSearch {
  constructor(cfg) {
    this.cfg = cfg;
    this.name = 'search:live';
  }

  get endpoint() {
    return this.cfg.endpoint || (this.cfg.serviceName ? `https://${this.cfg.serviceName}.search.windows.net` : '');
  }

  configured() {
    return Boolean(this.endpoint);
  }

  async _fetch(pathname, { method = 'GET', body, ok404 = false } = {}) {
    if (!this.endpoint) throw new Error('Azure AI Search is not configured (SEARCH_ENDPOINT).');
    const url = new URL(pathname, this.endpoint);
    url.searchParams.set('api-version', this.cfg.apiVersion);
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
      throw new Error(`AI Search ${method} ${pathname} failed ${res.status}: ${text.slice(0, 400)}`);
    }
    if (res.status === 204 || res.status === 202) return null;
    return res.json();
  }

  /* ------------------------------------------------------------ indexes */

  async getIndex(name) {
    return this._fetch(`/indexes/${encodeURIComponent(name)}`, { ok404: true });
  }

  async ensureIndex(definition) {
    const existing = await this.getIndex(definition.name);
    const desired = new Map(definition.fields.map((field) => [field.name, field]));
    // Search fields cannot be removed or retyped in place. Preserve the schema
    // already serving other clients and only append new fields.
    for (const field of existing?.fields || []) {
      if (desired.has(field.name) && desired.get(field.name).type !== field.type) throw new Error(`Search field ${field.name} has an incompatible type; use a reviewed index migration.`);
    }
    const body = existing ? {
      ...existing, ...definition,
      fields: [...existing.fields, ...definition.fields.filter((field) => !existing.fields.some((f) => f.name === field.name))]
    } : definition;
    delete body['@odata.etag'];
    await this._fetch(`/indexes/${encodeURIComponent(definition.name)}`, { method: 'PUT', body });
    return definition.name;
  }

  async capacity() {
    const stats = await this._fetch('/servicestats');
    return { used: stats.counters?.indexesCount?.usage, limit: stats.counters?.indexesCount?.quota };
  }

  async deleteIndex(name) {
    await this._fetch(`/indexes/${encodeURIComponent(name)}`, { method: 'DELETE', ok404: true });
  }

  async listIndexes() {
    const res = await this._fetch('/indexes?$select=name');
    return (res?.value || []).map((i) => i.name);
  }

  async indexStats(name) {
    const s = await this._fetch(`/indexes/${encodeURIComponent(name)}/stats`, { ok404: true });
    return s ? { documents: s.documentCount ?? 0, storageBytes: s.storageSize ?? 0 } : null;
  }

  /* -------------------------------------------------------- data sources */

  /**
   * A data source over one folder of the sample-data container, read with the
   * search service's own managed identity.
   */
  async ensureDataSource({ name, storageAccountId, container, folder }) {
    await this._fetch(`/datasources/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: {
        name,
        type: 'adlsgen2',
        credentials: { connectionString: `ResourceId=${storageAccountId};` },
        container: { name: container, query: folder || null },
        dataDeletionDetectionPolicy: null
      }
    });
    return name;
  }

  async deleteDataSource(name) {
    await this._fetch(`/datasources/${encodeURIComponent(name)}`, { method: 'DELETE', ok404: true });
  }

  /* ------------------------------------------------------------ indexers */

  async ensureIndexer({ name, dataSourceName, targetIndexName, schedule = 'PT2H' }) {
    await this._fetch(`/indexers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: {
        name,
        dataSourceName,
        targetIndexName,
        schedule: schedule ? { interval: schedule } : null,
        parameters: {
          configuration: {
            parsingMode: 'delimitedText',
            firstLineContainsHeaders: true,
            indexedFileNameExtensions: '.csv',
            dataToExtract: 'contentAndMetadata',
            failOnUnsupportedContentType: false,
            failOnUnprocessableDocument: false
          }
        },
        fieldMappings: [
          { sourceFieldName: 'AzureSearch_DocumentKey', targetFieldName: 'id', mappingFunction: { name: 'base64Encode' } },
          { sourceFieldName: 'metadata_storage_path', targetFieldName: 'url' },
          { sourceFieldName: 'metadata_storage_name', targetFieldName: 'title' }
        ]
      }
    });
    return name;
  }

  /** Start a run. 409 means one is already running, which is fine. */
  async runIndexer(name) {
    try {
      await this._fetch(`/indexers/${encodeURIComponent(name)}/run`, { method: 'POST' });
      return { started: true };
    } catch (err) {
      if (/ 409:/.test(err.message)) return { started: false, reason: 'already running' };
      throw err;
    }
  }

  async indexerStatus(name) {
    const s = await this._fetch(`/indexers/${encodeURIComponent(name)}/status`, { ok404: true });
    if (!s) return null;
    const last = s.lastResult || null;
    return {
      status: s.status,
      lastRun: last
        ? {
            status: last.status,
            processed: last.itemsProcessed ?? 0,
            failed: last.itemsFailed ?? 0,
            started: last.startTime,
            ended: last.endTime,
            errors: (last.errors || []).slice(0, 3).map((e) => e.errorMessage || e.message || String(e))
          }
        : null
    };
  }

  async deleteIndexer(name) {
    await this._fetch(`/indexers/${encodeURIComponent(name)}`, { method: 'DELETE', ok404: true });
  }

  /* -------------------------------------------------------------- query */

  /** A plain keyword search, for the entry page preview and for tests. */
  async search(indexName, text, { top = 5, select } = {}) {
    const res = await this._fetch(`/indexes/${encodeURIComponent(indexName)}/docs/search`, {
      method: 'POST',
      body: { search: text || '*', top, select: select ? select.join(',') : undefined, queryType: 'simple' }
    });
    return (res?.value || []).map((d) => {
      const { '@search.score': score, ...doc } = d;
      return { score, ...doc };
    });
  }

  async health() {
    if (!this.configured()) return { ok: false, mode: 'live', error: 'No search endpoint configured' };
    const started = Date.now();
    const names = await this.listIndexes();
    return {
      ok: true,
      mode: 'live',
      endpoint: this.endpoint,
      indexes: names.filter((n) => n.startsWith(this.cfg.indexPrefix)).length,
      latencyMs: Date.now() - started
    };
  }
}

export function createSearchAdapter() {
  return new LiveSearch(config.search);
}

export { LiveSearch };
