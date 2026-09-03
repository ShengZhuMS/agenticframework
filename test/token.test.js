/**
 * Token acquisition — regression tests.
 *
 * WHY THIS FILE EXISTS. `token.js` broke twice in a row on Windows and neither
 * break was caught here, because there were no tests for it at all. Both were
 * failures of ONE pure function — how a spawn error is classified — so both are
 * testable on any platform. They are the first two cases below.
 *
 *   spawn az ENOENT   execFile does not apply PATHEXT; on Windows the CLI is
 *                     az.cmd, and there is no az.exe.
 *   spawn EINVAL      Node refuses to run a .cmd without shell: true, since
 *                     the CVE-2024-27980 fix in 18.20.2 / 20.12.2 / 21.7.3.
 *
 * The end-to-end cases use a stub `az` on PATH, so they exercise the real
 * execFile path without needing Azure or a signed-in CLI.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getToken, clearTokenCache, candidatesFor, __testing } from '../src/bff/adapters/token.js';

const { assertSafeResource, isUnusable, isTimeout } = __testing;

const IS_WINDOWS = process.platform === 'win32';

/* ------------------------------------------------ how az is invoked */

describe('Azure CLI invocation strategy', () => {
  test('every Windows candidate runs through a shell', () => {
    // THE EINVAL REGRESSION. A .cmd or .bat spawned without shell: true fails
    // with EINVAL on every Node since April 2024. If anyone "tidies away" the
    // shell flag on a batch wrapper again, this fails here instead of on a
    // laptop half an hour into a deployment.
    for (const candidate of candidatesFor('win32')) {
      assert.equal(candidate.shell, true, `${candidate.command} must use a shell`);
    }
  });

  test('no batch wrapper is ever spawned without a shell, on any platform', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      for (const c of candidatesFor(platform)) {
        if (/\.(cmd|bat)$/i.test(c.command)) {
          assert.equal(c.shell, true, `${c.command} on ${platform} must use a shell`);
        }
      }
    }
  });

  test('Windows tries az.cmd first, because there is no az.exe', () => {
    // THE ENOENT REGRESSION. A bare 'az' first would fail before it ever got
    // to the wrapper that actually exists.
    assert.equal(candidatesFor('win32')[0].command, 'az.cmd');
  });

  test('Linux and macOS involve no shell at all', () => {
    for (const platform of ['linux', 'darwin']) {
      const candidates = candidatesFor(platform);
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].command, 'az');
      assert.equal(candidates[0].shell, false);
    }
  });
});

/* ------------------------------------------------ error classification */

describe('spawn error classification', () => {
  test('EINVAL means try the next candidate, not "Azure refused"', () => {
    // This is precisely what produced the misleading
    //   "Azure CLI could not get a token for https://purview.azure.net: spawn EINVAL"
    assert.equal(isUnusable({ code: 'EINVAL', message: 'spawn EINVAL' }), true);
  });

  test('ENOENT and EACCES mean try the next candidate', () => {
    assert.equal(isUnusable({ code: 'ENOENT', message: 'spawn az ENOENT' }), true);
    assert.equal(isUnusable({ code: 'EACCES' }), true);
  });

  test('a shell reporting "command not found" is recognised by exit code, not by language', () => {
    // cmd.exe returns 9009 and POSIX shells return 127 in every locale. The
    // user runs a Danish Windows; matching only the English string would
    // abandon the candidate loop and report a missing CLI as an Azure fault.
    assert.equal(isUnusable({ code: 9009, stderr: 'ikke genkendt som en intern kommando' }), true);
    assert.equal(isUnusable({ code: 127, stderr: 'az: Kommando ikke fundet' }), true);
  });

  test('a real refusal from a working CLI is NOT swallowed', () => {
    // Exit 1 with a genuine Azure message must surface to the user, not send
    // the loop looking for another az.
    const err = { code: 1, stderr: "ERROR: AADSTS500011: The resource principal was not found" };
    assert.equal(isUnusable(err), false);
  });

  test('a killed process is a timeout, not a missing command', () => {
    assert.equal(isTimeout({ killed: true, signal: 'SIGTERM', code: null }), true);
    assert.equal(isTimeout({ code: 'ENOENT' }), false);
  });
});

/* ------------------------------------------------ shell input safety */

describe('resource allowlist', () => {
  test('accepts every scope Cortex actually uses', () => {
    const real = [
      'https://purview.azure.net',
      'https://management.azure.com',
      'https://vault.azure.net',
      'https://ai.azure.com'
    ];
    for (const r of real) assert.equal(assertSafeResource(r), r);
  });

  test('refuses anything a shell could act on, before it reaches one', () => {
    const hostile = [
      'https://x.net" & calc.exe & "',
      'https://x.net; rm -rf /',
      'https://x.net%USERPROFILE%',
      'https://x.net|whoami',
      'https://x.net^&echo',
      'https://x.net `id`',
      'http://x.net',
      ''
    ];
    for (const r of hostile) {
      assert.throws(() => assertSafeResource(r), /unexpected resource/i, `should refuse: ${r}`);
    }
  });
});

