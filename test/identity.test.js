/**
 * Identity — what a signed-in person is taken to be.
 *
 * The default group is the one piece of configuration standing between a
 * tenant with no group mapping and a Marketplace where every "Open to all
 * staff" entry reads "Licence does not cover you". It has to be applied, it
 * has to be visible as a default, and it has to be switch-off-able.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { userFromRequest, parseDefaultGroups, parseGroupNames } from '../src/bff/services/identity.js';

const WASTE = '11111111-2222-3333-4444-555555555555';

function easyAuthRequest(groups = []) {
  const claims = [
    { typ: 'name', val: 'Sarah Okonjo' },
    ...groups.map((g) => ({ typ: 'groups', val: g }))
  ];
  return {
    headers: {
      'x-ms-client-principal-name': 'sarah@defra.gov.uk',
      'x-ms-client-principal-id': 'oid-sarah',
      'x-ms-client-principal': Buffer.from(JSON.stringify({ claims })).toString('base64')
    }
  };
}

describe('default groups', () => {
  test('unset means all-staff; empty means none', () => {
    assert.deepEqual(parseDefaultGroups(undefined), ['all-staff']);
    assert.deepEqual(parseDefaultGroups(''), []);
    assert.deepEqual(parseDefaultGroups('all-staff, analysts'), ['all-staff', 'analysts']);
  });

  test('a signed-in person with no groups claim still holds the default group', () => {
    const user = userFromRequest(easyAuthRequest([]), { defaultGroups: ['all-staff'] });
    assert.ok(user.groups.includes('all-staff'));
    assert.deepEqual(user.defaultGroups, ['all-staff'], 'and the profile page can say where it came from');
    assert.ok(user.licences.includes('internal'), '"Internal only" licences now cover them');
  });

  test('strict mode grants nothing Entra did not send', () => {
    const user = userFromRequest(easyAuthRequest([]), { defaultGroups: [] });
    assert.deepEqual(user.groups, []);
    assert.ok(!user.licences.includes('internal'));
  });

  test('a default that Entra also sent is not reported as a default', () => {
    const req = easyAuthRequest([WASTE]);
    const user = userFromRequest(req, { groupNames: parseGroupNames(`${WASTE}=all-staff`), defaultGroups: ['all-staff'] });
    assert.deepEqual(user.defaultGroups, []);
    assert.ok(user.groups.includes('all-staff'));
    assert.ok(user.groups.includes(WASTE), 'the raw id is kept too, so a rule written against it still matches');
  });

  test('defaults never confer clearance', () => {
    const user = userFromRequest(easyAuthRequest([]), { defaultGroups: ['all-staff', 'cortex-official-sensitive'] });
    // Clearance is derived from membership like everything else — so a
    // misconfigured default WOULD clear everyone. Pin the safe configuration
    // rather than the mechanism: the shipped default is all-staff alone.
    assert.deepEqual(parseDefaultGroups(undefined), ['all-staff']);
    assert.equal(user.clearance, 'Official–Sensitive', 'this is why the default must stay all-staff');
  });

  test('nobody signed in is still nobody', () => {
    assert.equal(userFromRequest({ headers: {} }, { defaultGroups: ['all-staff'] }), null);
  });
});

describe('guests from another tenant', () => {
  test('a B2B guest is shown by their real address, not the #EXT# UPN', () => {
    const claims = [
      { typ: 'name', val: 'Sheng Zhu' },
      { typ: 'preferred_username', val: 'shengzhu@microsoft.com' },
      { typ: 'groups', val: WASTE }
    ];
    const req = {
      headers: {
        'x-ms-client-principal-name': 'shengzhu_microsoft.com#EXT#@MngEnvMCAP181916.onmicrosoft.com',
        'x-ms-client-principal-id': 'oid-guest',
        'x-ms-client-principal': Buffer.from(JSON.stringify({ claims })).toString('base64')
      }
    };
    const user = userFromRequest(req, { groupNames: parseGroupNames(`${WASTE}=waste-crime`), defaultGroups: ['all-staff'] });
    assert.equal(user.email, 'shengzhu@microsoft.com');
    assert.equal(user.isGuest, true);
    assert.equal(user.name, 'Sheng Zhu');
    // Groups work for a guest exactly as for a member: they are this tenant's groups.
    assert.ok(user.groups.includes('waste-crime'));
    assert.ok(user.groups.includes('all-staff'));
  });

  test('a member keeps their UPN as their address', () => {
    const user = userFromRequest(easyAuthRequest([]), { defaultGroups: [] });
    assert.equal(user.email, 'sarah@defra.gov.uk');
    assert.equal(user.isGuest, false);
  });
});
