/**
 * Token acquisition for Azure data-plane and management-plane calls.
 *
 * Uses the Container Apps / App Service managed identity endpoint when
 * present, and falls back to the Azure CLI for local development. No
 * secrets, no client credentials in code.
 *
 * Tokens are cached until 5 minutes before expiry.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Tokens by scope. */
const cache = new Map();

/**
 * In-flight acquisitions by scope.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. keyvault.js resolves the whole secret
 * catalogue with `Promise.all`, so sixteen `get()` calls ask for the same
 * vault token at the same instant. Without this map that is sixteen
 * simultaneous `az` processes — on Windows, sixteen cmd.exe shells each
 * starting Python — which is slow enough to blow the 5s per-request timeout
 * in keyvault.js and make a perfectly good vault look unreachable.
 * One acquisition per scope, shared by every caller waiting on it.
 */
const inFlight = new Map();

const REFRESH_MARGIN_MS = 300_000;

/** A hung `az` must not block startup or a bootstrap run forever. */
const CLI_TIMEOUT_MS = Number(process.env.AZ_CLI_TIMEOUT_MS || 60_000);

/** The managed identity endpoint is local, but fetch() still has no default timeout. */
const MI_TIMEOUT_MS = Number(process.env.MSI_TIMEOUT_MS || 5000);

const IS_WINDOWS = process.platform === 'win32';

/**
 * RUNNING THE AZURE CLI FROM NODE ON WINDOWS — two separate traps, and they
 * present as two different errors, which is why this took three attempts.
 *
 * 1. There is no `az.exe`. The Azure CLI installs as `az.cmd`, a batch wrapper
 *    around Python. `execFile` does not go through a shell and does not apply
 *    PATHEXT, so asking it for `az` produces `spawn az ENOENT` — which reads
 *    like the CLI is missing when it is on PATH and works from the same prompt.
 *
 * 2. Naming `az.cmd` explicitly then hits the OTHER wall. Since the fix for
 *    CVE-2024-27980 ("BatBadBut") in Node 18.20.2 / 20.12.2 / 21.7.3 and every
 *    release after, Node refuses to spawn a `.bat` or `.cmd` without
 *    `shell: true` and fails with `spawn EINVAL`. There is no way around it:
 *    for a `.cmd`, a shell is now mandatory.
 *
 * So `shell: true` — but only on Windows, only for the batch wrappers, and
 * only with the one variable argument strictly validated first (see
 * assertSafeResource). Node's own advisory draws exactly this distinction: the
 * shell option is appropriate when the input reaching it is sanitised. On
 * Linux and macOS `az` is a real executable and no shell is involved at all.
 */
export function candidatesFor(platform) {
  return platform === 'win32'
    ? [
        { command: 'az.cmd', shell: true },
        { command: 'az.bat', shell: true },
        // Last resort: let the shell do its own PATHEXT resolution.
        { command: 'az', shell: true }
      ]
    : [{ command: 'az', shell: false }];
}

const AZ_CANDIDATES = candidatesFor(process.platform);

/** Remembered once one works, so the cost of probing is paid once. */
let resolvedAz = null;

/**
 * The only variable passed to the CLI is the resource, derived from a scope
 * constant in config.js. Validate it anyway: this is the single value that
 * reaches a shell on Windows, and an allowlist here is what makes `shell: true`
 * safe rather than merely convenient. Anything outside [A-Za-z0-9.-/] — a
 * quote, a space, an ampersand, a caret, a percent — is rejected before it can
 * reach the shell.
 */
const SAFE_RESOURCE = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.\-/]*$/;

function assertSafeResource(resource) {
  if (!SAFE_RESOURCE.test(resource)) {
    throw new Error(
      `Refusing to request a token for an unexpected resource: ${JSON.stringify(resource)}. ` +
        'Scopes are code-level constants and must look like https://host[/path].'
    );
  }
  return resource;
}