/* ------------------------------------------------ end to end, stubbed CLI */

describe('getToken against a stub CLI', { skip: IS_WINDOWS ? 'POSIX stub only' : false }, () => {
  let dir;
  let originalPath;
  let counter;

  // Shell BUILTINS only (printf, echo). The stub must not depend on anything
  // being found through PATH, because these tests deliberately manipulate it.
  const writeStub = async (bodyJson) => {
    const az = path.join(dir, 'az');
    await writeFile(az, `#!/bin/sh\nprintf 'x' >> "${counter}"\nprintf '%s\\n' '${bodyJson}'\n`, 'utf8');
    await chmod(az, 0o755);
  };

  const callCount = async () => {
    try {
      return (await readFile(counter, 'utf8')).length;
    } catch {
      return 0;
    }
  };

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cortex-az-'));
    counter = path.join(dir, 'calls');
    originalPath = process.env.PATH;
    // Prepend rather than replace: the stub's interpreter and the test runner
    // still need the rest of the system.
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    // Managed identity must not be picked up ahead of the stub.
    delete process.env.IDENTITY_ENDPOINT;
    delete process.env.IDENTITY_HEADER;
    delete process.env.MSI_ENDPOINT;
    delete process.env.MSI_SECRET;
  });

  after(async () => {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    clearTokenCache();
    await rm(counter, { force: true });
  });

  test('returns the token from the CLI', async () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    await writeStub(`{"accessToken":"tok-abc","expires_on":${expires}}`);
    assert.equal(await getToken('https://purview.azure.net/.default'), 'tok-abc');
  });

  test('a second call is served from cache', async () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    await writeStub(`{"accessToken":"tok-abc","expires_on":${expires}}`);
    await getToken('https://purview.azure.net/.default');
    await getToken('https://purview.azure.net/.default');
    assert.equal(await callCount(), 1);
  });

  test('concurrent callers share one acquisition', async () => {
    // keyvault.js asks for sixteen secrets at once. Without in-flight
    // de-duplication that is sixteen simultaneous CLI processes, which on
    // Windows is slow enough to trip the 5s per-request timeout and make a
    // healthy vault look unreachable.
    const expires = Math.floor(Date.now() / 1000) + 3600;
    await writeStub(`{"accessToken":"tok-shared","expires_on":${expires}}`);
    const results = await Promise.all(
      Array.from({ length: 16 }, () => getToken('https://vault.azure.net/.default'))
    );
    assert.deepEqual(new Set(results), new Set(['tok-shared']));
    assert.equal(await callCount(), 1);
  });

  test('the legacy local-time expiresOn string still parses', async () => {
    // No zone, and Date parses it inconsistently across platforms. A NaN
    // expiry silently defeats the cache and re-shells on every single call.
    const d = new Date(Date.now() + 3600_000);
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(
      2,
      '0'
    )}:${String(d.getSeconds()).padStart(2, '0')}.000000`;
    await writeStub(`{"accessToken":"tok-legacy","expiresOn":"${local}"}`);
    await getToken('https://management.azure.com/.default');
    await getToken('https://management.azure.com/.default');
    assert.equal(await callCount(), 1, 'a parsed expiry must keep the cache working');
  });

  test('"not signed in" is reported as az login, not as a spawn error', async () => {
    const az = path.join(dir, 'az');
    await writeFile(az, "#!/bin/sh\nprintf '%s\\n' 'ERROR: Please run az login to setup account.' >&2\nexit 1\n", 'utf8');
    await chmod(az, 0o755);
    await assert.rejects(getToken('https://purview.azure.net/.default'), /az login/i);
  });

  test('non-JSON output is reported as such', async () => {
    const az = path.join(dir, 'az');
    await writeFile(az, "#!/bin/sh\nprintf '%s\\n' 'not json at all'\n", 'utf8');
    await chmod(az, 0o755);
    await assert.rejects(getToken('https://purview.azure.net/.default'), /not JSON/i);
  });

  test('a missing CLI names what it tried', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'cortex-empty-'));
    const saved = process.env.PATH;
    // Only this directory, so `az` genuinely cannot be found. Safe here
    // because nothing below relies on PATH lookups.
    process.env.PATH = empty;
    clearTokenCache();
    try {
      await assert.rejects(getToken('https://purview.azure.net/.default'), /not found or not runnable/i);
    } finally {
      process.env.PATH = saved;
      await rm(empty, { recursive: true, force: true });
    }
  });

  test('a failure is not cached — the next call retries', async () => {
    const az = path.join(dir, 'az');
    await writeFile(az, "#!/bin/sh\nprintf '%s\\n' 'ERROR: Please run az login' >&2\nexit 1\n", 'utf8');
    await chmod(az, 0o755);
    await assert.rejects(getToken('https://ai.azure.com/.default'));

    const expires = Math.floor(Date.now() / 1000) + 3600;
    await writeStub(`{"accessToken":"tok-after-login","expires_on":${expires}}`);
    assert.equal(await getToken('https://ai.azure.com/.default'), 'tok-after-login');
  });
});
