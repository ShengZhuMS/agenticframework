/**
 * Bootstrap — create the Defra content in your real Azure resources.
 *
 * Creates, in Microsoft Purview:
 *   - 9 governance domains
 *   - 14 data products, published
 *
 * And in Azure API Management:
 *   - a REST API and an MCP server per skill
 *
 * Run once after `azd up`:  npm run bootstrap
 *
 * IDEMPOTENT. Running it again updates rather than duplicates, so it is safe
 * to re-run after a partial failure — which matters, because the Purview
 * publish transition is the least certain step in the whole deployment.
 *
 * WHAT THIS IS NOT
 * This is not seeding a demo. Everything it writes goes into your real
 * Purview account through the Unified Catalog API and is read back by the app
 * through the same API. Delete a data product in the Purview portal and it
 * disappears from the Marketplace on the next refresh.
 *
 * ⚠️ PUBLISH IS A STATUS TRANSITION, NOT AN OPERATION.
 * There is no publish verb in the Unified Catalog API. You PUT the whole
 * object with status PUBLISHED. Two traps, both handled below: PUT is a full
 * replace, so read-modify-write; and the casing differs between planes — the
 * entity uses DRAFT/PUBLISHED/EXPIRED, the query filter uses Draft/Published.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import config, { hydrateConfig, missingRequired } from '../src/bff/config.js';
import { getToken } from '../src/bff/adapters/token.js';

const ARM_SCOPE = 'https://management.azure.com/.default';
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const ONLY = [...args].find((a) => a.startsWith('--only='))?.split('=')[1];

let created = 0;
let updated = 0;
let failed = 0;

const log = {
  step: (m) => console.log(`\n=== ${m} ===`),
  ok: (m) => console.log(`  ok    ${m}`),
  skip: (m) => console.log(`  skip  ${m}`),
  fail: (m) => console.log(`  FAIL  ${m}`)
};

/* ------------------------------------------------------------- purview */

