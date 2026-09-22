import { createHash } from 'node:crypto';
import config from '../config.js';
import { getToken } from './token.js';

export function channelMetadata(form, { requireConsent = true } = {}) {
  const value = (key, max) => {
    if (typeof form[key] !== 'string' || !form[key].trim() || form[key].length > max) throw new Error(`Microsoft 365 ${key} is required (maximum ${max} characters).`);
    return form[key].trim();
  };
  const result = {
    agentDisplayName: value('name', 30), appVersion: value('version', 30),
    shortDescription: value('purpose', 80), fullDescription: value('description', 4000),
    developerName: value('owner', 32), developerWebsiteUrl: value('developerWebsiteUrl', 500),
    privacyUrl: value('privacyUrl', 500), termsOfUseUrl: value('termsOfUseUrl', 500),
    publishScope: 'Tenant', publishAsAutopilot: false
  };
  if (!/^\d+\.\d+\.\d+$/.test(result.appVersion)) throw new Error('Use a semantic package version.');
  for (const key of ['developerWebsiteUrl', 'privacyUrl', 'termsOfUseUrl']) {
    const url = new URL(result[key]);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${key} must be an HTTPS URL without credentials.`);
  }
  if (requireConsent && form.channelConsent !== 'yes') throw new Error('Confirm submission to the tenant catalogue. Tenant administrators retain approval control.');
  return result;
}

async function arm(path, method, body) {
  const response = await fetch(`https://management.azure.com${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { Authorization: ['Bearer', await getToken('https://management.azure.com/.default')].join(' '), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error(`Azure Bot Service ${method} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response.status === 204 ? null : response.json();
}

export async function publishChannels(foundry, agentName, assessedVersion, metadata, checkpoint) {
  const tenantId = process.env.AZURE_TENANT_ID || process.env.ENTRA_TENANT_ID;
  if (!/^[0-9a-f-]{36}$/i.test(tenantId || '')) throw new Error('AZURE_TENANT_ID must be configured before channel publication.');
  const agent = await foundry.getAgent(agentName);
  const clientId = agent?.instance_identity?.client_id;
  if (!clientId) throw new Error('This Foundry agent lacks a unique instance identity. Create a new-model wrapper before publishing to Microsoft 365.');
  const name = `cortex-agent-${createHash('sha256').update(agentName).digest('hex').slice(0, 16)}`;
  const botId = `/subscriptions/${config.apim.subscriptionId}/resourceGroups/${config.foundry.resourceGroup}/providers/Microsoft.BotService/botServices/${name}`;
  const path = `${botId}?api-version=2022-09-15`;
  const existing = await arm(path, 'GET');
  if (existing && existing.tags?.['cortex-agent'] !== agentName) throw new Error('Refusing to overwrite an unrelated Azure Bot Service.');
  await arm(path, 'PUT', {
    location: 'global', kind: 'azurebot', sku: { name: 'F0' }, tags: { 'cortex-agent': agentName },
    properties: { displayName: metadata.agentDisplayName, msaAppId: clientId, msaAppTenantId: tenantId,
      msaAppType: 'SingleTenant', publicNetworkAccess: 'Disabled',
      endpoint: `${config.foundry.projectEndpoint}/agents/${encodeURIComponent(agentName)}/endpoint/protocols/activityProtocol?api-version=2025-05-15-preview` }
  });
  await checkpoint({ botServiceArmId: botId, state: 'bot-created' });
  await arm(`${botId}/channels/MsTeamsChannel?api-version=2022-09-15`, 'PUT',
    { location: 'global', properties: { channelName: 'MsTeamsChannel', properties: { isEnabled: true } } });
  await foundry._fetch(`/agents/${encodeURIComponent(agentName)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/merge-patch+json' },
    body: { agent_endpoint: { version_selector: { version_selection_rules: [
      { type: 'FixedRatio', agent_version: String(assessedVersion), traffic_percentage: 100 }
    ] } } }
  });
  const pinned = await foundry.getAgent(agentName);
  const rules = pinned?.agent_endpoint?.version_selector?.version_selection_rules;
  if (rules?.length !== 1 || String(rules[0].agent_version) !== String(assessedVersion) || rules[0].traffic_percentage !== 100) {
    throw new Error('Foundry did not confirm version-pinned channel routing. No channel package was submitted.');
  }
  // Save intent first: an uncertain POST must not be retried as a second tenant submission.
  await checkpoint({ state: 'submitting' });
  const response = await foundry._fetch(`/agents/${encodeURIComponent(agentName)}/microsoft365/publish`, {
    method: 'POST', body: { ...metadata, botServiceArmId: botId }, timeoutMs: 120000
  });
  await checkpoint({ state: 'submitted-for-approval', response });
  return { botServiceArmId: botId, state: 'submitted-for-approval', response };
}
