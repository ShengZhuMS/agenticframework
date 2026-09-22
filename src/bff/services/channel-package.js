import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import { canRedTeam } from './redteam.js';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function icon(size, outline) {
  const chunk = (name, data) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const inside = x > size * .2 && x < size * .8 && y > size * .2 && y < size * .8;
    const mark = inside && (x < size * .34 || y < size * .34 || y > size * .66);
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    pixels.set(mark ? [255, 255, 255, 255] : outline ? [0, 0, 0, 0] : [0, 103, 184, 255], offset);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export function channelPackage(entry, live, metadata, user, baseUrl) {
  if (!canRedTeam(entry, user)) throw new Error('Only the recorded builder or a reviewer may prepare this agent package.');
  const botId = live?.instance_identity?.client_id || live?.versions?.latest?.instance_identity?.client_id;
  if (!/^[0-9a-f-]{36}$/i.test(botId || '')) throw new Error('Foundry has not returned a native agent identity. A package cannot be prepared yet.');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('A credential-free HTTPS app URL is required.');
  const hash = createHash('sha256').update(`cortex:${entry.id}`).digest('hex');
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const manifest = {
    $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.21/MicrosoftTeams.schema.json',
    manifestVersion: '1.21', version: metadata.appVersion, id,
    name: { short: metadata.agentDisplayName },
    description: { short: metadata.shortDescription, full: metadata.fullDescription },
    developer: { name: metadata.developerName, websiteUrl: metadata.developerWebsiteUrl, privacyUrl: metadata.privacyUrl, termsOfUseUrl: metadata.termsOfUseUrl },
    icons: { color: 'color.png', outline: 'outline.png' }, accentColor: '#0067B8',
    bots: [{ botId, scopes: ['personal'], isNotificationOnly: false, supportsFiles: false }],
    copilotAgents: { customEngineAgents: [{ id: botId, type: 'bot' }] },
    validDomains: [base.hostname]
  };
  const instructions = `Cortex app package for ${entry.name}

Package metadata and icon dimensions have been checked locally. Validate manifest.json in the Teams Developer Portal before installation.
This download does NOT create an Azure Bot Service, enable channels, submit to a tenant catalogue, or prove a successful conversation.

1. Review current agent assurance at ${base.origin}/agent/${encodeURIComponent(entry.id)}.
2. An administrator must configure a SingleTenant Azure Bot Service using app ID ${botId}, enable the Teams channel and use the documented Foundry activityProtocol endpoint. Do not bypass Entra authentication.
3. Pin the Foundry agent endpoint to the reviewed version. The native channel publication option performs these operations only after explicit consent and a passing assessment.
4. Upload this ZIP through Teams Developer Portal / Manage your apps. Tenant custom app policies and Microsoft 365 Copilot entitlement may require approval.
5. Install in the intended Teams and Microsoft 365 Copilot surfaces. Send a synthetic question, verify a cited answer and follow-up, and record results. Until then delivery is NOT VERIFIED.

No secrets are included. Bot/channel provisioning and additional Azure usage require separate approval.
`;
  return { manifest, bytes: Buffer.from(zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'color.png': icon(192, false), 'outline.png': icon(32, true),
    'INSTALLATION.txt': strToU8(instructions)
  })), filename: `cortex-${entry.id}.zip` };
}
