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
const cache = new Map();

/**
 * WHY THIS IS A LIST AND NOT JUST 'az'.
 *
 * On Windows the Azure CLI is installed as `az.cmd`, a batch wrapper around
 * Python — there is no `az.exe`. `execFile` does not go through a shell and
 * does not apply PATHEXT, so it looks for a file literally named `az`, finds
 * nothing, and fails with:
 *
 *     spawn az ENOENT
 *
 * which reads like the CLI is not installed when it is on PATH and works
 * perfectly from the same prompt. On Linux and macOS `az` is a real
 * executable with a shebang, so the bare name is correct there — which is why
 * this never surfaced in the container.
 *
 * Deliberately NOT solved with `shell: true`. That would fix it by handing the
 * arguments to cmd.exe for re-parsing, which is a shell-injection surface for
 * the sake of a filename extension.
 */
const AZ_CANDIDATES = process.platform === 'win32' ? ['az.cmd', 'az.bat', 'az'] : ['az'];

/** Remembered once the first candidate works, so the cost is paid once. */
let resolvedAzCommand = null;

function isNotFound(err) {
  // ENOENT is the command not existing. EACCES covers a candidate that is
  // present but not executable, which should also move on to the next one.
  return err && (err.code === 'ENOENT' || err.code === 'EACCES');
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

  const res = await fetch(url, { headers: { 'X-IDENTITY-HEADER': header } });
  if (!res.ok) throw new Error(`Managed identity token failed ${res.status}`);
  const json = await res.json();
  return {
    token: json.access_token,
    expiresAt: Number(json.expires_on) * 1000 || Date.now() + 3300_000
  };
}

async function fromAzureCli(scope) {
  const resource = scope.replace(/\/\.default$/, '');
  const args = ['account', 'get-access-token', '--resource', resource, '--output', 'json'];

  const candidates = resolvedAzCommand ? [resolvedAzCommand] : AZ_CANDIDATES;
  let lastNotFound = null;
  let stdout = null;

  for (const command of candidates) {
    try {
      ({ stdout } = await exec(command, args, { windowsHide: true }));
      resolvedAzCommand = command;
      break;
    } catch (err) {
      if (isNotFound(err)) {
        lastNotFound = err;
        continue;
      }
      // The CLI ran and refused. Almost always not signed in, or signed in to
      // a tenant without access to the resource — say which, because the raw
      // stderr is long and the actionable part is one line.
      const detail = String(err.stderr || err.message || '');
      if (/az login|not logged in|Please run ['"]?az login/i.test(detail)) {
        throw new Error('Azure CLI is not signed in. Run: az login');
      }
      throw new Error(`Azure CLI could not get a token for ${resource}: ${detail.trim().slice(0, 300)}`);
    }
  }

  if (stdout === null) {
    throw new Error(
      `Azure CLI not found (tried ${AZ_CANDIDATES.join(', ')}). ` +
        'Install it, or open a new terminal so PATH is refreshed. ' +
        `Underlying error: ${lastNotFound?.message || 'unknown'}`
    );
  }

  const json = JSON.parse(stdout);

  // expiresOn is a LOCAL time string with no zone ("2026-09-02 18:11:11.000000"),
  // which Date parses inconsistently across platforms and can yield NaN. A NaN
  // expiry silently defeats the cache — every call re-shells to the CLI, which
  // is slow enough to notice on a bootstrap run. Newer CLI versions also return
  // expires_on as epoch seconds, so prefer that and treat the rest as fallback.
  let expiresAt = Number(json.expires_on) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    expiresAt = new Date(String(json.expiresOn || '').replace(' ', 'T')).getTime();
  }
  if (!Number.isFinite(expiresAt)) expiresAt = Date.now() + 3300_000;

  return { token: json.accessToken, expiresAt };
}

export async function getToken(scope) {
  const hit = cache.get(scope);
  if (hit && hit.expiresAt - Date.now() > 300_000) return hit.token;

  let result = null;
  try {
    result = await fromManagedIdentity(scope);
  } catch {
    result = null;
  }
  if (!result) result = await fromAzureCli(scope);

  cache.set(scope, result);
  return result.token;
}

export function clearTokenCache() {
  cache.clear();
  resolvedAzCommand = null;
}
