/**
 * Light persistence — JSON files on a mounted Azure Files share.
 *
 * WHY THIS EXISTS
 * Requests, Ask threads, agent chats, access requests, the record of what an
 * agent was built from and every automation used to live in the web app's
 * memory. A restart — which every deploy is — lost all of it, and the web
 * app had to be pinned to one replica so two copies could not disagree.
 *
 * This is the smallest thing that fixes that honestly: one JSON file per
 * collection, written atomically, on a share that survives the container.
 * It is NOT a database. One replica still writes it (see webMaxReplicas), and
 * the whole collection is rewritten on every change — fine for hundreds of
 * records, which is what a proof of concept holds. The route to Cosmos DB is
 * documented in docs/HANDOVER.md when the numbers grow.
 *
 * WHEN THERE IS NO SHARE
 * CORTEX_STATE_DIR unset (local development, tests) keeps everything in
 * memory exactly as before. The callers do not know the difference.
 *
 * Every write is coalesced: several mutations inside a quarter of a second
 * produce one file write. A failed write is logged once per collection, not
 * once per change, and never throws into a request.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WRITE_DELAY_MS = 250;

const collections = new Map();
let stateDir = process.env.CORTEX_STATE_DIR || '';
let dirReady = null; // null = not checked, true/false afterwards

/** Point the store at a directory. Tests use a temp dir; the app uses config. */
export function configureState(dir) {
  stateDir = dir || '';
  dirReady = null;
  collections.clear();
}

export function stateDirectory() {
  return stateDir;
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
    this.data = this._load(initial);
  }

  _load(initial) {
    const fresh = typeof initial === 'function' ? initial() : structuredClone(initial);
    if (!ensureDir() || !this.file) return fresh;
    this.persisted = true;
    if (!existsSync(this.file)) return fresh;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      // A file from an older shape must not lose the keys the code now expects.
      return Array.isArray(fresh) ? parsed : { ...fresh, ...parsed };
    } catch (err) {
      console.warn(`[state] ${this.file} could not be read (${err.message}); starting empty.`);
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

  /** Write now. Atomic where the file system allows it. */
  flush() {
    if (!this.persisted) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const body = JSON.stringify(this.data, null, 2);
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

/** Write every dirty collection now — called on shutdown. */
export function flushAll() {
  for (const c of collections.values()) c.flush();
}

/** For the Help page and /api/health/state. */
export function stateHealth() {
  const list = [...collections.values()];
  return {
    ok: !stateDir || (dirReady !== false && list.every((c) => !c.lastError)),
    directory: stateDir || null,
    mode: stateDir && dirReady !== false ? 'azure-files' : 'memory',
    collections: list.map((c) => ({
      name: c.name,
      persisted: c.persisted,
      records: Array.isArray(c.data) ? c.data.length : Object.keys(c.data).length,
      error: c.lastError
    }))
  };
}

/** Tests only: forget every collection without touching disk. */
export function __resetState() {
  for (const c of collections.values()) if (c.timer) clearTimeout(c.timer);
  collections.clear();
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    flushAll();
  });
}
