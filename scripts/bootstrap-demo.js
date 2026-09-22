import { fileURLToPath } from 'node:url';
import path from 'node:path';
import config, { hydrateConfig } from '../src/bff/config.js';
import index from '../src/bff/index/store.js';
import { configureStateBlob, primeState, collection } from '../src/bff/state/store.js';
import { DEMO_JOURNEY } from '../src/bff/services/demo-blueprints.js';
import { validateBuild, createAgent } from '../src/bff/services/agents.js';
import { artefactById, registerArtefact } from '../src/bff/services/artefacts.js';
import { connectors } from '../src/bff/adapters/connectors.js';
import * as automations from '../src/bff/services/automations.js';
import { LiveStorage } from '../src/bff/adapters/storage.js';
import { guidFor } from './bootstrap.js';

export const DEMO_GRAPHQL_ID = `cx-art-${guidFor('demo:operations-graphql')}`;
export const DEMO_EXTERNAL_ID = `cx-art-${guidFor('demo:existing-agent')}`;

export function demoWorkflowForm(agents) {
  const form = {
    name: DEMO_JOURNEY.automation.name, kind: 'workflow', question: DEMO_JOURNEY.automation.goal,
    purpose: 'Draft a synthetic, non-clinical operations briefing for human review.',
    cadence: 'manual', at: '07:00'
  };
  DEMO_JOURNEY.automation.steps.forEach((step, i) => {
    const agent = agents.find((entry) => entry.name === step.agent);
    if (!agent) throw new Error(`Demo agent not created: ${step.agent}`);
    form[`stepAgent${i + 1}`] = agent.id;
    form[`stepInstruction${i + 1}`] = step.instruction;
    form[`stepStage${i + 1}`] = step.stage;
  });
  return form;
}

