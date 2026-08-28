/**
 * The visibility state engine.
 *
 * Six states, from the Cortex mockup. This is the governance story made
 * computable: the same Marketplace page renders differently for different
 * people, because access is *shown*, not asserted.
 *
 * This is a pure function. Given an entry and a user it returns a state and
 * the reason for it. No I/O, no globals, no surprises — so it can be unit
 * tested exhaustively and trusted in a live demo.
 */

export const VIS = {
  available: {
    label: 'Available',
    mark: 'filled',
    next: 'Use it now',
    tone: 'green'
  },
  request: {
    label: 'Available to you, needs a request',
    mark: 'open',
    next: 'Request access',
    tone: 'blue'
  },
  licence: {
    label: 'Licence does not cover you',
    mark: 'half',
    next: 'Commercial question',
    tone: 'orange'
  },
  sensitivity: {
    label: 'Sensitivity precludes you',
    mark: 'cross',
    next: 'No route in your role',
    tone: 'red'
  },
  notcleared: {
    label: 'Not yet registered for use',
    mark: 'dash',
    next: 'Connected, not cleared',
    tone: 'grey'
  },
  person: {
    label: 'Answerable by a person',
    mark: 'nest',
    next: 'Request an answer',
    tone: 'purple'
  }
};

export const VIS_ORDER = ['available', 'request', 'person', 'licence', 'notcleared', 'sensitivity'];

/**
 * Which Entra groups grant direct access to an entry.
 * In the live adapter this comes from Purview access policies. In the seeded
 * adapter it is derived from the entry's own access statement, so the seed
 * data stays the single source of truth.
 */
function allowedGroupsFor(entry) {
  if (Array.isArray(entry.allowedGroups)) return entry.allowedGroups;
  const access = (entry.access || '').toLowerCase();
  if (access.includes('open to all staff') || access.includes('all staff')) return ['all-staff'];
  if (access.includes('no direct route')) return [];
  // Fall back to a group named after the owning cluster.
  return [entry.cluster];
}

function licenceCovers(entry, user) {
  const lic = (entry.licence || '').toLowerCase();
  if (!lic || lic === '—') return true;
  // Open Government Licence covers everyone, staff and contractors alike.
  if (lic.includes('open government licence')) return true;
  // Seat-limited and commercial terms are the ones that genuinely exclude
  // people — this is the case the 'Licence does not cover you' state exists for.
  if (lic.includes('seat') || lic.includes('commercial')) {
    return user.licences.includes('commercial');
  }
  // "Internal only" means internal to Defra, so any member of staff is covered.
  if (lic.includes('internal')) return user.groups.includes('all-staff');
  return true;
}

const CLEARANCE_RANK = { 'Official': 1, 'Official–Sensitive': 2, 'Official-Sensitive': 2 };

function clearedFor(entry, user) {
  const need = CLEARANCE_RANK[entry.sens] || 1;
  const have = CLEARANCE_RANK[user.clearance] || 1;
  return have >= need;
}

/**
 * Compute the visibility state of one entry for one user.
 *
 * Order of evaluation matters and is deliberate:
 *   1. Not cleared through the gateway  — nobody can use it yet, whoever they are.
 *   2. Answerable by a person           — the data itself is never released.
 *   3. Sensitivity                      — a hard stop on the person's clearance.
 *   4. Licence                          — the data is reachable, the commercial terms are not.
 *   5. Group membership                 — available, or available on request.
 *
 * @returns {{state: string, reason: string}}
 */
export function visibilityFor(entry, user) {
  if (!user) return { state: 'notcleared', reason: 'No user in context.' };

  // 1. Registered but no clearance decision has been made.
  if (entry.vis === 'notcleared') {
    return {
      state: 'notcleared',
      reason: 'Connected through the gateway, but the clearance decision has not been made yet.'
    };
  }

  // 2. The data is never released; a holder answers from it.
  if (entry.askable && entry.askable.length) {
    return {
      state: 'person',
      reason: 'The records cannot be released, but the team that holds them can answer from them.'
    };
  }

  // 3. Sensitivity is a hard stop.
  if (!clearedFor(entry, user)) {
    return {
      state: 'sensitivity',
      reason: `This entry is ${entry.sens}. Your role is cleared to ${user.clearance}.`
    };
  }

  // 4. The licence may not cover this person even where the data would.
  if (!licenceCovers(entry, user)) {
    return {
      state: 'licence',
      reason: `The licence is "${entry.licence}", which does not cover your role.`
    };
  }

  // 5. Group membership decides available vs on request.
  const allowed = allowedGroupsFor(entry);
  const isMember = allowed.some((g) => user.groups.includes(g));

  if (isMember) {
    return { state: 'available', reason: 'You are in a group this entry is open to.' };
  }

  return {
    state: 'request',
    reason: `Held by ${entry.owner}. You are eligible, but access is granted on request.`
  };
}

/**
 * Can this user attach the entry to an agent as knowledge?
 * An agent may never reach further than the person building it — so only
 * entries in the `available` state qualify. Everything else is shown but
 * disabled, with the reason visible. That is the point of the screen.
 */
export function attachableFor(entry, user) {
  const { state, reason } = visibilityFor(entry, user);
  if (state === 'available') return { attachable: true, reason: null, state };
  if (state === 'request') {
    return { attachable: false, state, reason: 'Request access first, then it becomes available here.' };
  }
  return { attachable: false, state, reason };
}

/** Decorate a list of entries with their state for one user. */
export function decorate(entries, user) {
  return entries.map((e) => {
    const v = visibilityFor(e, user);
    return { ...e, vis: v.state, visReason: v.reason, visMeta: VIS[v.state] };
  });
}
