/**
 * Azure Storage adapter — the sample data products' files.
 *
 * Plain Blob REST with an Entra token (scope https://storage.azure.com/.default).
 * No account key anywhere: the caller — your signed-in account during
 * bootstrap, the Cortex identity at runtime — holds Storage Blob Data
 * Contributor on the account (infra/modules/data.bicep). The account is ADLS
 * Gen2 (hierarchical namespace) because that is what the Purview Data Map
 * scans best, but the Blob endpoint works on it unchanged.
 *
 *   PUT  https://<account>.blob.core.windows.net/<container>?restype=container
 *   PUT  https://<account>.blob.core.windows.net/<container>/<path>   x-ms-blob-type: BlockBlob
 *   GET  https://<account>.blob.core.windows.net/<container>?restype=container&comp=list&prefix=…
 */

import config from '../config.js';
import { getToken } from './token.js';

const bearer = (token) => ['Bearer', token].join(' ');
const API_VERSION = '2023-11-03';

class LiveStorage {
  constructor(cfg) {
    this.cfg = cfg;
    this.name = 'storage:live';
  }

  configured() {
    return Boolean(this.cfg.storageAccount);
  }

  blobUrl(container, blobPath = '') {
    const p = blobPath ? `/${String(blobPath).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}` : '';
    return `https://${this.cfg.storageAccount}.blob.core.windows.net/${container}${p}`;
  }

  /** The HTTPS path of a file as the Data Map records it (dfs endpoint). */
  dfsUrl(container, blobPath) {
    return `https://${this.cfg.storageAccount}.dfs.core.windows.net/${container}/${String(blobPath).replace(/^\/+/, '')}`;
  }

  async _fetch(url, { method = 'GET', body, headers = {}, ok = [] } = {}) {
    if (!this.configured()) throw new Error('The sample-data storage account is not configured (DATA_STORAGE_ACCOUNT).');
    const token = await getToken(this.cfg.scope);
    const res = await fetch(url, {
      method,
      headers: { Authorization: bearer(token), 'x-ms-version': API_VERSION, ...headers },
      body,
      signal: AbortSignal.timeout(60_000)
    });
    if (!res.ok && !ok.includes(res.status)) {
      const text = await res.text().catch(() => '');
      const hint =
        res.status === 403
          ? ` — grant the signed-in account Storage Blob Data Contributor on ${this.cfg.storageAccount} (Deploy-Cortex.ps1 does this when it knows who is deploying)`
          : '';
      throw new Error(`Storage ${method} ${new URL(url).pathname} failed ${res.status}: ${text.slice(0, 300)}${hint}`);
    }
    return res;
  }

  async ensureContainer(container) {
    const res = await this._fetch(`${this.blobUrl(container)}?restype=container`, { method: 'PUT', ok: [409] });
    return { created: res.status === 201 };
  }

  async upload(container, blobPath, content, contentType = 'text/plain; charset=utf-8') {
    const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    await this._fetch(this.blobUrl(container, blobPath), {
      method: 'PUT',
      body,
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': contentType,
        'Content-Length': String(body.length)
      }
    });
    return { url: this.blobUrl(container, blobPath), dfsUrl: this.dfsUrl(container, blobPath), bytes: body.length };
  }

  /** The first `bytes` of a blob — enough for a CSV header line. */
  async head(container, blobPath, bytes = 8192) {
    const res = await this._fetch(this.blobUrl(container, blobPath), {
      headers: { Range: `bytes=0-${bytes - 1}` },
      ok: [416]
    });
    if (res.status === 416) return '';
    return res.text();
  }

  /** Names and sizes under a prefix. The listing is XML; a small regex pass is enough. */
  async list(container, prefix = '') {
    const res = await this._fetch(
      `${this.blobUrl(container)}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}`,
      { ok: [404] }
    );
    if (res.status === 404) return [];
    const xml = await res.text();
    const out = [];
    for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
      const name = m[1].match(/<Name>([^<]*)<\/Name>/)?.[1];
      const size = Number(m[1].match(/<Content-Length>(\d+)<\/Content-Length>/)?.[1] || 0);
      const modified = m[1].match(/<Last-Modified>([^<]*)<\/Last-Modified>/)?.[1] || null;
      if (name) out.push({ name: decodeXml(name), size, modified });
    }
    return out;
  }

  async health() {
    if (!this.configured()) return { ok: false, mode: 'live', error: 'No storage account configured' };
    const started = Date.now();
    const files = await this.list(this.cfg.container);
    return { ok: true, mode: 'live', account: this.cfg.storageAccount, files: files.length, latencyMs: Date.now() - started };
  }
}

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

export function createStorageAdapter() {
  return new LiveStorage(config.data);
}

export { LiveStorage };