async function purviewFetch(pathname, { method = 'GET', body, query = {} } = {}) {
  const url = new URL(pathname, config.purview.endpoint);
  url.searchParams.set('api-version', config.purview.apiVersion);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

  const token = await getToken(config.purview.scope);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${pathname} → ${res.status} ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Deterministic GUID from a stable string, so re-running finds what it made. */
function guidFor(seed) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + seed.charCodeAt(i) + 1, 2246822519) >>> 0;
  }
  const hex = (n) => n.toString(16).padStart(8, '0');
  const a = hex(h1);
  const b = hex(h2);
  const c = hex((h1 ^ h2) >>> 0);
  const d = hex((h1 + h2) >>> 0);
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-8${c.slice(1, 4)}-${c.slice(4)}${d}`;
}

async function bootstrapDomains(domains) {
  log.step(`Governance domains (${domains.length})`);
  const ids = {};

  let existing = [];
  if (!DRY_RUN) {
    try {
      const page = await purviewFetch('/datagovernance/catalog/businessdomains');
      existing = page.value || [];
    } catch (err) {
      log.fail(`could not list domains — ${err.message}`);
      throw err;
    }
  }

  for (const d of domains) {
    const id = guidFor(`domain:${d.id}`);
    ids[d.id] = id;
    const already = existing.find((x) => x.id === id || x.name === d.name);

    if (DRY_RUN) {
      log.skip(`${d.name} (dry run)`);
      continue;
    }

    try {
      const body = {
        id,
        name: d.name,
        description: d.description,
        type: 'DataDomain',
        status: 'PUBLISHED'
      };
      if (already) {
        await purviewFetch(`/datagovernance/catalog/businessdomains/${already.id}`, {
          method: 'PUT',
          body: { ...already, ...body, id: already.id }
        });
        ids[d.id] = already.id;
        updated++;
        log.ok(`${d.name} (updated)`);
      } else {
        const res = await purviewFetch('/datagovernance/catalog/businessdomains', {
          method: 'POST',
          body
        });
        ids[d.id] = res?.id || id;
        created++;
        log.ok(`${d.name} (created)`);
      }
    } catch (err) {
      failed++;
      log.fail(`${d.name} — ${err.message}`);
    }
  }
  return ids;
}

async function bootstrapDataProducts(products, domainIds) {
  log.step(`Data products (${products.length})`);

  let existing = [];
  try {
    if (!DRY_RUN) {
      const res = await purviewFetch('/datagovernance/catalog/dataProducts/query', {
        method: 'POST',
        body: { top: 500 }
      });
      existing = res.value || [];
    }
  } catch {
    // A query failure is not fatal — treat everything as new and let the
    // per-product create report its own error.
  }

  for (const p of products) {
    const id = guidFor(`product:${p.id}`);
    const domain = domainIds[p.domain];
    if (!domain) {
      failed++;
      log.fail(`${p.name} — no governance domain for "${p.domain}"`);
      continue;
    }

    const already = existing.find((x) => x.id === id || x.name === p.name);

    // Fields Cortex needs that the Unified Catalog has no column for are
    // carried as managed attributes, so the entry standard survives a round
    // trip through Purview rather than living only in this app.
    const body = {
      id: already?.id || id,
      name: p.name,
      domain,
      description: p.description,
      businessUse: p.businessUse || '',
      type: 'Operational',
      updateFrequency: mapFrequency(p.updateFrequency),
      status: 'PUBLISHED',
      audience: ['BusinessUser', 'DataAnalyst'],
      managedAttributes: attributesFor(p)
    };

    if (DRY_RUN) {
      // Validate the payload rather than just skipping — a bad enum or a
      // missing domain is exactly what a dry run should catch.
      const freq = mapFrequency(p.updateFrequency);
      const attrs = Object.keys(attributesFor(p)).length;
      log.skip(`${p.name} → domain ${p.domain}, ${freq}, ${attrs} attributes`);
      continue;
    }

    try {
      if (already) {
        // PUT is a full replace, so merge over what is already there.
        await purviewFetch(`/datagovernance/catalog/dataProducts/${already.id}`, {
          method: 'PUT',
          body: { ...already, ...body }
        });
        updated++;
        log.ok(`${p.name} (updated, published)`);
      } else {
        await purviewFetch('/datagovernance/catalog/dataProducts', { method: 'POST', body });
        created++;
        log.ok(`${p.name} (created, published)`);
      }
    } catch (err) {
      // The portal enforces preconditions on publishing whose API behaviour is
      // undocumented. If publishing is refused, fall back to DRAFT so the
      // product at least exists and can be published by hand.
      try {
        const draft = { ...body, status: 'DRAFT' };
        if (already) {
          await purviewFetch(`/datagovernance/catalog/dataProducts/${already.id}`, {
            method: 'PUT',
            body: { ...already, ...draft }
          });
        } else {
          await purviewFetch('/datagovernance/catalog/dataProducts', { method: 'POST', body: draft });
        }
        created++;
        log.ok(`${p.name} (created as DRAFT — publish refused: ${err.message.slice(0, 80)})`);
      } catch (err2) {
        failed++;
        log.fail(`${p.name} — ${err2.message}`);
      }
    }
  }
}

/** Purview accepts a fixed enum; anything else must be mapped or dropped. */
function mapFrequency(f) {
  const v = String(f || '').toLowerCase();
  if (v.includes('minute') || v.includes('live') || v.includes('hour')) return 'Hourly';
  if (v.includes('dai')) return 'Daily';
  if (v.includes('week')) return 'Weekly';
  if (v.includes('month')) return 'Monthly';
  if (v.includes('quarter')) return 'Quarterly';
  if (v.includes('year') || v.includes('annual')) return 'Yearly';
  return 'Daily';
}

function attributesFor(p) {
  const attrs = {};
  const set = (k, v) => {
    if (v !== null && v !== undefined && v !== '') attrs[k] = String(v);
  };
  set('cortexSensitivity', p.sensitivity);
  set('cortexLicence', p.licence);
  set('cortexAccessRoute', p.accessRoute);
  set('cortexOwnerTeam', p.owner);
  set('cortexLimitations', p.limitations);
  set('cortexMinimumAggregation', p.minimumAggregation);
  set('cortexAllowedGroups', (p.allowedGroups || []).join(','));
  set('cortexAskable', (p.askable || []).join('|'));
  set('cortexDependsOn', (p.dependsOn || []).join(','));
  set('cortexLocation', p.location);
  set('cortexFreshness', p.updateFrequency);
  return attrs;
}

/* ---------------------------------------------------------------- apim */

async function apimFetch(pathname, { method = 'GET', body, query = {}, headers = {} } = {}) {
  const base =
    `https://management.azure.com/subscriptions/${config.apim.subscriptionId}` +
    `/resourceGroups/${config.apim.resourceGroup}` +
    `/providers/Microsoft.ApiManagement/service/${config.apim.serviceName}`;
  const url = new URL(base + pathname);
  url.searchParams.set('api-version', config.apim.apiVersion);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

  const token = await getToken(ARM_SCOPE);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${pathname} → ${res.status} ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function bootstrapSkills(skills) {
  log.step(`API Management — skills and apps (${skills.length})`);

  for (const s of skills) {
    if (DRY_RUN) {
      log.skip(`${s.name} (dry run)`);
      continue;
    }
    try {
      // A REST API per skill, pointed at the Cortex shim so it is genuinely
      // callable rather than a name in a list.
      const spec = skillSpec(s, config.publicBaseUrl);
      await apimFetch(`/apis/${s.id}`, {
        method: 'PUT',
        headers: { 'If-Match': '*' },
        body: {
          properties: {
            format: 'openapi+json',
            value: JSON.stringify(spec),
            path: s.id,
            displayName: s.name,
            description: s.description,
            protocols: ['https'],
            subscriptionRequired: true
          }
        }
      });

      // Then project it as an MCP server so an agent can call it.
      await apimFetch(`/apis/${s.id}-mcp`, {
        method: 'PUT',
        headers: { 'If-Match': '*' },
        body: {
          properties: {
            type: 'mcp',
            displayName: `${s.name} (MCP)`,
            description: s.description,
            path: `${s.id}-mcp`,
            protocols: ['https'],
            subscriptionRequired: true
          }
        }
      });

      await apimFetch(`/apis/${s.id}-mcp/tools/invoke`, {
        method: 'PUT',
        headers: { 'If-Match': '*' },
        body: {
          properties: {
            displayName: 'invoke',
            description: s.description,
            operationId:
              `/subscriptions/${config.apim.subscriptionId}` +
              `/resourceGroups/${config.apim.resourceGroup}` +
              `/providers/Microsoft.ApiManagement/service/${config.apim.serviceName}` +
              `/apis/${s.id}/operations/invoke`
          }
        }
      });

      await apimFetch(`/products/${config.apim.productId}/apis/${s.id}-mcp`, {
        method: 'PUT',
        headers: { 'Content-Length': '0' }
      }).catch(() => {});

      created++;
      log.ok(`${s.name} (API + MCP server)`);
    } catch (err) {
      failed++;
      log.fail(`${s.name} — ${err.message}`);
    }
  }
}

