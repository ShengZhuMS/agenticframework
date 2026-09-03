/**
 * Purview access — the grant that fixes "403 Not authorized to access account".
 *
 * The policy documents are large and the rule that matters is three levels
 * deep, so the mutation is pinned here against the documented shape rather
 * than discovered against a live tenant. Every case is pure except the last
 * group, which stubs bootstrap's fetch helper.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  addPrincipalToRole,
  principalsInRole,
  findCatalogPolicy,
  findDomainPolicy,
  grantCatalogAccess,
  grantDomainAccess,
  listPolicies,
  objectIdFromToken,
  CATALOG_ROLES,
  DOMAIN_ROLES,
  ROLES
} from '../scripts/purview-access.js';

const CORTEX = 'abce3285-f1f6-4374-8dd1-ba2c59f2c988';
const SOMEONE = '36aba59f-07cf-4bca-ac8d-e16027a45e6b';
const DOMAIN = '2233bcac-47f0-4a89-b24e-a1497cbb8b31';
const ACCOUNT = '79e7043b-2d89-4454-9f07-1d8ceb3f0399';

/** A domain policy in the shape the Policies - List reference documents. */
function domainPolicy() {
  return {
    name: `dgpolicy_businessdomain_${DOMAIN}`,
    id: '8da96ca2-d78c-411b-8f75-b2227643aec8',
    version: 2,
    properties: {
      description: '',
      decisionRules: [],
      attributeRules: [
        {
          kind: 'attributerule',
          id: `purviewdatagovernancerole_builtin_business-domain-owner:${DOMAIN}`,
          name: `purviewdatagovernancerole_builtin_business-domain-owner:${DOMAIN}`,
          dnfCondition: [
            [
              { attributeName: 'principal.microsoft.id', attributeValueIncludedIn: [SOMEONE] },
              {
                fromRule: 'purviewdatagovernancerole_builtin_business-domain-owner',
                attributeName: 'derived.purview.role',
                attributeValueIncludes: 'purviewdatagovernancerole_builtin_business-domain-owner'
              }
            ]
          ]
        },
        {
          kind: 'attributerule',
          id: `permission_dg:businessdomain_${DOMAIN}`,
          name: `permission_dg:businessdomain_${DOMAIN}`,
          dnfCondition: [
            [
              {
                fromRule: `purviewdatagovernancerole_builtin_business-domain-owner:${DOMAIN}`,
                attributeName: 'derived.purview.permission',
                attributeValueIncludes: `purviewdatagovernancerole_builtin_business-domain-owner:${DOMAIN}`
              }
            ]
          ]
        }
      ],
      entity: { type: 'BusinessDomainReference', referenceName: DOMAIN },
      parentEntityName: ACCOUNT
    }
  };
}

function catalogPolicy() {
  return {
    name: `dgpolicy_datagovernanceapp_${ACCOUNT}`,
    id: '8ab27b74-b096-4792-8aa3-2fdb146aca8c',
    version: 1312,
    properties: {
      decisionRules: [],
      attributeRules: [
        {
          kind: 'attributerule',
          id: `purviewdatagovernancerole_builtin_datagovernance-administrator:${ACCOUNT}`,
          name: `purviewdatagovernancerole_builtin_datagovernance-administrator:${ACCOUNT}`,
          dnfCondition: [
            [
              { attributeName: 'principal.microsoft.id', attributeValueIncludedIn: [SOMEONE] },
              {
                fromRule: 'purviewdatagovernancerole_builtin_datagovernance-administrator',
                attributeName: 'derived.purview.role',
                attributeValueIncludes: 'purviewdatagovernancerole_builtin_datagovernance-administrator'
              }
            ]
          ]
        }
      ],
      entity: { type: 'DataGovernanceAppReference', referenceName: ACCOUNT }
    }
  };
}

