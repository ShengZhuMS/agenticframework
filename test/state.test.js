/**
 * Light persistence — a collection survives a restart, and memory mode
 * behaves identically when there is no share.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configureState, collection, flushAll, stateHealth, __resetState } from '../src/bff/state/store.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cortex-state-'));
});
afterEach(() => {
  configureState('');
  __resetState();
  rmSync(dir, { recursive: true, force: true });
});

describe('state store', () => {
  test('writes a collection to the directory and reads it back after a "restart"', () => {
    configureState(dir);
    const c = collection('things', { seq: 0, items: {} });
    c.data.seq = 3;
    c.data.items.a = { name: 'A' };
    c.save();
    flushAll();
    assert.ok(existsSync(path.join(dir, 'things.json')));
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'things.json'), 'utf8')).seq, 3);

    __resetState(); // forget everything in memory, as a restart would
    configureState(dir);
    const again = collection('things', { seq: 0, items: {} });
    assert.equal(again.data.seq, 3);
    assert.equal(again.data.items.a.name, 'A');
  });

  test('a newer shape keeps its new keys when an older file is loaded', () => {
    configureState(dir);
    const c = collection('shape', { seq: 0, items: {} });
    c.save();
    flushAll();
    __resetState();
    configureState(dir);
    const v2 = collection('shape', { seq: 0, items: {}, methods: {} });
    assert.deepEqual(Object.keys(v2.data).sort(), ['items', 'methods', 'seq']);
  });

  test('with no directory everything stays in memory and health says so', () => {
    configureState('');
    const c = collection('mem', []);
    c.data.push(1);
    c.save();
    flushAll();
    const h = stateHealth();
    assert.equal(h.mode, 'memory');
    assert.equal(h.ok, true);
    assert.equal(h.collections[0].persisted, false);
  });

  test('an unwritable directory degrades to memory rather than throwing', () => {
    // A path underneath a regular FILE can never be a directory.
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    configureState(path.join(blocker, 'cortex'));
    const c = collection('x', []);
    c.data.push(1);
    assert.doesNotThrow(() => c.flush());
    assert.equal(stateHealth().mode, 'memory');
  });
});
