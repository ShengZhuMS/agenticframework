import { readFileSync } from 'node:fs';
export const DEMO_JOURNEY = JSON.parse(readFileSync(new URL('../../../bootstrap/demo-journey.json', import.meta.url), 'utf8'));

export function blueprintForm(template, knowledge, existingNames = []) {
  if (!/^\d+$/.test(String(template)) || !DEMO_JOURNEY.agents[Number(template)]) throw new Error('Choose a listed demo blueprint.');
  const blueprint = DEMO_JOURNEY.agents[Number(template)];
  const selected = blueprint.knowledge.map((name) => knowledge.find((entry) => entry.name === name && entry.attachable));
  if (selected.some((entry) => !entry)) throw new Error('This blueprint needs its named synthetic sources to be registered and accessible. Bootstrap the demo content or choose sources manually.');
  let name = blueprint.name;
  for (let i = 1; existingNames.includes(name); i++) name = `${blueprint.name} - workshop ${i}`;
  return { name, instructions: blueprint.instructions, knowledge: selected.map((entry) => entry.id) };
}