describe('finding the right policy', () => {
  test('the catalog-level policy is the datagovernanceapp one', () => {
    const all = [domainPolicy(), catalogPolicy()];
    assert.equal(findCatalogPolicy(all)?.name, `dgpolicy_datagovernanceapp_${ACCOUNT}`);
  });

  test('a domain policy is found by name or by entity reference, case-insensitively', () => {
    const all = [catalogPolicy(), domainPolicy()];
    assert.equal(findDomainPolicy(all, DOMAIN.toUpperCase())?.id, '8da96ca2-d78c-411b-8f75-b2227643aec8');
    assert.equal(findDomainPolicy(all, 'not-a-domain'), null);
  });
});

describe('adding a principal to a role', () => {
  test('appends to an existing role without touching anybody else', () => {
    const { policy, changed, how } = addPrincipalToRole(domainPolicy(), ROLES.businessDomainOwner, CORTEX);
    assert.equal(changed, true);
    assert.equal(how, 'appended');
    assert.deepEqual(principalsInRole(policy, ROLES.businessDomainOwner), [SOMEONE, CORTEX]);
  });

  test('is idempotent — a principal already in the role changes nothing', () => {
    const once = addPrincipalToRole(domainPolicy(), ROLES.businessDomainOwner, CORTEX).policy;
    const twice = addPrincipalToRole(once, ROLES.businessDomainOwner, CORTEX);
    assert.equal(twice.changed, false);
    assert.equal(twice.how, 'already-member');
    assert.deepEqual(principalsInRole(twice.policy, ROLES.businessDomainOwner), [SOMEONE, CORTEX]);
  });

  test('matches an existing membership regardless of GUID casing', () => {
    const r = addPrincipalToRole(domainPolicy(), ROLES.businessDomainOwner, SOMEONE.toUpperCase());
    assert.equal(r.changed, false);
  });

  test('does not mutate the policy it was given', () => {
    const original = domainPolicy();
    const snapshot = JSON.stringify(original);
    addPrincipalToRole(original, ROLES.businessDomainOwner, CORTEX);
    assert.equal(JSON.stringify(original), snapshot);
  });

  test('a role never assigned in this scope gets a rule in the documented shape, wired into the permission rule', () => {
    const { policy, changed, how } = addPrincipalToRole(domainPolicy(), ROLES.dataProductOwner, CORTEX);
    assert.equal(changed, true);
    assert.equal(how, 'rule-created');

    const ruleId = `purviewdatagovernancerole_builtin_data-product-owner:${DOMAIN}`;
    const rule = policy.properties.attributeRules.find((r) => r.id === ruleId);
    assert.ok(rule, 'a rule must be created');
    assert.equal(rule.kind, 'attributerule');
    assert.deepEqual(rule.dnfCondition[0][0], {
      attributeName: 'principal.microsoft.id',
      attributeValueIncludedIn: [CORTEX]
    });
    assert.equal(rule.dnfCondition[0][1].fromRule, 'purviewdatagovernancerole_builtin_data-product-owner');

    const permission = policy.properties.attributeRules.find((r) => r.id.startsWith('permission_dg:'));
    assert.ok(
      permission.dnfCondition.some((c) => c[0]?.fromRule === ruleId),
      'the permission rule must reference the new role rule, or it grants nothing'
    );
  });

  test('a rule with no principal condition gets one', () => {
    const p = domainPolicy();
    p.properties.attributeRules[0].dnfCondition = [
      [
        {
          fromRule: 'purviewdatagovernancerole_builtin_business-domain-owner',
          attributeName: 'derived.purview.role',
          attributeValueIncludes: 'purviewdatagovernancerole_builtin_business-domain-owner'
        }
      ]
    ];
    const r = addPrincipalToRole(p, ROLES.businessDomainOwner, CORTEX);
    assert.equal(r.how, 'condition-added');
    assert.deepEqual(principalsInRole(r.policy, ROLES.businessDomainOwner), [CORTEX]);
  });

  test('refuses anything that is not an object id', () => {
    assert.throws(() => addPrincipalToRole(domainPolicy(), ROLES.businessDomainOwner, 'id-cortex'), /GUID/);
    assert.throws(() => addPrincipalToRole(domainPolicy(), ROLES.businessDomainOwner, ''), /GUID/);
  });
});

