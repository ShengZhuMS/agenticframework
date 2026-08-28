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
  const { stdout } = await exec('az', [
    'account',
    'get-access-token',
    '--resource',
    resource,
    '--output',
    'json'
  ]);
  const json = JSON.parse(stdout);
  return {
    token: json.accessToken,
    expiresAt: new Date(json.expiresOn).getTime()
  };
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
}
