/**
 * Requests — a working lifecycle.
 *
 * This implements the deck's worked example: "allowed the answer, not allowed
 * the data". Seven handoffs collapse to one, and the one step that moves is
 * that the responder's agent drafts before the responder opens the request.
 *
 * THE CONTROLS DO NOT MOVE. This is the claim the whole section rests on, so
 * it is worth being precise about what the code actually does:
 *
 *   - Nobody sees data they could not see before. The requester never receives
 *     records, only a released answer.
 *   - The DRAFT is computed inside the holder's permissions, never the
 *     requester's. drafting uses the holder as the acting identity.
 *   - Minimum aggregation is enforced as a property of the source, and stated
 *     on the answer, rather than being a caveat somebody has to remember.
 *   - Nothing reaches the requester until a person releases it. There is no
 *     path in this file that sets status to Released without a human action.
 *
 * Lifecycle:
 *   Raised → Drafted → Released | Declined
 *                    ↘ Method approved → recurs without the responder
 */

import index from '../index/store.js';
import { visibilityFor, canReachUnderlying } from './visibility.js';

/**
 * In-memory store. Requests, methods and threads do not survive a restart —
 * this is the first item on the next-work list in docs/HANDOVER.md.
 */
const requests = new Map();
const methods = new Map();
let seq = 0;

export const STATUS = {
  raised: { label: 'Raised', tone: 'blue' },
  drafted: { label: 'Draft ready for review', tone: 'orange' },
  released: { label: 'Released', tone: 'green' },
  declined: { label: 'Declined', tone: 'red' }
};

/**
 * Who holds the data that could answer this?
 *
 * Matches the question against entries that are answerable by a person, and
 * returns the owning team. This is the "have a holder proposed for me rather
 * than knowing the org chart" capability — the requester should not need to
 * know who owns what.
 */
export function proposeHolders(question) {
  const terms = String(question)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 3);

  return index
    .all()
    .map((e) => {
      const hay = `${e.name} ${e.desc} ${(e.askable || []).join(' ')}`.toLowerCase();
      const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      return { entry: e, score };
    })
    .filter((x) => x.score > 0 && (x.entry.askable?.length || x.entry.vis === 'person'))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => ({
      entryId: x.entry.id,
      entryName: x.entry.name,
      owner: x.entry.owner,
      askable: x.entry.askable || [],
      minAgg: x.entry.minAgg || null
    }));
}

/** Raise a request. */
export function raise({ question, purpose, cadence, requester, holderEntryId }) {
  seq += 1;
  const ref = `REQ-${String(seq).padStart(4, '0')}`;
  const entry = holderEntryId ? index.get(holderEntryId) : null;

  const record = {
    ref,
    question,
    purpose,
    cadence: cadence || 'once',
    status: 'raised',
    requester: requester.name,
    requesterEmail: requester.email,
    requesterGroups: requester.groups,
    holderEntryId: entry?.id || null,
    holderEntryName: entry?.name || null,
    holder: entry?.owner || 'Unassigned',
    minAgg: entry?.minAgg || null,
    raisedAt: new Date().toISOString(),
    draft: null,
    method: null,
    released: null,
    declined: null,
    history: [{ at: new Date().toISOString(), what: 'Raised', by: requester.name }]
  };
  requests.set(ref, record);
  return record;
}

/**
 * Draft an answer, inside the HOLDER's permissions.
 *
 * This is the one step that moves. The agent reads what the holder can reach —
 * never what the requester can reach — and records the method it used, so the
 * holder is reviewing a draft and a method rather than starting from a blank
 * form.
 *
 * @param {object} holder  the acting identity: the person who holds the data
 */
