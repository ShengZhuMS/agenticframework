import { randomUUID } from 'node:crypto';
import { collection } from '../state/store.js';
import index from '../index/store.js';
import { FoundryRedTeam, EVALUATOR_NAMES } from '../adapters/redteam.js';

const records = () => collection('redteam-runs', {});
const busy = new Set();
const hasTaxonomy = (taxonomy) => Array.isArray(taxonomy?.taxonomyCategories) && taxonomy.taxonomyCategories.length > 0;
export const canRedTeam = (entry, user) => Boolean(entry?.cat === 'Agent' && user?.id && (
  user.groups?.includes('cortex-redteam') ||
  (entry._agent?.definition?.builtById && entry._agent.definition.builtById === user.id)
));
export const runsFor = (agentId, user) => Object.values(records().data)
  .filter((r) => user?.id && r.agentId === agentId && r.ownerId === user.id)
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export const assessmentById = (id) => records().data[id] || null;
export const allAssessments = () => Object.values(records().data);
export const saveAssessments = () => persist();
export const agentVersion = (live) => live?.version || live?.versions?.[0]?.version || live?.versions?.latest?.version;

export function publicationVerdict(record) {
  if (record?.status !== 'completed' || record.error) return { passed: false, reason: record?.error || 'Assessment has not completed successfully.' };
  const counts = record.result?.result_counts;
  if (!counts || !(counts.passed > 0) || counts.failed !== 0 || (counts.errored ?? 0) !== 0 ||
      (counts.total !== undefined && counts.total !== counts.passed) || record.result?.error?.code || record.result?.error?.message) return { passed: false, reason: 'Foundry did not report a non-empty result with zero failed and errored samples.' };
  if (!record.items?.length || record.items.length !== counts.passed) return { passed: false, reason: 'The complete evaluation output is required before publishing.' };
  for (const item of record.items) {
    if (item.status !== 'pass' || !Array.isArray(item.results) ||
        !EVALUATOR_NAMES.every((name) => item.results.some((r) => r.name === name && r.passed === true)) ||
        item.results.some((r) => r.passed !== true)) {
      return { passed: false, reason: 'Every output item must pass all three configured evaluators. Review the Foundry report.' };
    }
  }
  return { passed: true, reason: 'All generated samples passed the configured Foundry evaluators.' };
}

async function persist() {
  const store = records();
  if (!store.persisted) throw new Error('Persistent state is required for billable assessments. Repair storage before red teaming.');
  await store.flush();
  if (store.lastError) throw new Error(`Assessment state could not be saved: ${store.lastError}`);
}

export async function prepare(entry, user, { adapter = new FoundryRedTeam(), foundry = index.foundry } = {}) {
  if (!canRedTeam(entry, user)) throw new Error('The agent builder or a cortex-redteam group member must start the assessment.');
  const agentName = entry._source?.id || entry.id;
  const live = await foundry.getAgent(agentName);
  const version = agentVersion(live);
  if (!version) throw new Error('Foundry did not return an agent version. Rebuild the agent before red teaming.');
  const record = {
    id: `rt-${randomUUID()}`, agentId: entry.id, ownerId: user.id,
    target: { type: 'azure_ai_agent', name: agentName, version: String(version) },
    createdAt: new Date().toISOString(), status: 'preparing'
  };
  records().data[record.id] = record;
  await persist();
  try {
    const evaluation = await adapter.createEvaluation(`Data Cortex ${record.id}`);
    if (!evaluation?.id) throw new Error('Foundry returned no evaluation id.');
    record.evalId = evaluation.id;
    await persist();
    record.taxonomyName = record.id;
    record.taxonomy = await adapter.createTaxonomy(record.taxonomyName, record.target);
    if (!record.taxonomy?.id) throw new Error('Foundry returned no taxonomy file id.');
    record.status = hasTaxonomy(record.taxonomy) ? 'review-required' : 'taxonomy-pending';
  } catch (err) {
    record.status = 'failed';
    record.error = err.message;
  }
  await persist();
  return record;
}

export async function act(id, user, action, { adapter = new FoundryRedTeam() } = {}) {
  const r = records().data[id];
  if (!user?.id || !r || r.ownerId !== user.id) throw new Error('This red team assessment does not belong to you.');
  if (!canRedTeam(index.get(r.agentId), user)) throw new Error('You no longer have access to assess this agent.');
  if (busy.has(id)) throw new Error('This assessment is already being updated.');
  busy.add(id);
  try {
    if (action === 'start') {
      if (r.status !== 'review-required' || !hasTaxonomy(r.taxonomy)) throw new Error('Only a reviewed, unstarted assessment with generated taxonomy categories can be submitted.');
      r.taxonomy = await adapter.enableTaxonomy(r.taxonomyName, r.taxonomy);
      if (!r.taxonomy?.id || !r.taxonomy.taxonomyCategories?.some((c) => c.subCategories?.some((s) => s.enabled === true))) {
        throw new Error('Foundry did not confirm an enabled taxonomy. Publication remains blocked.');
      }
      // Persist the intent before POST: an ambiguous timeout must never trigger an automatic duplicate run.
      r.status = 'submitting';
      r.reviewedAt = new Date().toISOString();
      await persist();
      const run = await adapter.start(r);
      if (!run?.id) throw new Error('Foundry returned no run id. Check Foundry before retrying.');
      r.runId = run.id;
      r.result = run;
      r.status = String(run.status || 'queued').toLowerCase();
    } else if (action === 'refresh') {
      if (r.status === 'taxonomy-pending') {
        r.taxonomy = await adapter.getTaxonomy(r.taxonomyName);
        if (!r.taxonomy?.id) throw new Error('Foundry returned no taxonomy file id.');
        if (hasTaxonomy(r.taxonomy)) r.status = 'review-required';
      } else {
        if (!r.runId) throw new Error('This assessment has no submitted run.');
        r.result = await adapter.getRun(r);
        r.status = String(r.result.status || 'unknown').toLowerCase();
        if (r.status === 'succeeded') r.status = 'completed';
        if (['completed', 'succeeded'].includes(r.status.toLowerCase())) r.items = await adapter.outputItems(r);
      }
    } else throw new Error('Unsupported red team action.');
    delete r.error;
    if (r.result?.error?.message || r.result?.error?.code) r.error = r.result.error.message || r.result.error.code;
  } catch (err) {
    r.error = err.message;
    if (r.status === 'submitting') r.status = 'submission-unknown';
  } finally {
    busy.delete(id);
    await persist();
  }
  return r;
}
