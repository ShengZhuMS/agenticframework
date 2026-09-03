/**
 * Identity — real Microsoft Entra sign-in.
 *
 * Container Apps built-in authentication (Easy Auth) terminates the sign-in
 * before the request reaches this process, and injects the result as headers.
 * There is no auth code here, no token validation, no secret: the platform has
 * already done it, and the container is not reachable except through the
 * ingress that performs it.
 *
 *   x-ms-client-principal-name   the user's UPN
 *   x-ms-client-principal-id     their object id
 *   x-ms-client-principal        base64 JSON of every claim, including groups
 *
 * GROUPS ARE THE WHOLE GOVERNANCE MODEL.
 * Every visibility decision is made against the user's Entra group membership,
 * so the app registration MUST emit a groups claim. Without it every user
 * looks like a member of nothing, and the Marketplace correctly — but
 * uselessly — shows them almost nothing. See docs for the token configuration
 * step; it is the single most common reason a live deployment looks broken.
 *
 * DEFAULT GROUPS. Anyone who has signed in is, by definition, a member of
 * staff — so CORTEX_DEFAULT_GROUPS (default `all-staff`) is granted to every
 * authenticated user on top of whatever Entra says. This is what lets a PoC
 * tenant with no group mapping render "Open to all staff" entries as available
 * rather than as "Licence does not cover you". Team-scoped and cleared groups
 * still come only from Entra. Set it empty to turn the default off.
 */

const GROUP_CLAIM_TYPES = new Set([
  'groups',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'
]);

const NAME_CLAIM_TYPES = [
  'name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'preferred_username'
];

const ROLE_CLAIM_TYPES = new Set([
  'roles',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'
]);

/** Decode the Easy Auth principal header into claims. */
function decodePrincipal(header) {
  if (!header) return null;
  try {
    const json = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const claims = json.claims || [];
    const out = { groups: [], roles: [] };
    for (const c of claims) {
      const type = c.typ || c.type;
      const val = c.val || c.value;
      if (!type) continue;
      if (GROUP_CLAIM_TYPES.has(type)) out.groups.push(val);
      else if (ROLE_CLAIM_TYPES.has(type)) out.roles.push(val);
      else if (!out[type]) out[type] = val;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Build the user for this request.
 *
 * Returns null when nobody is signed in, which the caller turns into a
 * redirect to the sign-in page. There is no anonymous browsing: an
 * unauthenticated user has no group membership, so every entry would resolve
 * to "not available" and the page would be actively misleading.
 */
export function userFromRequest(req, { groupNames = {}, defaultGroups = [] } = {}) {
  const upn =
    req.headers['x-ms-client-principal-name'] ||
    req.headers['x-ms-client-principal-idp'] === undefined
      ? req.headers['x-ms-client-principal-name']
      : null;

  const principal = decodePrincipal(req.headers['x-ms-client-principal']);
  const objectId = req.headers['x-ms-client-principal-id'] || principal?.oid || null;

  if (!upn && !objectId) return null;

  const rawGroups = principal?.groups || [];

  /**
   * Entra emits group OBJECT IDs, not names. Access rules are far more
   * readable written against names, so a mapping of id -> name is applied
   * here and both forms are kept: a rule may be written either way and still
   * match.
   */
  const named = rawGroups.map((g) => groupNames[g]).filter(Boolean);
  const groups = [...new Set([...rawGroups, ...named, ...(defaultGroups || [])])];

  const name =
    NAME_CLAIM_TYPES.map((t) => principal?.[t]).find(Boolean) || upn || 'Signed in user';

  return {
    id: objectId || upn,
    name,
    email: upn || null,
    objectId,
    groups,
    roles: principal?.roles || [],
    /** Which of the groups came from configuration rather than from Entra. */
    defaultGroups: (defaultGroups || []).filter((g) => !rawGroups.includes(g) && !named.includes(g)),
    /**
     * Clearance and licence entitlement are derived from group membership.
     * There is no separate store: if a person is in the cleared group they are
     * cleared, and that fact lives in Entra where it can be governed, reviewed
     * and revoked — not in this application's own database.
     */
    clearance: groups.includes('cortex-official-sensitive') ? 'Official–Sensitive' : 'Official',
    licences: [
      'ogl',
      ...(groups.includes('all-staff') || groups.length ? ['internal'] : []),
      ...(groups.includes('cortex-commercial-licence') ? ['commercial'] : [])
    ],
    team: principal?.department || teamFromGroups(groups) || 'Defra'
  };
}

/**
 * A best-effort display team from group membership. Purely cosmetic — nothing
 * about access depends on it.
 */
function teamFromGroups(groups) {
  const team = groups.find((g) => typeof g === 'string' && g.startsWith('cortex-team-'));
  if (!team) return null;
  return team
    .replace('cortex-team-', '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Parse the default-groups setting. Unset means `all-staff`; an explicit empty
 * string means none, which is the strict mode.
 */
export function parseDefaultGroups(spec) {
  if (spec === undefined || spec === null) return ['all-staff'];
  return String(spec)
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

/**
 * Parse the id -> name map supplied as configuration.
 * Format: "<objectId>=<name>,<objectId>=<name>"
 */
export function parseGroupNames(spec) {
  const out = {};
  if (!spec) return out;
  for (const pair of String(spec).split(',')) {
    const [id, name] = pair.split('=').map((s) => s && s.trim());
    if (id && name) out[id] = name;
  }
  return out;
}

/** True when the platform is terminating sign-in in front of this process. */
export function authConfigured(req) {
  return Boolean(
    req.headers['x-ms-client-principal'] || req.headers['x-ms-client-principal-name']
  );
}
