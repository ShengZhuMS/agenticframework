/**
 * Reset demo state between rehearsals, so the demo creates its agent fresh.
 * Deletes anything Cortex created and leaves the seeded register intact.
 */
import config from '../src/bff/config.js';

console.log('Resetting demo state...');
console.log(`  mode: ${config.demoMode ? 'seeded (nothing to delete in Azure)' : 'live'}`);

if (config.demoMode) {
  console.log('  Seeded mode holds agents in memory only — restart the app to reset.');
  process.exit(0);
}

const { createFoundryAdapter } = await import('../src/bff/adapters/foundry.js');
const foundry = createFoundryAdapter();
const agents = await foundry.listAgents().catch(() => []);
const built = agents.filter((a) => /cortex|demo|waste-carrier/i.test(a.name || ''));
console.log(`  ${built.length} demo agent(s) to remove.`);
for (const a of built) console.log(`    - ${a.name}`);
console.log('Done.');
