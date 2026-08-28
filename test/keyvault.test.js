/**
 * Key Vault.
 *
 * The assertions that matter:
 *   1. A vault that is down must never stop the app booting.
 *   2. Key Vault wins over the environment, so onboarding a value takes effect.
 *   3. A secret value is never exposed by the health report.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  KeyVault,
  SECRET_CATALOGUE,
  normaliseVaultUri,
  resolveSecrets,
  setPath
} from '../src/bff/adapters/keyvault.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stand in for the vault so no network or credential is needed. */
function stubVault(secrets, { status = 200, throws = false } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/oauth2/') || u.includes('IDENTITY')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'x', expires_on: '99999999999' }) };
    }
    if (throws) throw new Error('ECONNREFUSED');
    const name = decodeURIComponent(u.split('/secrets/')[1].split('?')[0]);
    if (!(name in secrets)) return { ok: false, status: 404, json: async () => ({}) };
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ value: secrets[name] }) };
  };
  // Managed identity endpoint, so token.js does not shell out to the Azure CLI.
  process.env.IDENTITY_ENDPOINT = 'http://localhost/IDENTITY';
  process.env.IDENTITY_HEADER = 'stub';
}

describe('vault URI', () => {
  test('accepts a bare name', () => {
    assert.equal(normaliseVaultUri('cortex-kv'), 'https://cortex-kv.vault.azure.net');
  });
  test('accepts a full URI and strips a trailing slash', () => {
    assert.equal(normaliseVaultUri('https://cortex-kv.vault.azure.net/'), 'https://cortex-kv.vault.azure.net');
  });
  test('an unset vault disables the client rather than guessing', () => {
    assert.equal(new KeyVault('').enabled, false);
  });
});

describe('the secret catalogue', () => {
  test('every name is a legal Key Vault secret name', () => {
    for (const s of SECRET_CATALOGUE) {
      assert.match(s.secret, /^[0-9a-zA-Z-]+$/, `${s.secret} would be rejected by Key Vault`);
      assert.ok(s.secret.length <= 127);
    }
  });

  test('every entry maps to a config path and an environment fallback', () => {
    for (const s of SECRET_CATALOGUE) {
      assert.ok(s.path, `${s.secret} needs a config path`);
      assert.ok(s.env, `${s.secret} needs an env fallback`);
      assert.ok(s.description && s.description.length > 20, `${s.secret} needs a usable description`);
      assert.equal(typeof s.sensitive, 'boolean');
      assert.equal(typeof s.required, 'boolean');
    }
  });

  test('names are unique', () => {
    const names = SECRET_CATALOGUE.map((s) => s.secret);
    assert.equal(new Set(names).size, names.length);
  });

  test('the APIM subscription key is marked sensitive', () => {
    const k = SECRET_CATALOGUE.find((s) => s.secret === 'apim-subscription-key');
    assert.equal(k.sensitive, true, 'it is a bearer credential for every published MCP server');
  });
});

describe('reading secrets', () => {
  test('reads a value from the vault', async () => {
    stubVault({ 'apim-gateway-url': 'https://apim-x.azure-api.net' });
    const kv = new KeyVault('cortex-kv');
    assert.equal(await kv.get('apim-gateway-url'), 'https://apim-x.azure-api.net');
  });

  test('a missing secret is null, not an error', async () => {
    stubVault({});
    const kv = new KeyVault('cortex-kv');
    assert.equal(await kv.get('not-there'), null);
    assert.equal(kv.errors.length, 0, '404 is a normal condition, not a fault');
  });

  test('caches so a page load never waits on the vault twice', async () => {
    let calls = 0;
    stubVault({ 'foundry-model': 'gpt-5-mini' });
    const inner = globalThis.fetch;
    globalThis.fetch = async (u) => {
      if (String(u).includes('/secrets/')) calls++;
      return inner(u);
    };
    const kv = new KeyVault('cortex-kv');
    await kv.get('foundry-model');
    await kv.get('foundry-model');
    assert.equal(calls, 1);
  });

  test('403 explains that a role assignment is missing', async () => {
    stubVault({ 'apim-gateway-url': 'x' }, { status: 403 });
    const kv = new KeyVault('cortex-kv');
    assert.equal(await kv.get('apim-gateway-url'), null);
    assert.match(kv.errors[0].message, /Key Vault Secrets User/);
  });
});

