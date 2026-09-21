/**
 * Automate a task — recurring runs that draft, with a person at the checkpoint.
 *
 * CAP-151  Run an agent on a schedule
 * CAP-152  Turn an approved request method into a standing answer
 * CAP-153  See every run and what it produced
 * CAP-155  Pause, resume, delete
 *
 * THE RULE: EVERYTHING IS PROPOSE-ONLY.
 * An automation produces a DRAFT — text with its sources and the tools it
 * used — into its own run history, and nothing else. It does not send, post,
 * file or write to any system. There is no field on an automation that could
 * turn writing on, because the backlog puts that decision with the
 * accountable owner in a later phase, behind its own controls.
 *
 * Every automation states, in one sentence each: what it does, who is
 * accountable, what stops it and how it is undone. Those four are shown on
 * the automation page and cannot be blank.
 *
 * TWO KINDS
 *   agent   ask a named agent the same question on a schedule
 *   method  re-run an approved request method — the deck's "answer once,
 *           serve many": a holder approved the method when releasing an
 *           answer, so the same question can be answered again without them
 *
 * The scheduler is a timer inside the web app (one replica, see
 * containerapps.bicep). Runs are also triggered by hand from the page.
 */

import index from '../index/store.js';
import config from '../config.js';
import { collection } from '../state/store.js';
import { explainError } from './explain.js';
import { approvedMethods } from './requests.js';
import { ask } from './ask.js';

const store = () => collection('automations', { seq: 0, items: {} });

export const CADENCES = {
  'quarter-hourly': { label: 'Every 15 minutes', hint: 'For demonstrations. Turn it down afterwards.' },
  hourly: { label: 'Every hour', hint: 'On the hour.' },
  daily: { label: 'Every day', hint: 'At the time you choose (UTC).' },
  weekdays: { label: 'Every weekday', hint: 'Monday to Friday, at the time you choose (UTC).' },
  weekly: { label: 'Every week', hint: 'On the day and at the time you choose (UTC).' }
};

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** When should this run next, strictly after `from`? */
export function computeNextRun(a, from = new Date()) {
  const t = new Date(from.getTime());
  const [hh, mm] = String(a.at || '07:00').split(':').map((x) => Number(x) || 0);
  switch (a.cadence) {
    case 'quarter-hourly': {
      t.setUTCSeconds(0, 0);
      t.setUTCMinutes(Math.floor(t.getUTCMinutes() / 15) * 15 + 15);
      return t.toISOString();
    }
    case 'hourly': {
      t.setUTCMinutes(0, 0, 0);
      t.setUTCHours(t.getUTCHours() + 1);
      return t.toISOString();
    }
    case 'weekdays':
    case 'daily': {
      t.setUTCHours(hh, mm, 0, 0);
      if (t <= from) t.setUTCDate(t.getUTCDate() + 1);
      if (a.cadence === 'weekdays') while (t.getUTCDay() === 0 || t.getUTCDay() === 6) t.setUTCDate(t.getUTCDate() + 1);
      return t.toISOString();
    }
    case 'weekly': {
      const day = Number(a.dayOfWeek ?? 1);
      t.setUTCHours(hh, mm, 0, 0);
      while (t.getUTCDay() !== day || t <= from) t.setUTCDate(t.getUTCDate() + 1);
      return t.toISOString();
    }
    default:
      throw new Error(`Unknown cadence ${a.cadence}`);
  }
}

/** Validate a submitted form. Errors are GOV.UK error-summary shaped. */
export function validate(form, user) {
  const errors = [];
  const name = String(form.name || '').trim();
  const kind = form.kind === 'method' ? 'method' : 'agent';
  const question = String(form.question || '').trim();
  const cadence = String(form.cadence || 'daily');
  const at = String(form.at || '07:00').trim();
  const purpose = String(form.purpose || '').trim();

  if (!name) errors.push({ field: 'name', message: 'Give the automation a name that says what it does' });
  if (!CADENCES[cadence]) errors.push({ field: 'cadence', message: 'Choose how often it runs' });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) errors.push({ field: 'at', message: 'Enter a time as HH:MM, for example 07:30' });

  let agent = null;
  let method = null;
  if (kind === 'agent') {
    agent = form.agentId ? index.get(String(form.agentId)) : null;
    if (!agent || agent.cat !== 'Agent') errors.push({ field: 'agentId', message: 'Choose the agent that will do the work' });
    if (!question) errors.push({ field: 'question', message: 'Write the question the agent is asked each time' });
  } else {
    method = approvedMethods().find((m) => m.id === form.methodId) || null;
    if (!method) errors.push({ field: 'methodId', message: 'Choose an approved method' });
  }
  if (!purpose) errors.push({ field: 'purpose', message: 'Say what the drafts are for, in one sentence' });

  return {
    ok: errors.length === 0,
    errors,
    definition: {
      name,
      kind,
      agentId: agent?.id || null,
      agentName: agent?.name || null,
      methodId: method?.id || null,
      question: kind === 'agent' ? question : method?.question || '',
      cadence,
      at,
      dayOfWeek: Number(form.dayOfWeek ?? 1),
      purpose,
      owner: { name: user.name, email: user.email || null, id: user.id || null, team: user.team || null },
      ownerGroups: [...(user.groups || [])]
    }
  };
}

