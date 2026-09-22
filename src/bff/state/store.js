/**
 * Light persistence — one JSON document per collection, in blob storage.
 *
 * WHY THIS EXISTS
 * Requests, Ask threads, agent chats, access requests, the record of what an
 * agent was built from and every automation used to live in the web app's
 * memory. A restart — which every deploy is — lost all of it, and the web
 * app had to be pinned to one replica so two copies could not disagree.
 *
 * This is the smallest thing that fixes that honestly: one JSON document per
 * collection, on storage that survives the container. It is NOT a database.
 * One replica still writes it (see webMaxReplicas), and the whole collection
 * is rewritten on every change — fine for hundreds of records, which is what
 * a proof of concept holds. The route to Cosmos DB is documented in
 * docs/HANDOVER.md when the numbers grow.
 *
 * THREE BACKENDS, ONE INTERFACE
 *   blob     the deployed shape. One blob per collection in a container on
 *            the state account, read and written with the app's managed
 *            identity through the Network Security Perimeter. No key anywhere.
 *            Round 4 mounted an Azure Files share with the account key; the
 *            tenant's policy disables account keys, the mount failed, and the
 *            container never started. Blobs need no mount and no key.
 *   files    a directory (CORTEX_STATE_DIR) — local development and tests.
 *   memory   neither configured. Callers cannot tell the difference.
 *
 * THE ONE RULE FOR THE BLOB BACKEND
 * Nothing is written unless the blobs were READ first. Starting empty because
 * storage was unreachable at boot and then saving would overwrite months of
 * state with nothing. So `primeState()` loads every collection before the
 * server listens; if that fails, the app runs on memory, says so on
 * /api/health/state, and writes nothing until a restart reads successfully.
 *
 * Every write is coalesced: several mutations inside a quarter of a second
 * produce one write. A failed write is logged once per collection, not once
 * per change, and never throws into a request.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LiveStorage } from '../adapters/storage.js';

const WRITE_DELAY_MS = 250;

const collections = new Map();
let stateDir = process.env.CORTEX_STATE_DIR || '';
let dirReady = null; // null = not checked, true/false afterwards

let blob = null; // { account, container, backend } in blob mode
let blobCache = null; // Map name -> JSON text, filled by primeState()
let blobError = null; // why priming failed, if it did

/** Point the store at a directory (or nothing). Tests use a temp dir; local runs use config. */
export function configureState(dir) {
  stateDir = dir || '';
  dirReady = null;
  blob = null;
  blobCache = null;
  blobError = null;
  collections.clear();
}

/**
 * Point the store at a blob container. `backend` is injectable for tests;
 * the default talks to Azure Storage with the managed identity.
 */
export function configureStateBlob({ account, container = 'state', scope = 'https://storage.azure.com/.default', backend } = {}) {
  stateDir = '';
  dirReady = null;
  collections.clear();
  blobCache = null;
  blobError = null;
  blob = { account, container, backend: backend || blobBackend(account, container, scope) };
}

function blobBackend(account, container, scope) {
  const storage = new LiveStorage({ storageAccount: account, container, scope });
  return {
    list: async () => (await storage.list(container)).map((b) => b.name).filter((n) => n.endsWith('.json') && !n.includes('/')),
    get: (name) => storage.download(container, name),
    put: (name, body) => storage.upload(container, name, body, 'application/json; charset=utf-8')
  };
}

/**
 * Read every collection from blob storage before anything asks for one.
 * Resolves, never rejects: a failure leaves the store in memory mode with the
 * reason recorded for the health endpoint.
 */
export async function primeState({ timeoutMs = 20_000 } = {}) {
  if (!blob) return { mode: stateDir ? 'files' : 'memory', primed: 0, error: null };
  const cache = new Map();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from blob storage within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    timer.unref?.();
  });
  try {
    const names = await Promise.race([blob.backend.list(), timeout]);
    for (const name of names) {
      const text = await Promise.race([blob.backend.get(name), timeout]);
      if (text != null) cache.set(name.replace(/\.json$/, ''), text);
    }
    blobCache = cache;
    blobError = null;
  } catch (err) {
    blobCache = null;
    blobError = err.message;
    console.warn(`[state] could not read state from ${blob.account}/${blob.container} — ${err.message}. Running on memory; nothing will be written until a restart reads it.`);
  } finally {
    clearTimeout(timer);
  }
  return { mode: blobError ? 'memory' : 'blob', primed: cache.size, error: blobError };
}

