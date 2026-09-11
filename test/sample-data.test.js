/**
 * Sample data — synthetic, deterministic, and shaped for the Data Map and AI Search.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateProduct, sampleProductIds, SAMPLE_PRODUCTS } from '../scripts/sample-data.js';
import { parseCsvHeader, splitCsvLine } from '../src/bff/services/grounding.js';
import { fieldNameFor } from '../src/bff/adapters/search.js';

const products = JSON.parse(readFileSync(new URL('../bootstrap/data-products.json', import.meta.url), 'utf8'));

describe('sample data', () => {
  test('every data product in the content has a generator, and nothing else does', () => {
    assert.deepEqual(sampleProductIds().sort(), products.map((p) => p.id).sort());
  });

  test('is deterministic', () => {
    const a = generateProduct('finance-ledger');
    const b = generateProduct('finance-ledger');
    assert.equal(a.csv, b.csv);
    assert.notEqual(generateProduct('finance-ledger').csv, generateProduct('endpoint-telemetry').csv);
  });

  test('headers obey the Data Map schema rules and are valid search field names', () => {
    for (const id of sampleProductIds()) {
      const g = generateProduct(id, {}, { rows: 5 });
      const header = parseCsvHeader(g.csv);
      assert.deepEqual(header, g.columns.map((c) => c.name), id);
      assert.equal(new Set(header).size, header.length, `${id} duplicate column`);
      for (const h of header) {
        assert.match(h, /^[a-z][a-z0-9_]*$/, `${id}: ${h}`);
        assert.equal(fieldNameFor(h), h, `${id}: ${h} would be renamed by the index`);
      }
    }
  });

  test('every row has the right number of cells and the dictionary names every column', () => {
    for (const id of sampleProductIds()) {
      const g = generateProduct(id, products.find((p) => p.id === id), { rows: 50 });
      const lines = g.csv.trim().split('\n');
      assert.equal(lines.length, 51, id);
      const width = g.columns.length;
      for (const line of lines.slice(1)) {
        assert.equal(splitCsvLine(line).length, width, `${id}: ${line}`);
      }
      for (const c of g.columns) assert.match(g.readme, new RegExp(`\\| \\\`${c.name}\\\` \\|`), `${id} dictionary lacks ${c.name}`);
      assert.match(g.readme, /SYNTHETIC DATA/);
    }
  });

  test('row counts are demo-sized', () => {
    for (const [id, spec] of Object.entries(SAMPLE_PRODUCTS)) {
      assert.ok(spec.rows >= 500 && spec.rows <= 2000, `${id}: ${spec.rows}`);
    }
  });
});
