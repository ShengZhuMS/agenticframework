import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { splitCsvLine } from './grounding.js';

const skills = JSON.parse(readFileSync(new URL('../../../bootstrap/skills.json', import.meta.url), 'utf8'));

export function gatewayKeyMatches(supplied, expected) {
  if (typeof supplied !== 'string' || !expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function invokeDemoSkill(id, query, storage, container) {
  const skill = skills.find((s) => s.id === id);
  if (!skill) return null;
  const file = `${skill.productId}/${skill.productId}.csv`;
  const text = await storage.head(container, file, 65536);
  const lines = text.split('\n');
  lines.pop(); // A range read may end in the middle of a record.
  const columns = splitCsvLine(lines.shift() || '');
  const matching = lines.filter((line) => !query || line.toLowerCase().includes(query.toLowerCase()));
  const rows = matching.slice(0, 20).map((line) => Object.fromEntries(splitCsvLine(line).map((value, i) => [columns[i], value])));
  return { synthetic: true, skill: skill.name, query, rows,
    source: storage.blobUrl(container, file),
    limitations: 'Bounded sample of the uploaded synthetic file (first 64 KiB, at most 20 matches). Not a complete query or live business data.' };
}