describe('resolution — vault wins, environment is the safety net', () => {
  test('a vault value overrides the environment', async () => {
    stubVault({ 'apim-gateway-url': 'https://from-vault.azure-api.net' });
    const { report } = await resolveSecrets('cortex-kv', {
      APIM_GATEWAY_URL: 'https://from-env.azure-api.net'
    });
    const r = report.find((x) => x.secret === 'apim-gateway-url');
    assert.equal(r.source, 'keyvault');
    assert.equal(r.value, 'https://from-vault.azure-api.net');
  });

  test('the environment fills a gap the vault does not cover', async () => {
    stubVault({});
    const { report } = await resolveSecrets('cortex-kv', { APIM_SERVICE_NAME: 'apim-local' });
    const r = report.find((x) => x.secret === 'apim-service-name');
    assert.equal(r.source, 'environment');
    assert.equal(r.present, true);
  });

  test('an unreachable vault degrades to the environment and records why', async () => {
    stubVault({}, { throws: true });
    const { report, errors } = await resolveSecrets('cortex-kv', {
      APIM_SERVICE_NAME: 'apim-local'
    });
    assert.ok(errors.length > 0, 'the failure must be recorded');
    assert.equal(report.find((x) => x.secret === 'apim-service-name').source, 'environment');
  });

  test('no vault at all is a supported configuration', async () => {
    const { report } = await resolveSecrets('', { APIM_SERVICE_NAME: 'apim-local' });
    assert.equal(report.find((x) => x.secret === 'apim-service-name').source, 'environment');
  });

  test('an unset value is reported as unset rather than empty string', async () => {
    stubVault({});
    const { report } = await resolveSecrets('cortex-kv', {});
    const r = report.find((x) => x.secret === 'apim-subscription-key');
    assert.equal(r.source, 'unset');
    assert.equal(r.present, false);
  });
});

describe('a slow vault must not hold up startup', () => {
  test('a vault that accepts the connection and never replies is bounded', async () => {
    const http = await import('node:http');
    const hang = http.createServer(() => {
      /* deliberately never responds — the packet-drop case */
    });
    await new Promise((r) => hang.listen(0, r));
    const port = hang.address().port;

    const prev = { ...process.env };
    process.env.IDENTITY_ENDPOINT = `http://localhost:${port}/token`;
    process.env.IDENTITY_HEADER = 'stub';
    process.env.KEYVAULT_TIMEOUT_MS = '600';
    process.env.KEYVAULT_BUDGET_MS = '1500';

    try {
      const t0 = Date.now();
      const { report, errors } = await resolveSecrets(`http://localhost:${port}`, {
        APIM_SERVICE_NAME: 'apim-from-env'
      });
      const elapsed = Date.now() - t0;

      // fetch() has no default timeout. Without the guard this never returns,
      // the container never passes its readiness probe, and the seeded
      // fallback the whole design rests on never gets a chance to run.
      assert.ok(elapsed < 8000, `hydration took ${elapsed}ms — it must be bounded`);
      assert.ok(errors.length > 0, 'the timeout must be recorded, not swallowed');
      assert.equal(
        report.find((r) => r.secret === 'apim-service-name').source,
        'environment',
        'a hanging vault must still fall back to the environment'
      );
    } finally {
      hang.close();
      process.env = prev;
    }
  });
});

describe('the health report never leaks a credential', () => {
  test('sensitive values are withheld, non-sensitive ones are shown', async () => {
    stubVault({
      'apim-subscription-key': 'SUPER-SECRET-KEY',
      'apim-gateway-url': 'https://apim-x.azure-api.net',
      'entra-client-secret': 'ANOTHER-SECRET'
    });
    const { report } = await resolveSecrets('cortex-kv', {});

    for (const r of report.filter((x) => x.sensitive)) {
      assert.equal(r.value, undefined, `${r.secret} must never carry its value`);
    }
    const url = report.find((x) => x.secret === 'apim-gateway-url');
    assert.equal(url.value, 'https://apim-x.azure-api.net', 'a wrong endpoint must be diagnosable');

    const serialised = JSON.stringify(report);
    assert.ok(!serialised.includes('SUPER-SECRET-KEY'));
    assert.ok(!serialised.includes('ANOTHER-SECRET'));
  });

  test('presence is still reported for a secret whose value is hidden', async () => {
    stubVault({ 'apim-subscription-key': 'SUPER-SECRET-KEY' });
    const { report } = await resolveSecrets('cortex-kv', {});
    const r = report.find((x) => x.secret === 'apim-subscription-key');
    assert.equal(r.present, true);
    assert.equal(r.source, 'keyvault');
  });

  test('the vault status carries no values at all', async () => {
    stubVault({ 'apim-subscription-key': 'SUPER-SECRET-KEY' });
    const kv = new KeyVault('cortex-kv');
    await kv.get('apim-subscription-key');
    assert.ok(!JSON.stringify(kv.status()).includes('SUPER-SECRET-KEY'));
  });
});

describe('setPath', () => {
  test('sets a nested value', () => {
    const o = { apim: { gatewayUrl: '' } };
    setPath(o, 'apim.gatewayUrl', 'https://x');
    assert.equal(o.apim.gatewayUrl, 'https://x');
  });

  test('creates intermediate objects', () => {
    const o = {};
    setPath(o, 'entra.clientId', 'abc');
    assert.equal(o.entra.clientId, 'abc');
  });

  test('sets a top-level value', () => {
    const o = {};
    setPath(o, 'publicBaseUrl', 'https://x');
    assert.equal(o.publicBaseUrl, 'https://x');
  });

  test('every catalogued path is settable', () => {
    const o = {};
    for (const s of SECRET_CATALOGUE) setPath(o, s.path, 'v');
    for (const s of SECRET_CATALOGUE) {
      const got = s.path.split('.').reduce((n, k) => n?.[k], o);
      assert.equal(got, 'v', `${s.path} did not round-trip`);
    }
  });
});