/**
 * `command not found`, reported by the shell rather than by Node.
 *
 * With `shell: true` a missing command is NOT an ENOENT from Node — the shell
 * starts fine, fails to find the program, and exits non-zero. cmd.exe uses
 * 9009 and POSIX shells use 127 for exactly this, and those numbers are the
 * same in every locale. The English text match below is a secondary signal
 * only: on a Danish, German or French Windows the message is translated, so
 * matching text alone would abandon the candidate loop and report a missing
 * CLI as an Azure failure.
 */
const SHELL_COMMAND_NOT_FOUND = new Set([9009, 127]);

function looksLikeMissingCommand(err) {
  const text = String(err?.stderr || '') + String(err?.stdout || '') + String(err?.message || '');
  // Deliberately specific. A bare /not found/ also matches real Azure errors
  // such as "AADSTS500011: The resource principal was not found", which would
  // send the candidate loop hunting for another CLI and report a genuine
  // authorisation failure as a missing install. The exit codes above are the
  // reliable signal; this is only a backstop.
  return /is not recognized as an internal or external command|command not found|cannot find the path specified|no such file or directory/i.test(
    text
  );
}

/** Spawn-level failures that mean "this candidate is not usable, try the next". */
function isUnusable(err) {
  if (!err) return false;
  // Node-level: not found, not executable, or a .cmd refused for want of a shell.
  if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EINVAL') return true;
  // Shell-level: locale-independent exit codes, then the text as a fallback.
  if (SHELL_COMMAND_NOT_FOUND.has(err.code)) return true;
  return looksLikeMissingCommand(err);
}

/** The CLI was found and started but never returned. */
function isTimeout(err) {
  return Boolean(err && (err.killed || err.signal === 'SIGTERM') && !isUnusable(err));
}

