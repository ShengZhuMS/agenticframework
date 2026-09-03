/**
 * Purview access for the Cortex identity — automated.
 *
 * WHY THIS EXISTS
 * The web app and the MCP server call the Unified Catalog with the Cortex
 * managed identity. Until that identity holds a Unified Catalog role, every
 * call is refused with:
 *
 *   403 {"error":{"code":"Unauthorized","message":"Not authorized to access account"}}
 *
 * That is the failure the Help page showed as "Purview UNAVAILABLE". Azure RBAC
 * on the Purview resource does not fix it — the roles that matter live inside
 * Purview and are assigned through the Unified Catalog *Policies* API:
 *
 *   GET  {endpoint}/datagovernance/catalog/policies?api-version=2026-03-20-preview
 *   PUT  {endpoint}/datagovernance/catalog/policies/{policyId}?api-version=...
 *
 * (Documented under "Purview Unified Catalog > Policies". A policy per scope
 * holds one attribute rule per role; the principal ids sit in a
 * `principal.microsoft.id` condition inside that rule. Service principals and
 * managed identities are accepted, contrary to the older note in this repo that
 * said Purview roles could not be automated.)
 *
 * Bootstrap runs this with YOUR signed-in identity — you already hold the
 * rights, because bootstrap created the governance domains with them. The
 * grants are:
 *
 *   catalog level  Data Governance Administrator + Global Catalog Reader
 *   each Cortex governance domain  Governance Domain Owner
 *
 * The first is what unblocks the 403. The second is what lets the app read
 * published data products in every domain. The third lets the app manage the
 * data products bootstrap creates. All three are idempotent: a principal that
 * is already in a role is left alone and reported as such.
 *
 * The functions that touch the network take a `fetcher` so they can be tested
 * against a stub; the pure helpers below are what the tests pin.
 */

const ROLE_PREFIX = 'purviewdatagovernancerole_builtin_';
const PRINCIPAL_ATTRIBUTE = 'principal.microsoft.id';

/** Roles by the short name the API uses after the prefix. */
export const ROLES = {
  dataGovernanceAdministrator: 'datagovernance-administrator',
  globalCatalogReader: 'global-catalog-reader',
  businessDomainCreator: 'business-domain-creator',
  businessDomainOwner: 'business-domain-owner',
  businessDomainReader: 'business-domain-reader',
  dataProductOwner: 'data-product-owner',
  dataSteward: 'data-steward'
};

/** Catalog-level roles granted to the Cortex identity. */
export const CATALOG_ROLES = [ROLES.dataGovernanceAdministrator, ROLES.globalCatalogReader];

/** Roles granted on each governance domain bootstrap owns. */
export const DOMAIN_ROLES = [ROLES.businessDomainOwner];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value) {
  return GUID.test(String(value || ''));
}

/** The tenant-wide policy that carries the catalog-level roles. */
export function findCatalogPolicy(policies) {
  return (policies || []).find((p) => /^dgpolicy_datagovernanceapp_/i.test(p?.name || '')) || null;
}

/** The policy for one governance domain. */
export function findDomainPolicy(policies, domainId) {
  const want = `dgpolicy_businessdomain_${String(domainId).toLowerCase()}`;
  return (
    (policies || []).find(
      (p) =>
        String(p?.name || '').toLowerCase() === want ||
        (p?.properties?.entity?.type === 'BusinessDomainReference' &&
          String(p?.properties?.entity?.referenceName || '').toLowerCase() === String(domainId).toLowerCase())
    ) || null
  );
}

function ruleIsRole(rule, role) {
  const id = String(rule?.id || rule?.name || '');
  return id === `${ROLE_PREFIX}${role}` || id.startsWith(`${ROLE_PREFIX}${role}:`);
}

/** The scope id a policy's rules are suffixed with — the domain or the account. */
function scopeIdOf(policy) {
  const fromEntity = policy?.properties?.entity?.referenceName;
  if (fromEntity) return fromEntity;
  const m = String(policy?.name || '').match(/_([0-9a-f-]{36})$/i);
  return m ? m[1] : '';
}

/** Every principal id currently holding a role in a policy. */
export function principalsInRole(policy, role) {
  const rule = (policy?.properties?.attributeRules || []).find((r) => ruleIsRole(r, role));
  if (!rule) return [];
  const out = [];
  for (const conjunction of rule.dnfCondition || []) {
    for (const cond of conjunction || []) {
      if (cond?.attributeName === PRINCIPAL_ATTRIBUTE) {
        out.push(...(cond.attributeValueIncludedIn || []));
      }
    }
  }
  return out;
}

/**
 * Add a principal to a role inside a policy. Pure: returns a new policy and
 * whether anything changed. Never removes anybody.
 *
 * Three shapes are handled, in order of how often they occur:
 *   1. The role rule exists and already lists principals — append.
 *   2. The role rule exists but has no principal condition — add one.
 *   3. The role has never been assigned in this scope, so there is no rule —
 *      create one in the documented shape and, where the policy has a
 *      permission rule that enumerates role rules, register the new rule there
 *      too so the decision rules can see it.
 */