export function create(def) {
  const s = store();
  s.data.seq += 1;
  const id = `AUT-${String(s.data.seq).padStart(4, '0')}`;
  const now = new Date();
  const a = {
    id,
    ...def,
    writes: 'Nothing. Every run produces a draft into this page and stops.',
    stops: 'Pause or delete it here. It never writes, so nothing downstream needs stopping.',
    undo: 'Nothing to undo. A draft that is wrong is deleted with the run.',
    status: 'active',
    createdAt: now.toISOString(),
    nextRunAt: computeNextRun(def, now),
    lastRunAt: null,
    runs: []
  };
  s.data.items[id] = a;
  s.save();
  return a;
}

export function get(id) {
  return store().data.items[id] || null;
}

export function list() {
  return Object.values(store().data.items).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function mine(user) {
  return list().filter((a) => a.owner?.email === user.email || a.owner?.id === user.id || a.owner?.name === user.name);
}

export function setStatus(id, status) {
  const a = get(id);
  if (!a) return null;
  a.status = status === 'paused' ? 'paused' : 'active';
  if (a.status === 'active') a.nextRunAt = computeNextRun(a, new Date());
  store().save();
  return a;
}

export function remove(id) {
  const s = store();
  if (!s.data.items[id]) return false;
  delete s.data.items[id];
  s.save();
  return true;
}

export function deleteRun(id, runAt) {
  const a = get(id);
  if (!a) return false;
  a.runs = a.runs.filter((r) => r.at !== runAt);
  store().save();
  return true;
}

/**
 * Run one automation now. Records a run whatever happens. The draft is
 * computed inside the OWNER's permissions — the groups captured when they
 * set it up — never anyone else's.
 */
export async function runNow(id, { foundry = index.foundry, askFn = ask } = {}) {
  const a = get(id);
  if (!a) throw new Error(`Unknown automation ${id}`);
  const started = Date.now();
  const run = { at: new Date().toISOString(), status: 'ok', draft: null, sources: [], toolCalls: [], error: null, ms: 0, kind: a.kind };
  try {
    if (a.kind === 'agent') {
      const agent = index.get(a.agentId);
      if (!agent) throw new Error(`The agent ${a.agentName || a.agentId} is no longer in the register.`);
      const answer = await foundry.respond({ agentName: agent._source?.id || agent.id, input: a.question });
      run.draft = answer.text || '';
      run.sources = answer.sources || [];
      run.toolCalls = answer.toolCalls || [];
      if (answer.couldNotReach?.length) run.couldNotReach = answer.couldNotReach;
      index.upsert({ ...agent, calls: (Number(agent.calls) || 0) + 1 });
    } else {
      const owner = { ...a.owner, groups: a.ownerGroups || [], name: a.owner?.name, email: a.owner?.email, id: a.owner?.id };
      const r = await askFn(a.question, owner, {});
      run.draft = r.answer?.text || '';
      run.sources = (r.answer?.sources || []).map((s) => ({ name: s.name || s.entryName, url: s.url || (s.entryId ? `/entry/${s.entryId}` : null) }));
      run.couldNotReach = (r.answer?.couldNotReach || []).map((c) => c.name || c);
      run.engine = r.answer?.engine || null;
    }
  } catch (err) {
    run.status = 'failed';
    run.error = explainError(err);
  }
  run.ms = Date.now() - started;
  a.runs.unshift(run);
  a.runs = a.runs.slice(0, config.automations.maxRunsKept);
  a.lastRunAt = run.at;
  store().save();
  return run;
}

/** Run everything that is due. Returns the ids that ran. */
let ticking = false;
export async function tick({ now = new Date(), foundry = index.foundry, askFn = ask } = {}) {
  if (ticking) return [];
  ticking = true;
  const ran = [];
  try {
    for (const a of list()) {
      if (a.status !== 'active' || !a.nextRunAt) continue;
      if (new Date(a.nextRunAt) > now) continue;
      try {
        await runNow(a.id, { foundry, askFn });
      } finally {
        a.nextRunAt = computeNextRun(a, now);
        store().save();
      }
      ran.push(a.id);
    }
  } finally {
    ticking = false;
  }
  return ran;
}

let timer = null;
export function startScheduler() {
  if (timer || !config.automations.enabled) return null;
  timer = setInterval(() => {
    tick().catch((err) => console.error('[automations] tick failed', err.message));
  }, Math.max(15, config.automations.tickSeconds) * 1000);
  timer.unref?.();
  return timer;
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Tests only. */
export function clearAutomations() {
  const s = store();
  s.data.seq = 0;
  s.data.items = {};
}