async function fromManagedIdentity(scope) {
  const endpoint = process.env.IDENTITY_ENDPOINT || process.env.MSI_ENDPOINT;
  const header = process.env.IDENTITY_HEADER || process.env.MSI_SECRET;
  if (!endpoint || !header) return null;

  const resource = scope.replace(/\/\.default$/, '');
  const url = new URL(endpoint);
  url.searchParams.set('api-version', '2019-08-01');
  url.searchParams.set('resource', resource);
  if (process.env.AZURE_CLIENT_ID) {
    url.searchParams.set('client_id', process.env.AZURE_CLIENT_ID);
  }

  // Bounded, per the convention in keyvault.js: no outbound call may hang
  // startup. A silent identity endpoint would otherwise stall the container
  // before it can fall back to the CLI or to environment configuration.
  const res = await fetch(url, {
    headers: { 'X-IDENTITY-HEADER': header },
    signal: AbortSignal.timeout(MI_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Managed identity token failed ${res.status}`);
  const json = await res.json();
  return {
    token: json.access_token,
    expiresAt: Number(json.expires_on) * 1000 || Date.now() + 3300_000
  };
}

async function runAz(candidate, resource) {
  if (candidate.shell) {
    // ONE STRING, NO ARGS ARRAY.
    // Node 24 deprecates passing an args array together with shell: true
    // (DEP0190) precisely because the array is concatenated rather than
    // escaped, which invites the assumption that it is escaped. Building the
    // line explicitly makes the quoting visible and deliberate — and
    // `resource` has already been allowlisted by assertSafeResource, so there
    // is nothing in it a shell could act on.
    const line =
      `${candidate.command} account get-access-token ` +
      `--resource "${resource}" --output json`;
    return exec(line, {
      windowsHide: true,
      shell: true,
      maxBuffer: 1024 * 1024,
      timeout: CLI_TIMEOUT_MS
    });
  }
  return exec(
    candidate.command,
    ['account', 'get-access-token', '--resource', resource, '--output', 'json'],
    { windowsHide: true, maxBuffer: 1024 * 1024, timeout: CLI_TIMEOUT_MS }
  );
}

async function fromAzureCli(scope) {
  const resource = assertSafeResource(scope.replace(/\/\.default$/, ''));

  const candidates = resolvedAz ? [resolvedAz] : AZ_CANDIDATES;
  let stdout = null;
  let lastUnusable = null;

  for (const candidate of candidates) {
    try {
      ({ stdout } = await runAz(candidate, resource));
      resolvedAz = candidate;
      break;
    } catch (err) {
      if (isTimeout(err)) {
        throw new Error(
          `Azure CLI did not respond within ${CLI_TIMEOUT_MS}ms while getting a token for ` +
            `${resource}. Run "az account get-access-token --resource ${resource}" by hand — ` +
            'if it prompts for anything, the CLI is waiting for input it cannot get here.'
        );
      }
      if (isUnusable(err)) {
        lastUnusable = err;
        continue;
      }
      // The CLI ran and refused. The useful part is one line inside a long
      // stderr, so surface that rather than the whole thing.
      const detail = String(err.stderr || err.message || '');
      if (/az login|not logged in|Please run ['"]?az login|AADSTS50058/i.test(detail)) {
        throw new Error('Azure CLI is not signed in. Run: az login');
      }
      throw new Error(
        `Azure CLI could not get a token for ${resource}: ${detail.trim().slice(0, 300)}`
      );
    }
  }

  if (stdout === null) {
    const tried = AZ_CANDIDATES.map((c) => c.command).join(', ');
    throw new Error(
      `Azure CLI not found or not runnable (tried ${tried}). ` +
        'Install it, or open a new terminal so PATH is refreshed. ' +
        `Underlying error: ${lastUnusable?.message || 'unknown'}`
    );
  }

  // A stray warning or a BOM ahead of the JSON turns JSON.parse into
  // "Unexpected token", which says nothing about the CLI. Say what came back.
  let json;
  try {
    json = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
  } catch {
    throw new Error(
      `Azure CLI returned output that is not JSON for ${resource}: ` +
        `${String(stdout).trim().slice(0, 200)}`
    );
  }
  if (!json?.accessToken) {
    throw new Error(`Azure CLI returned no access token for ${resource}.`);
  }

  // expiresOn is a LOCAL time string with no zone ("2026-09-02 18:11:11.000000"),
  // which Date parses inconsistently across platforms and can yield NaN. A NaN
  // expiry silently defeats the cache — every call re-shells to the CLI, which
  // is slow enough to notice across a bootstrap run. Newer CLI versions also
  // return expires_on as epoch seconds, so prefer that.
  let expiresAt = Number(json.expires_on) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    expiresAt = new Date(String(json.expiresOn || '').replace(' ', 'T')).getTime();
  }
  if (!Number.isFinite(expiresAt)) expiresAt = Date.now() + 3300_000;

  return { token: json.accessToken, expiresAt };
}

async function acquire(scope) {
  let result = null;
  try {
    result = await fromManagedIdentity(scope);
  } catch {
    result = null;
  }
  if (!result) result = await fromAzureCli(scope);
  return result;
}

export async function getToken(scope) {
  const hit = cache.get(scope);
  if (hit && hit.expiresAt - Date.now() > REFRESH_MARGIN_MS) return hit.token;

  const pending = inFlight.get(scope);
  if (pending) return pending;

  // Share one acquisition across every concurrent caller for this scope, and
  // drop it from the map either way so a failure is retried rather than
  // remembered.
  const promise = acquire(scope)
    .then((result) => {
      cache.set(scope, result);
      return result.token;
    })
    .finally(() => {
      inFlight.delete(scope);
    });

  inFlight.set(scope, promise);
  return promise;
}

export function clearTokenCache() {
  cache.clear();
  inFlight.clear();
  resolvedAz = null;
}

/**
 * Internals exposed for tests only — not part of this module's contract.
 *
 * The classification in isUnusable() is the thing that broke twice and cost
 * two rounds of "run it again on your machine". It is pure, so it can be
 * tested here on any platform rather than only discovered on Windows.
 */
export const __testing = {
  assertSafeResource,
  candidatesFor,
  isUnusable,
  isTimeout,
  looksLikeMissingCommand,
  SAFE_RESOURCE
};