describe('the grants bootstrap performs', () => {
  test('catalog access is Data Governance Administrator plus Global Catalog Reader', () => {
    assert.deepEqual(CATALOG_ROLES, ['datagovernance-administrator', 'global-catalog-reader']);
    assert.deepEqual(DOMAIN_ROLES, ['business-domain-owner']);
  });

  test('grantCatalogAccess reads the policies, changes the one policy and PUTs it once', async () => {
    const calls = [];
    const fetcher = async (path, opts = {}) => {
      calls.push({ path, method: opts.method || 'GET', body: opts.body });
      if (opts.method === 'PUT') return opts.body;
      return { values: [domainPolicy(), catalogPolicy()] };
    };

    const r = await grantCatalogAccess(fetcher, CORTEX);
    assert.equal(r.changed, true);

    const puts = calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 1, 'both roles go in one PUT');
    assert.equal(puts[0].path, '/datagovernance/catalog/policies/8ab27b74-b096-4792-8aa3-2fdb146aca8c');
    assert.equal(puts[0].body.version, 1312, 'the version is sent back unchanged');
    assert.ok(principalsInRole(puts[0].body, ROLES.dataGovernanceAdministrator).includes(CORTEX));
    assert.ok(principalsInRole(puts[0].body, ROLES.globalCatalogReader).includes(CORTEX));
    // The role that already had a member keeps them.
    assert.ok(principalsInRole(puts[0].body, ROLES.dataGovernanceAdministrator).includes(SOMEONE));
  });

  test('a second run is a no-op — nothing is PUT', async () => {
    const already = catalogPolicy();
    for (const role of CATALOG_ROLES) {
      Object.assign(already, addPrincipalToRole(already, role, CORTEX).policy);
    }
    const calls = [];
    const fetcher = async (path, opts = {}) => {
      calls.push({ path, method: opts.method || 'GET' });
      return { values: [already] };
    };
    const r = await grantCatalogAccess(fetcher, CORTEX);
    assert.equal(r.changed, false);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
  });

  test('a missing catalog policy is a clear error, not a silent skip', async () => {
    const fetcher = async () => ({ values: [domainPolicy()] });
    await assert.rejects(grantCatalogAccess(fetcher, CORTEX), /Data Governance Administrator/);
  });

  test('domain access reports domains whose policy has not appeared yet instead of failing', async () => {
    const fetcher = async (path, opts = {}) => {
      if (opts.method === 'PUT') return opts.body;
      return { values: [domainPolicy()] };
    };
    const results = await grantDomainAccess(fetcher, CORTEX, [DOMAIN, 'ffffffff-0000-0000-0000-000000000000']);
    assert.equal(results[0].changed, true);
    assert.equal(results[1].missing, true);
  });

  test('policy listing follows the continuation token', async () => {
    let page = 0;
    const fetcher = async (path, opts = {}) => {
      page++;
      if (!opts.query?.skipToken) return { values: [{ name: 'a' }], skipToken: 'NEXT' };
      return { values: [{ name: 'b' }] };
    };
    const all = await listPolicies(fetcher);
    assert.deepEqual(all.map((p) => p.name), ['a', 'b']);
    assert.equal(page, 2);
  });
});

describe('reading the signed-in object id from a token', () => {
  test('decodes the oid claim', () => {
    const payload = Buffer.from(JSON.stringify({ oid: SOMEONE, upn: 'x@y' })).toString('base64url');
    assert.equal(objectIdFromToken(`hdr.${payload}.sig`), SOMEONE);
  });

  test('returns null for anything else', () => {
    assert.equal(objectIdFromToken('not-a-token'), null);
    assert.equal(objectIdFromToken(undefined), null);
  });
});
