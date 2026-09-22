import { randomUUID } from 'node:crypto';
import index from '../index/store.js';
import { collection } from '../state/store.js';
import { attachableFor } from './visibility.js';
import { buildIndex, dataFolderFor } from './grounding.js';
import { connectionNameFor, ensureKnowledgeConnection } from '../adapters/foundry-connections.js';

const jobs = () => collection('knowledge-jobs', {});
const active = new Set();
export const sourceOptions = (user) => index.all().filter((entry) => entry.cat === 'Data' && entry._source?.system === 'purview' && attachableFor(entry, user).attachable);
export const knowledgeJobs = (user) => Object.values(jobs().data).filter((job) => job.ownerId === user.id);

async function save(job) {
  const store = jobs();
  if (!store.persisted) throw new Error('Persistent state is required before provisioning knowledge resources.');
  store.data[job.id] = job;
  await store.flush();
  if (store.lastError) throw new Error(`Could not persist knowledge progress: ${store.lastError}`);
}

export async function startKnowledge(form, user, { build = buildIndex } = {}) {
  const source = sourceOptions(user).find((entry) => entry.id === form.sourceId);
  if (!source) throw new Error('Choose an accessible registered source.');
  if (form.confirm !== 'yes') throw new Error('Confirm indexing, derived storage and Azure usage first.');
  const name = String(form.name || source.name).trim();
  if (!name || name.length > 100) throw new Error('Use a name of 1 to 100 characters.');
  const existing = knowledgeJobs(user).find((job) => job.sourceId === source.id);
  if (existing?.indexing) return existing;
  const job = existing || { id: `cx-iq-${randomUUID()}`, sourceId: source.id, name, ownerId: user.id, owner: user.team, createdAt: new Date().toISOString(), status: 'preparing' };
  if (active.has(job.id)) throw new Error('This source is already being prepared.');
  active.add(job.id);
  try {
    await save(job);
    job.startedAt = new Date().toISOString();
    // Reuse the product index instead of consuming another slot on Basic.
    job.indexing = await build(source, { semantic: true });
    job.status = 'indexing';
    delete job.error;
  } catch (err) {
    job.status = 'blocked';
    job.error = err.message;
  } finally { active.delete(job.id); }
  await save(job);
  return job;
}

export async function finishKnowledge(id, user, { search = index.search, connect = ensureKnowledgeConnection } = {}) {
  const job = jobs().data[id];
  if (!job || job.ownerId !== user.id) throw new Error('This publication does not belong to you.');
  if (!job.indexing) throw new Error(job.error || 'Index setup did not complete; resolve the prerequisite and submit the source again.');
  const source = sourceOptions(user).find((entry) => entry.id === job.sourceId);
  if (!source) throw new Error('You no longer have access to the source.');
  if (active.has(id)) throw new Error('This publication is already being refreshed.');
  active.add(id);
  try {
    const status = await search.indexerStatus(job.indexing.indexer);
    if (!status?.lastRun?.ended || status.lastRun.status === 'inProgress' ||
        (job.indexing.run?.started && Date.parse(status.lastRun.started) < Date.parse(job.startedAt) - 5000)) {
      job.status = 'indexing';
      job.error = 'The current indexer run has not completed. Refresh later; no artefact has been published.';
    } else if (status.lastRun.status !== 'success' || status.lastRun.failed > 0) {
      throw new Error(`Indexer did not complete successfully: ${(status.lastRun.errors || []).join('; ') || status.lastRun.status}`);
    } else {
      const stats = await search.indexStats(job.indexing.index);
      if (!(stats?.documents > 0)) throw new Error('The index contains no documents. Check the source folder and CSV format.');
      const kb = await search.ensureKnowledgeBase({ name: source._knowledge?.name || job.id, indexName: job.indexing.index, description: `Cortex knowledge: ${job.name}` });
      const connection = await connect({ name: connectionNameFor(kb.name, 'cx-iq-'), target: kb.mcp });
      index.upsert({
        id: job.id, name: job.name, cat: 'Data', desc: `Foundry IQ knowledge base over ${source.name}. ${kb.reasoning === 'low' ? 'Uses the administrator-configured model for query planning and returns grounding evidence.' : 'Minimal extractive retrieval; model planning is not enabled.'}`,
        cluster: source.cluster, owner: user.team, ownerState: 'confirmed', sens: source.sens,
        allowedGroups: source.allowedGroups, access: source.access, licence: source.licence, deps: [source.id],
        searchIndex: job.indexing.index, dataFolder: dataFolderFor(source),
        _source: { system: 'cortex', id: job.id, maintainedBy: 'human' },
        _endpoints: { mcp: kb.mcp }, _knowledge: { ...kb, connectionId: connection.id, documents: stats.documents },
        limits: 'Search contains derived copies. Foundry project identity requires Search access. Caller-level document ACLs are not automatically configured.'
      });
      const records = collection('knowledge-artefacts', {});
      await records.flush();
      if (records.lastError) throw new Error(`Knowledge resources exist but catalogue persistence failed: ${records.lastError}`);
      job.status = 'published';
      job.entryId = job.id;
      job.documents = stats.documents;
      delete job.error;
    }
  } catch (err) {
    job.status = 'blocked';
    job.error = err.message;
  } finally { active.delete(id); }
  await save(job);
  return job;
}