export function addPrincipalToRole(policy, role, principalId) {
  if (!isGuid(principalId)) {
    throw new Error(`Refusing to grant "${principalId}" — a principal id must be a GUID (object id).`);
  }
  const next = structuredClone(policy);
  next.properties = next.properties || {};
  next.properties.attributeRules = next.properties.attributeRules || [];
  const rules = next.properties.attributeRules;
  const wanted = String(principalId).toLowerCase();

  let rule = rules.find((r) => ruleIsRole(r, role));

  if (rule) {
    for (const conjunction of rule.dnfCondition || []) {
      for (const cond of conjunction || []) {
        if (cond?.attributeName !== PRINCIPAL_ATTRIBUTE) continue;
        const have = (cond.attributeValueIncludedIn || []).map((v) => String(v).toLowerCase());
        if (have.includes(wanted)) return { policy: next, changed: false, how: 'already-member' };
        cond.attributeValueIncludedIn = [...(cond.attributeValueIncludedIn || []), principalId];
        return { policy: next, changed: true, how: 'appended' };
      }
    }
    // The rule exists with no principal condition at all.
    const first = (rule.dnfCondition = rule.dnfCondition || [])[0] || (rule.dnfCondition[0] = []);
    first.unshift({ attributeName: PRINCIPAL_ATTRIBUTE, attributeValueIncludedIn: [principalId] });
    return { policy: next, changed: true, how: 'condition-added' };
  }

  // Never assigned here before: build the rule in the documented shape.
  const scopeId = scopeIdOf(next);
  const ruleId = scopeId ? `${ROLE_PREFIX}${role}:${scopeId}` : `${ROLE_PREFIX}${role}`;
  rule = {
    kind: 'attributerule',
    id: ruleId,
    name: ruleId,
    dnfCondition: [
      [
        { attributeName: PRINCIPAL_ATTRIBUTE, attributeValueIncludedIn: [principalId] },
        {
          fromRule: `${ROLE_PREFIX}${role}`,
          attributeName: 'derived.purview.role',
          attributeValueIncludes: `${ROLE_PREFIX}${role}`
        }
      ]
    ]
  };
  rules.push(rule);

  // A permission rule, where present, lists which role rules confer access.
  // Without this line the new role rule would exist and grant nothing.
  const permission = rules.find((r) => /^permission_dg:/i.test(String(r?.id || r?.name || '')));
  if (permission) {
    permission.dnfCondition = permission.dnfCondition || [];
    permission.dnfCondition.push([
      { fromRule: ruleId, attributeName: 'derived.purview.permission', attributeValueIncludes: ruleId }
    ]);
  }
  return { policy: next, changed: true, how: 'rule-created' };
}

/**
 * List every policy, following the continuation token.
 * @param {(path: string, opts?: object) => Promise<any>} fetcher  bootstrap's purviewFetch
 */
export async function listPolicies(fetcher) {
  const out = [];
  let skipToken;
  do {
    const page = await fetcher('/datagovernance/catalog/policies', { query: { skipToken } });
    out.push(...(page?.values || page?.value || []));
    skipToken = page?.skipToken || null;
  } while (skipToken);
  return out;
}

/**
 * Grant a set of roles on one policy, with a single PUT. Returns what changed.
 */
export async function grantRoles(fetcher, policy, roles, principalId) {
  let current = policy;
  const outcome = [];
  for (const role of roles) {
    const r = addPrincipalToRole(current, role, principalId);
    current = r.policy;
    outcome.push({ role, ...r, policy: undefined });
  }
  const changed = outcome.some((o) => o.changed);
  if (changed) {
    await fetcher(`/datagovernance/catalog/policies/${policy.id}`, { method: 'PUT', body: current });
  }
  return { changed, outcome };
}

/**
 * The catalog-level grant: Data Governance Administrator + Global Catalog Reader.
 */
export async function grantCatalogAccess(fetcher, principalId, { policies } = {}) {
  const all = policies || (await listPolicies(fetcher));
  const policy = findCatalogPolicy(all);
  if (!policy) {
    throw new Error(
      'No catalog-level policy (dgpolicy_datagovernanceapp_*) was returned. ' +
        'Your account may lack the Data Governance Administrator role, or the tenant has not been onboarded to the new Purview portal.'
    );
  }
  return grantRoles(fetcher, policy, CATALOG_ROLES, principalId);
}

/**
 * The per-domain grant: Governance Domain Owner on each Cortex domain.
 * A domain whose policy has not appeared yet (Purview creates it shortly after
 * the domain) is reported rather than failed, so a re-run picks it up.
 */
export async function grantDomainAccess(fetcher, principalId, domainIds, { policies } = {}) {
  const all = policies || (await listPolicies(fetcher));
  const results = [];
  for (const domainId of domainIds) {
    const policy = findDomainPolicy(all, domainId);
    if (!policy) {
      results.push({ domainId, changed: false, missing: true });
      continue;
    }
    const r = await grantRoles(fetcher, policy, DOMAIN_ROLES, principalId);
    results.push({ domainId, ...r });
  }
  return results;
}

/**
 * The object id inside an access token, so bootstrap can name the signed-in
 * person as a data product owner without another directory call. Purview
 * requires at least one owner before a data product can be published.
 */
export function objectIdFromToken(token) {
  try {
    const payload = String(token).split('.')[1];
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return json.oid || null;
  } catch {
    return null;
  }
}