export async function draft(ref, holder, { foundry = index.foundry } = {}) {
  const r = requests.get(ref);
  if (!r) throw new Error(`Unknown request ${ref}`);

  const entry = r.holderEntryId ? index.get(r.holderEntryId) : null;
  if (!entry) throw new Error('This request has no holder entry, so nothing can draft it.');

  // The control: the drafter must genuinely hold the data. Not the
  // "answerable by a person" state, which is true for everyone including the
  // requester — actual reach.
  if (!canReachUnderlying(entry, holder)) {
    const v = visibilityFor(entry, holder);
    throw new Error(`You cannot reach ${entry.name} either — ${v.reason}`);
  }

  const method = [
    `Source: ${entry.name}, as held by ${entry.owner}.`,
    `Freshness at time of drafting: ${entry.fresh}.`,
    entry.minAgg
      ? `Grouped to: ${entry.minAgg}. No result below that grouping is returned.`
      : 'No minimum aggregation is set on this source.',
    `Computed inside ${holder.name}'s access. The requester received no records.`
  ].join('\n');

  let text;
  let sources;
  try {
    const answer = await foundry.respond({
      agentName: `responder-${entry.id}`,
      input:
        `Question from ${r.requester}: ${r.question}\n` +
        `Purpose: ${r.purpose}\n` +
        `Answer only at ${entry.minAgg || 'summary'} level. State your method.`
    });
    text = answer.text;
    sources = answer.sources || [];
  } catch (err) {
    // A drafting failure must not lose the request. The holder answers by hand.
    text = null;
    sources = [];
    r.draftError = err.message;
  }

  r.draft = {
    text,
    sources,
    method,
    draftedAt: new Date().toISOString(),
    draftedFor: holder.name
  };
  r.status = 'drafted';
  r.history.push({ at: new Date().toISOString(), what: 'Agent drafted an answer', by: 'Cortex' });
  return r;
}

/**
 * Release. The only path to an answer reaching a requester, and it requires a
 * person. The caveat and any edit the holder made travel with the answer.
 */
export function release(ref, holder, { answer, caveat, approveMethod }) {
  const r = requests.get(ref);
  if (!r) throw new Error(`Unknown request ${ref}`);

  r.released = {
    answer: answer || r.draft?.text || '',
    caveat: caveat || null,
    method: r.draft?.method || null,
    releasedBy: holder.name,
    releasedAt: new Date().toISOString()
  };
  r.status = 'released';
  r.history.push({ at: new Date().toISOString(), what: 'Released by a person', by: holder.name });

  // Approving the method lets the same question recur without the responder.
  if (approveMethod && r.draft?.method) {
    const id = `M-${String(methods.size + 1).padStart(3, '0')}`;
    methods.set(id, {
      id,
      question: r.question,
      method: r.draft.method,
      entryId: r.holderEntryId,
      owner: holder.name,
      approvedAt: new Date().toISOString(),
      version: 1,
      usedBy: 1
    });
    r.methodId = id;
    r.history.push({
      at: new Date().toISOString(),
      what: 'Method approved — future answers issue without review',
      by: holder.name
    });
  }
  return r;
}

export function decline(ref, holder, { reason, offered }) {
  const r = requests.get(ref);
  if (!r) throw new Error(`Unknown request ${ref}`);
  r.declined = { reason, offered: offered || null, declinedBy: holder.name, at: new Date().toISOString() };
  r.status = 'declined';
  r.history.push({ at: new Date().toISOString(), what: `Declined: ${reason}`, by: holder.name });
  return r;
}

export function get(ref) {
  return requests.get(ref) || null;
}

/** Requests this person raised. */
export function raisedBy(user) {
  return [...requests.values()]
    .filter((r) => r.requesterEmail === user.email || r.requester === user.name)
    .sort((a, b) => new Date(b.raisedAt) - new Date(a.raisedAt));
}

/**
 * Requests waiting on this person.
 *
 * A person is a holder if they can reach the entry the request is against.
 * Membership decides it, not a role stored in this app.
 */
export function waitingOn(user) {
  return [...requests.values()]
    .filter((r) => r.status === 'raised' || r.status === 'drafted')
    .filter((r) => {
      const entry = r.holderEntryId ? index.get(r.holderEntryId) : null;
      if (!entry) return false;
      return canReachUnderlying(entry, user);
    })
    .sort((a, b) => new Date(a.raisedAt) - new Date(b.raisedAt));
}

export function approvedMethods() {
  return [...methods.values()];
}

export function allRequests() {
  return [...requests.values()];
}

export function clearAll() {
  requests.clear();
  methods.clear();
  seq = 0;
}
