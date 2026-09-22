/**
 * Chat with an agent — a multi-turn conversation, one window per agent.
 *
 * CAP-071  Talk to an agent somebody else built
 * CAP-072  Follow up in the same conversation
 * CAP-011  See where an answer came from
 *
 * HOW A THREAD WORKS
 * Foundry keeps the conversation: each turn is a Responses call carrying
 * previous_response_id, so the model sees the whole exchange without Cortex
 * storing prompts anywhere it should not. Cortex keeps the transcript for the
 * person who had it — so the window can be reopened — and the provenance of
 * each answer: what tools were called, what was cited, what failed.
 *
 * WHO MAY CHAT
 * Phase rule, set by CORTEX_CHAT_POLICY:
 *   all-staff  (default now) every signed-in person may chat with every agent
 *   visibility the Marketplace rules apply — only agents you could attach
 * The check is server-side on every turn, not only when the window opens.
 *
 * Threads belong to the person who started them. Nobody else can read or
 * continue them, including the agent's builder.
 */

import index from '../index/store.js';
import config from '../config.js';
import { attachableFor } from './visibility.js';
import { collection } from '../state/store.js';
import { explainError } from './explain.js';
import { runtimeToolOptions } from './agents.js';

const threads = () => collection('chats', {});
const busy = new Set();

let seq = 0;
function newId() {
  seq += 1;
  return `c${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function owns(thread, user) {
  if (!thread || !user) return false;
  if (thread.userId) return Boolean(user.id && thread.userId === user.id);
  if (thread.userEmail && user.email && thread.userEmail.toLowerCase() === String(user.email).toLowerCase()) return true;
  return false;
}

/** May this person chat with this agent? */
export function canChat(entry, user) {
  if (!entry || entry.cat !== 'Agent') return { allowed: false, reason: 'Only agents can be chatted with.' };
  if (!user?.id) return { allowed: false, reason: 'Sign in first.' };
  if (config.chat.policy === 'visibility') {
    const a = attachableFor(entry, user);
    return a.attachable ? { allowed: true, reason: null } : { allowed: false, reason: a.reason || 'You cannot reach this agent.' };
  }
  return { allowed: true, reason: null, policy: 'all-staff' };
}

export function getThread(id, user) {
  const t = threads().data[id];
  return owns(t, user) ? t : null;
}

/** This person's threads with one agent, newest first. */
export function threadsFor(agentId, user) {
  return Object.values(threads().data)
    .filter((t) => t.agentId === agentId && owns(t, user))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export function startThread(entry, user) {
  const permission = canChat(entry, user);
  if (!permission.allowed) throw Object.assign(new Error(permission.reason), { code: 403 });
  const now = new Date().toISOString();
  const t = {
    id: newId(),
    agentId: entry.id,
    agentName: entry.name,
    userId: user.id || null,
    userEmail: user.email || null,
    userName: user.name || null,
    createdAt: now,
    updatedAt: now,
    lastResponseId: null,
    agentVersion: entry._agent?.publishedVersion || null,
    turns: []
  };
  threads().data[t.id] = t;
  threads().save();
  return t;
}

export function deleteThread(id, user) {
  const t = getThread(id, user);
  if (!t) return false;
  delete threads().data[id];
  threads().save();
  return true;
}

/**
 * One turn. Never throws for a model failure: the turn records what went
 * wrong in plain language and the thread stays usable.
 */
export async function chat(entry, question, user, { threadId, foundry = index.foundry } = {}) {
  const permission = canChat(entry, user);
  if (!permission.allowed) {
    const err = new Error(permission.reason);
    err.code = 403;
    throw err;
  }
  const q = String(question || '').trim();
  if (!q || q.length > 8000) {
    const err = new Error('Enter a message between 1 and 8,000 characters.');
    err.code = 400;
    throw err;
  }
  let thread = threadId ? getThread(threadId, user) : null;
  if (threadId && (!thread || thread.agentId !== entry.id)) throw Object.assign(new Error('This conversation is not available for this agent and user.'), { code: 404 });
  if (!thread) thread = startThread(entry, user);
  if (busy.has(thread.id)) throw Object.assign(new Error('Wait for the current answer before sending another message.'), { code: 409 });
  if (thread.turns.length >= config.chat.maxTurns) {
    const err = new Error(`This conversation has reached ${config.chat.maxTurns} turns. Start a new one.`);
    err.code = 409;
    throw err;
  }

  const started = Date.now();
  const turn = { at: new Date().toISOString(), question: q, answer: null, error: null, ms: 0 };
  busy.add(thread.id);
  try {
  try {
    const answer = await foundry.respond({
      ...runtimeToolOptions(entry),
      agentName: entry._source?.id || entry.id,
      agentVersion: thread.agentVersion || undefined,
      input: q,
      previousResponseId: thread.lastResponseId || undefined
    });
    if (!answer.text?.trim()) throw new Error('The agent returned no answer. Inspect the agent configuration and try again.');
    turn.answer = {
      text: answer.text || '',
      sources: answer.sources || [],
      toolCalls: answer.toolCalls || [],
      couldNotReach: answer.couldNotReach || [],
      pendingApprovals: answer.pendingApprovals || 0,
      model: answer.model || null
    };
    if (answer.responseId) thread.lastResponseId = answer.responseId;
    index.upsert({ ...entry, calls: (Number(entry.calls) || 0) + 1 });
  } catch (err) {
    turn.error = explainError(err);
    // A failed turn does not advance the Foundry thread, so the next question
    // continues from the last good answer.
  }
  turn.ms = Date.now() - started;
  thread.turns.push(turn);
  thread.updatedAt = new Date().toISOString();
  await threads().flush();
  if (threads().lastError) throw Object.assign(new Error(`The answer could not be saved: ${threads().lastError}`), { code: 503 });
  return { thread, turn };
  } finally { busy.delete(thread.id); }
}

/** Tests only. */
export function clearChats() {
  const col = threads();
  for (const k of Object.keys(col.data)) delete col.data[k];
  seq = 0;
}