function skillSpec(s, baseUrl) {
  return {
    openapi: '3.0.3',
    info: { title: s.name, version: '1', description: s.description },
    servers: [{ url: `${baseUrl || 'https://localhost'}/shim/skills/${s.id}` }],
    paths: {
      '/invoke': {
        post: {
          operationId: 'invoke',
          summary: s.name,
          description: s.description,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['query'],
                  properties: { query: { type: 'string' } }
                }
              }
            }
          },
          responses: { 200: { description: 'Result' } }
        }
      }
    }
  };
}

/* ---------------------------------------------------------------- main */

async function main() {
  console.log('Cortex bootstrap');
  console.log(DRY_RUN ? '  DRY RUN — nothing will be written\n' : '');

  if (!DRY_RUN) await hydrateConfig();

  const missing = DRY_RUN ? [] : missingRequired();
  if (missing.length && !DRY_RUN) {
    console.error('\nMissing required configuration:');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('\nOnboard these to Key Vault, or set them as environment variables.');
    console.error('See docs/keyvault.md.');
    process.exit(1);
  }

  console.log(`  purview : ${config.purview.endpoint}`);
  console.log(`  apim    : ${config.apim.serviceName || '(not set)'}`);

  const dir = config.bootstrapDir;
  const read = async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'));

  const domains = await read('domains.json');
  const products = await read('data-products.json');
  const skills = await read('skills.json');

  let domainIds = {};
  if (!ONLY || ONLY === 'purview') {
    domainIds = await bootstrapDomains(domains);
    await bootstrapDataProducts(products, domainIds);
  }
  if (!ONLY || ONLY === 'apim') {
    if (!config.apim.serviceName) {
      log.step('API Management');
      log.skip('APIM_SERVICE_NAME not set — skipping');
    } else {
      await bootstrapSkills(skills);
    }
  }

  console.log(`\n${created} created, ${updated} updated, ${failed} failed.`);
  if (failed) {
    console.log('\nRe-running is safe — bootstrap is idempotent.');
    console.log('If Purview refused, check the governance domain roles in the Purview portal:');
    console.log('  Data Product Owner (catalogue plane) AND Data reader (Data Map plane).');
    console.log('  Both are required. Missing the second is the most common cause.');
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nBootstrap failed:', err.message);
  process.exit(1);
});
