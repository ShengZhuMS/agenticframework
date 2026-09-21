import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const products = JSON.parse(readFileSync(new URL('../bootstrap/data-products.json', import.meta.url), 'utf8'));
export const SAMPLE_PRODUCTS = Object.fromEntries(products.map((p, i) => [p.id, {
  rows: 750 + i * 50,
  columns: [
    ['record_id', 'string', 'Fictional record identifier'],
    ['observed_date', 'date', 'Synthetic reporting date'],
    ['business_unit', 'string', 'Fictional business unit'],
    ['site_reference', 'string', 'Fictional site, not a real address'],
    [p.metric, 'number', `Synthetic ${p.metric.replaceAll('_', ' ')} (${p.unit})`],
    ['review_status', 'string', 'Synthetic review status'],
    ['is_synthetic', 'string', 'Always true: demonstration content only']
  ]
}]));

export function generateProduct(id, product = {}, { rows } = {}) {
  const spec = SAMPLE_PRODUCTS[id];
  if (!spec) throw new Error(`No sample generator for ${id}`);
  const count = rows ?? spec.rows;
  if (!Number.isInteger(count) || count < 0 || count > 10000) throw new Error('Row count must be an integer from 0 to 10,000.');
  const metadata = { ...products.find((p) => p.id === id), ...product };
  let seed = 2166136261;
  for (const c of id) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const columns = spec.columns.map(([name, type, description]) => ({ name, type, description }));
  const lines = [columns.map((c) => c.name).join(',')];
  for (let i = 0; i < count; i++) {
    const date = new Date(Date.UTC(2026, 0, 1 + (i % 240))).toISOString().slice(0, 10);
    lines.push([`SYN-${i + 1}`, date, `Unit-${1 + i % 5}`, `Site-${1 + i % 12}`,
      (random() * 100).toFixed(2), ['reviewed', 'pending', 'needs-review'][i % 3], 'true'].join(','));
  }
  const csv = lines.join('\n') + '\n';
  const readme = `# ${metadata.name} - sample data

> **SYNTHETIC DATA.** Fixed-seed demonstration rows. No real customers, employees, transactions or measurements.

${metadata.description}

Domain: ${metadata.domain}. Sensitivity: ${metadata.sensitivity}. Licence: ${metadata.licence}.
Rows: ${count}. Minimum aggregation: ${metadata.minimumAggregation || 'None stated'}.

| Column | Type | Meaning |
|---|---|---|
${columns.map((c) => `| \`${c.name}\` | ${c.type} | ${c.description} |`).join('\n')}

## Limitations
${metadata.limitations}

## Dependencies
${(metadata.dependsOn || []).join(', ') || 'None recorded'}
`;
  return { id, csv, readme, columns, rowCount: count, bytes: Buffer.byteLength(csv) };
}

export const sampleProductIds = () => Object.keys(SAMPLE_PRODUCTS);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const out = args.find((a) => a.startsWith('--out='))?.slice(6) || (args.includes('--out') ? args[args.indexOf('--out') + 1] : null);
  for (const id of sampleProductIds()) {
    const g = generateProduct(id);
    if (out && !args.includes('--list')) {
      const dir = path.join(out, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${id}.csv`), g.csv);
      writeFileSync(path.join(dir, 'README.md'), g.readme);
    }
    console.log(`${id}: ${g.rowCount} synthetic rows, ${g.columns.length} columns`);
  }
}
