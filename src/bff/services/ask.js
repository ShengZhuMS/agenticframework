/**
 * Ask a question.
 *
 * CAP-001  Ask a question in my own words
 * CAP-002  Follow up in the same thread
 * CAP-003  Go back to a question I asked before
 * CAP-011  See where an answer came from
 * CAP-012  See the working when nothing was found
 * CAP-014  Jump from a claim to the entry it came from
 * CAP-021  Be offered a person when nothing connected can answer
 *
 * THE IMPORTANT PART
 * "What it could not reach" is computed from the visibility engine, not
 * invented. When a question matches a source the asker cannot see, Cortex
 * says so — by name — rather than quietly answering from less. That single
 * behaviour is what makes an answer here trustworthy in a way a chatbot over
 * a document store is not, and it is the same governance model the
 * Marketplace renders.
 */

import index from '../index/store.js';
import { visibilityFor, VIS } from './visibility.js';

/** In-memory threads. WP-scope: a demo needs history, not durability. */
const threads = new Map();

let threadSeq = 0;
function newThreadId() {
  threadSeq += 1;
  return `t${Date.now().toString(36)}-${threadSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const STOP = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'are',
  'was', 'were', 'how', 'what', 'which', 'who', 'when', 'where', 'why', 'many',
  'much', 'do', 'does', 'did', 'i', 'we', 'my', 'our', 'me', 'show', 'tell',
  'give', 'get', 'list', 'find', 'last', 'this', 'that', 'there', 'has', 'have'
]);

function terms(q) {
  return String(q)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/** Score an entry against the question. Deliberately simple and explainable. */
function relevance(entry, ts) {
  const hay = `${entry.name} ${entry.desc} ${entry.owner} ${entry.cluster} ${(entry.askable || []).join(' ')}`.toLowerCase();
  let score = 0;
  for (const t of ts) {
    if (entry.name.toLowerCase().includes(t)) score += 3;
    else if (hay.includes(t)) score += 1;
  }
  return score;
}

/**
 * Answer a question.
 *
 * Returns the answer, the sources used, and — the part that matters — every
 * relevant source that was NOT used, with the reason, so the asker can judge
 * how complete the answer is.
 */
export async function ask(question, user, { threadId } = {}) {
  const ts = terms(question);
  const scored = index
    .all()
    .map((e) => ({ entry: e, score: relevance(e, ts) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const reachable = [];
  const couldNotReach = [];
  const answerableByPerson = [];

  for (const { entry } of scored.slice(0, 12)) {
    const v = visibilityFor(entry, user);
    if (v.state === 'available') {
      reachable.push(entry);
    } else if (v.state === 'person') {
      answerableByPerson.push({ entry, reason: v.reason });
    } else {
      couldNotReach.push({ entry, state: v.state, reason: v.reason });
    }
  }

  const usable = reachable.slice(0, 4);
  let text;
  let confidence;

  if (!usable.length && !answerableByPerson.length) {
    // CAP-012 — the working, not a blank.
    text =
      `Nothing connected can answer that.\n\n` +
      `I looked across ${index.all().length} registered entries in ${index.clusters.length} clusters ` +
      `and found ${scored.length} that mention your terms, but none of them is reachable and ` +
      `none is answerable by a holder.\n\n` +
      `That may mean the data exists and is not registered, rather than that it does not exist.`;
    confidence = 'None';
  } else if (!usable.length) {
    text =
      `I cannot answer that from data you can reach, but somebody can answer it for you.\n\n` +
      answerableByPerson
        .map((a) => `${a.entry.owner} holds ${a.entry.name} and answers questions from it.`)
        .join('\n');
    confidence = 'None — routed to a person';
  } else {
    const names = usable.map((e) => e.name);
    text =
      `Answering from ${names.length} source${names.length > 1 ? 's' : ''} you can reach: ${names.join(', ')}.\n\n` +
      `This is a seeded response — the app is running with demo mode on, so no model was ` +
      `called. With the live adapter this answer comes from Foundry, streamed, and the ` +
      `panel below is built from its citation annotations rather than from the register.`;
    confidence = couldNotReach.length ? 'Medium' : 'High';
  }

  const answer = {
    question,
    text,
    confidence,
    sources: usable.map((e) => ({
      id: e.id,
      name: e.name,
      freshness: e.fresh,
      sensitivity: e.sens,
      owner: e.owner,
      used: describeUse(e, ts)
    })),
    couldNotReach: couldNotReach.map((c) => ({
      id: c.entry.id,
      name: c.entry.name,
      state: c.state,
      stateLabel: VIS[c.state]?.label,
      reason: c.reason,
      next: VIS[c.state]?.next
    })),
    answerableByPerson: answerableByPerson.map((a) => ({
      id: a.entry.id,
      name: a.entry.name,
      owner: a.entry.owner,
      askable: a.entry.askable || [],
      minAgg: a.entry.minAgg || null
    })),
    searched: index.all().length,
    matched: scored.length,
    askedAt: new Date().toISOString()
  };

  /**
   * Only continue a thread that exists AND belongs to the person asking.
   * A timestamp alone is not a safe id — two questions in the same
   * millisecond collide, and a collision across users would append one
   * person's question to another person's thread.
   */
  const existing = threadId ? threads.get(threadId) : null;
  const canContinue = existing && existing.user === user.id;

  const id = canContinue ? threadId : newThreadId();
  const thread = canContinue
    ? existing
    : { id, user: user.id, startedAt: new Date().toISOString(), turns: [] };

  thread.turns.push(answer);
  thread.title = thread.turns[0].question;
  threads.set(id, thread);

  return { answer, threadId: id, thread };
}

function describeUse(entry, ts) {
  const hit = ts.find((t) => entry.name.toLowerCase().includes(t));
  if (hit) return `Matched on "${hit}". ${entry.minAgg ? `Answers grouped to: ${entry.minAgg}` : 'Summary level only.'}`;
  return entry.minAgg ? `Answers grouped to: ${entry.minAgg}` : 'Summary level only.';
}

/** CAP-003 — previous conversations, grouped Today / Yesterday / Earlier. */
export function threadsFor(user) {
  const mine = [...threads.values()].filter((t) => t.user === user.id);
  const today = [];
  const yesterday = [];
  const earlier = [];
  const now = new Date();
  const dayOf = (d) => new Date(d).toDateString();

  for (const t of mine.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))) {
    const d = dayOf(t.startedAt);
    if (d === dayOf(now)) today.push(t);
    else if (d === dayOf(new Date(now.getTime() - 86400000))) yesterday.push(t);
    else earlier.push(t);
  }
  return { today, yesterday, earlier, total: mine.length };
}

export function getThread(id, user) {
  const t = threads.get(id);
  if (!t || t.user !== user.id) return null;
  return t;
}

export function clearThreads() {
  threads.clear();
}