export async function main(args = process.argv.slice(2)) {
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ dryRun: true, agents: DEMO_JOURNEY.agents, workflow: DEMO_JOURNEY.automation,
      graphqlId: DEMO_GRAPHQL_ID, externalId: DEMO_EXTERNAL_ID, note: 'No model calls, publication or state changes. Apply requires maintenance mode, complete grounding and an approving user ID.' }, null, 2));
    return;
  }
  const userId = args.find((arg) => arg.startsWith('--user-id='))?.slice(10);
  if (!/^[0-9a-f-]{36}$/i.test(userId || '')) throw new Error('Supply the approving user object ID with --user-id.');
  await hydrateConfig();
  if (!config.maintenance || !config.state.blobAccount) throw new Error('Run in maintenance mode with the deployed persistent state configuration.');
  configureStateBlob({ account: config.state.blobAccount, container: config.state.blobContainer, scope: config.state.scope });
  const primed = await primeState();
  if (primed.error) throw new Error(primed.error);
  await index.refresh();
  const user = { id: userId, name: 'Demo presenter', team: 'Your team', groups: ['all-staff'], clearance: 'Official', licences: ['internal', 'ogl'] };
  const created = [];
  for (const blueprint of DEMO_JOURNEY.agents) {
    const existing = index.all().find((entry) => entry.name === blueprint.name && entry.cat === 'Agent');
    if (existing) {
      if (existing._agent?.definition?.builtById !== user.id) throw new Error(`Refusing to reuse an agent owned by someone else: ${blueprint.name}`);
      created.push(existing); continue;
    }
    const knowledge = blueprint.knowledge.map((name) => index.all().find((entry) => entry.name === name && entry.cat === 'Data'));
    if (knowledge.some((entry) => !entry?._knowledge?.connectionId)) throw new Error(`Verified Foundry IQ grounding is missing for ${blueprint.name}. Complete --only=knowledge first.`);
    const result = await validateBuild({ name: blueprint.name, instructions: blueprint.instructions, model: config.foundry.model,
      knowledge: knowledge.map((entry) => entry.id), actions: ['read', 'summarise'], cluster: knowledge[0]?.cluster || index.clusters[0]?.id }, user);
    if (!result.ok) throw new Error(result.errors.map((error) => error.message).join('; '));
    const built = await createAgent(result.definition, user);
    created.push(built.entry);
    console.log(`AGENT ${built.entry.name}: ${built.entry.id}, version ${built.entry._agent.version}`);
  }
  const source = index.all().find((entry) => entry.name === 'Demo - Inventory levels' && entry.cat === 'Data');
  if (!source?.searchIndex) throw new Error('The seeded inventory index is required for the GraphQL example.');
  const metadata = {
    owner: user.team, contact: 'Use Cortex Requests to contact the demo owner', domain: source.cluster,
    version: '1.0.0', sensitivity: 'Internal', licence: 'Internal synthetic demonstration only',
    limitations: 'Synthetic records only; not clinical, regulatory or operational advice.', confirm: 'yes'
  };
  if (!artefactById(DEMO_GRAPHQL_ID)) {
    await registerArtefact({ ...metadata, kind: 'graphql', requestId: DEMO_GRAPHQL_ID.slice(7),
      sourceId: source.id, name: 'Demo - Operations GraphQL API', description: 'Read actual synthetic inventory rows through a bounded GraphQL query.',
      purpose: 'Demonstrate GraphQL-to-MCP reuse of existing data assets.' }, user, config.publicBaseUrl);
  }
  const connector = connectors().find((entry) => entry.provider === 'databricks');
  if (!connector) throw new Error('The approved Databricks connector is required for the existing-agent example.');
  if (!artefactById(DEMO_EXTERNAL_ID)) {
    await registerArtefact({ ...metadata, kind: 'external-agent', requestId: DEMO_EXTERNAL_ID.slice(7),
      connector: connector.id, sourceId: 'databricks-gpt-oss-20b', name: 'Demo - Databricks assistant',
      description: 'Draft wrapper for an existing Databricks serving endpoint; no company data is implied.',
      purpose: 'Show governed reuse of an existing agent.', assessmentMode: 'draft' }, user, config.publicBaseUrl);
  }
  let workflow = automations.mine(user).find((item) => item.name === DEMO_JOURNEY.automation.name);
  if (!workflow) {
    const checked = automations.validate(demoWorkflowForm(created), user);
    if (!checked.ok) throw new Error(checked.errors.map((error) => error.message).join('; '));
    workflow = automations.create(checked.definition);
  }
  for (const name of ['agents', 'artefacts', 'automations']) {
    const state = collection(name, {});
    await state.flush();
    if (state.lastError) throw new Error(`Seed persistence failed: ${state.lastError}`);
  }
  const storage = new LiveStorage({ storageAccount: config.state.blobAccount, scope: config.state.scope });
  const seedAgentIds = [...created.map((entry) => entry.id), artefactById(DEMO_EXTERNAL_ID)?.agentId].filter(Boolean);
  for (const container of ['state', 'state-cortex-web-microsoft', 'state-cortex-web-novo']) {
    if (container === config.state.blobContainer) continue;
    await storage.ensureContainer(container);
    for (const name of ['agents', 'artefacts', 'automations']) {
      const text = await storage.download(container, `${name}.json`);
      const target = text ? JSON.parse(text) : name === 'automations' ? { seq: 0, items: {} } : {};
      if (name === 'automations') {
        const existing = target.items[workflow.id];
        if (existing && (existing.name !== workflow.name || existing.owner?.id !== user.id)) throw new Error(`Refusing to overwrite another workflow in ${container}.`);
        target.seq = Math.max(target.seq, Number(workflow.id.replace('AUT-', '')));
        target.items[workflow.id] = { ...workflow, runs: existing?.runs || workflow.runs };
      } else {
        const ids = name === 'agents' ? seedAgentIds : [DEMO_GRAPHQL_ID, DEMO_EXTERNAL_ID];
        for (const id of ids) {
          const existingOwner = target[id]?.ownerId || target[id]?._agent?.definition?.builtById;
          if (existingOwner && existingOwner !== user.id) throw new Error(`Refusing to overwrite another owner's ${id} in ${container}.`);
          target[id] = collection(name, {}).data[id];
        }
      }
      const body = JSON.stringify(target);
      await storage.upload(container, `${name}.json`, body, 'application/json');
      if (await storage.download(container, `${name}.json`) !== body) throw new Error(`Seed copy verification failed: ${container}/${name}`);
    }
  }
  console.log(JSON.stringify({ seededAgents: created.map((entry) => ({ id: entry.id, name: entry.name })), workflow: workflow.id,
    graphql: { id: DEMO_GRAPHQL_ID, url: `${config.apim.gatewayUrl}/${DEMO_GRAPHQL_ID}/graphql` },
    external: DEMO_EXTERNAL_ID, nativeRedTeamRunsStarted: 0, scheduledRunsEnabled: false }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