export function stateDirectory() {
  return blob ? `https://${blob.account}.blob.core.windows.net/${blob.container}` : stateDir;
}

function ensureDir() {
  if (dirReady !== null) return dirReady;
  if (!stateDir) {
    dirReady = false;
    return false;
  }
  try {
    mkdirSync(stateDir, { recursive: true });
    dirReady = true;
  } catch (err) {
    console.warn(`[state] cannot use ${stateDir} — ${err.message}. State is in memory only.`);
    dirReady = false;
  }
  return dirReady;
}

class Collection {
  constructor(name, initial) {
    this.name = name;
    this.file = stateDir ? path.join(stateDir, `${name}.json`) : null;
    this.persisted = false;
    this.lastError = null;
    this.timer = null;
    this.pending = Promise.resolve();
    this.data = this._load(initial);
  }

  _load(initial) {
    const fresh = typeof initial === 'function' ? initial() : structuredClone(initial);
    if (blob) {
      // Not primed, or primed and failed: memory, and never write (see the rule above).
      if (!blobCache || blobError) return fresh;
      this.persisted = true;
      const text = blobCache.get(this.name);
      if (text == null) return fresh;
      return this._parse(text, fresh, `${blob.container}/${this.name}.json`);
    }
    if (!ensureDir() || !this.file) return fresh;
    this.persisted = true;
    if (!existsSync(this.file)) return fresh;
    let text;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      console.warn(`[state] ${this.file} could not be read (${err.message}); starting empty.`);
      return fresh;
    }
    return this._parse(text, fresh, this.file);
  }

  _parse(text, fresh, where) {
    try {
      const parsed = JSON.parse(text);
      // A document from an older shape must not lose the keys the code now expects.
      return Array.isArray(fresh) ? parsed : { ...fresh, ...parsed };
    } catch (err) {
      console.warn(`[state] ${where} is not valid JSON (${err.message}); starting empty.`);
      return fresh;
    }
  }

  /** Coalesced write. Safe to call on every mutation. */
  save() {
    if (!this.persisted) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, WRITE_DELAY_MS);
    this.timer.unref?.();
  }

  /** Write now. Atomic where the file system allows it; serialised per collection for blobs. */
  flush() {
    if (!this.persisted) return this.pending;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const body = JSON.stringify(this.data, null, 2);
    if (blob) {
      const name = `${this.name}.json`;
      this.pending = this.pending
        .then(() => blob.backend.put(name, body))
        .then(
          () => {
            this.lastError = null;
          },
          (err) => {
            if (this.lastError !== err.message) console.warn(`[state] could not write ${blob.container}/${name} — ${err.message}`);
            this.lastError = err.message;
          }
        );
      return this.pending;
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, body, 'utf8');
      try {
        renameSync(tmp, this.file);
      } catch {
        // SMB shares occasionally refuse a rename over an existing file.
        writeFileSync(this.file, body, 'utf8');
      }
      this.lastError = null;
    } catch (err) {
      if (this.lastError !== err.message) console.warn(`[state] could not write ${this.file} — ${err.message}`);
      this.lastError = err.message;
    }
    return this.pending;
  }
}

/**
 * Open (or reuse) a named collection.
 * @param {string} name     file name without extension
 * @param {*} initial       the empty shape — an array, an object, or a factory
 */
export function collection(name, initial) {
  if (!collections.has(name)) collections.set(name, new Collection(name, initial));
  return collections.get(name);
}

/** Write every dirty collection now — called on shutdown. Awaitable in blob mode. */
export function flushAll() {
  return Promise.all([...collections.values()].map((c) => c.flush()));
}

/** For the Help page and /api/health/state. */
export function stateHealth() {
  const list = [...collections.values()];
  const clean = list.every((c) => !c.lastError);
  let mode = 'memory';
  let ok = true;
  if (blob) {
    mode = blobCache && !blobError ? 'blob' : 'memory';
    ok = !blobError && clean;
  } else if (stateDir) {
    mode = dirReady !== false ? 'azure-files' : 'memory';
    ok = dirReady !== false && clean;
  }
  return {
    ok,
    mode,
    directory: stateDirectory() || null,
    error: blobError,
    collections: list.map((c) => ({
      name: c.name,
      persisted: c.persisted,
      records: Array.isArray(c.data) ? c.data.length : Object.keys(c.data).length,
      error: c.lastError
    }))
  };
}

/** Tests only: forget every collection without touching storage. */
export function __resetState() {
  for (const c of collections.values()) if (c.timer) clearTimeout(c.timer);
  collections.clear();
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    flushAll();
  });
}
