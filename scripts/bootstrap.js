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
import { fileURLToPath } from 'node:url';
import config, { hydrateConfig, missingRequired } from '../src/bff/config.js';
import { getToken } from '../src/bff/adapters/token.js';

const ARM_SCOPE = 'https://management.azure.com/.default';
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const NO_ADOPT = args.has('--no-adopt');
const ONLY = [...args].find((a) => a.startsWith('--only='))?.split('=')[1];

/**
 * Resolve the content directory against the REPOSITORY, not the working
 * directory. `config.bootstrapDir` defaults to the relative string 'bootstrap',
 * so running `node scripts/bootstrap.js` from anywhere except the repo root
 * used to fail with a bare ENOENT that named a path the user never typed.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * fetch() has no default timeout, so a back end that accepts the connection
 * and then goes quiet hangs bootstrap forever with no output. Same convention
 * as keyvault.js: bound every outbound call.
 */
const HTTP_TIMEOUT_MS = Number(process.env.BOOTSTRAP_HTTP_TIMEOUT_MS || 30_000);

/**
 * Purview's Unified Catalog allows only 100 List calls per 20 seconds, so a
 * 429 during a bootstrap run is a normal condition rather than a fault.
 */
const MAX_RETRIES = 3;

/** Query page size. Kept at the documented List ceiling. */
const PAGE_SIZE = 100;

/** How long to wait for an asynchronous APIM creation to become real. */
const ASYNC_TIMEOUT_MS = Number(process.env.APIM_ASYNC_TIMEOUT_MS || 60_000);

let created = 0;
let updated = 0;
let failed = 0;

const log = {
  step: (m) => console.log(`\n=== ${m} ===`),
  ok: (m) => console.log(`  ok    ${m}`),
  skip: (m) => console.log(`  skip  ${m}`),
  warn: (m) => console.log(`  warn  ${m}`),
  fail: (m) => console.log(`  FAIL  ${m}`)
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- purview */

async function purviewFetch(pathname, { method = 'GET', body, query = {} } = {}) {
  const url = new URL(pathname, config.purview.endpoint);
  url.searchParams.set('api-version', config.purview.apiVersion);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

  for (let attempt = 0; ; attempt++) {
    const token = await getToken(config.purview.scope);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        throw new Error(`${method} ${pathname} → no response within ${HTTP_TIMEOUT_MS}ms`);
      }
      throw err;
    }

    // Throttled or transiently unavailable: wait the advertised time and retry.
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 2000 * (attempt + 1);
      log.warn(`${res.status} from Purview — waiting ${Math.round(waitMs / 1000)}s and retrying`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${pathname} → ${res.status} ${text.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }
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

/**
 * List every governance domain, following the pagination cursor.
 *
 * The single-page version of this was an idempotency bug waiting to happen:
 * a tenant with more than one page of domains would not find the Cortex ones
 * on a re-run and would create them again.
 */
async function listAllDomains() {
  const out = [];
  let skipToken;
  do {
    const page = await purviewFetch('/datagovernance/catalog/businessdomains', {
      query: { $skipToken: skipToken }
    });
    out.push(...(page?.value || []));
    skipToken = page?.nextLink ? new URL(page.nextLink).searchParams.get('$skipToken') : null;
  } while (skipToken);
  return out;
}

/**
 * Query every data product Cortex might have created previously.
 *
 * multiStatus MUST include Draft. When the publish transition is refused the
 * fallback below creates the product as DRAFT — and a Published-only query
 * would then not find it on the next run and would create a duplicate. Note
 * the title-case filter values against the upper-case entity field; that
 * asymmetry is real.
 */
async function listAllDataProducts() {
  const out = [];
  for (let skip = 0; ; skip += PAGE_SIZE) {
    const res = await purviewFetch('/datagovernance/catalog/dataProducts/query', {
      method: 'POST',
      body: { skip, top: PAGE_SIZE, multiStatus: ['Published', 'Draft', 'Expired'] }
    });
    const batch = res?.value || [];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) return out;
  }
}

async function bootstrapDomains(domains) {
  log.step(`Governance domains (${domains.length})`);
  const ids = {};

  let existing = [];
  if (!DRY_RUN) {
    try {
      existing = await listAllDomains();
    } catch (err) {
      log.fail(`could not list domains — ${err.message}`);
      throw err;
    }
  }

  for (const d of domains) {
    const id = guidFor(`domain:${d.id}`);
    ids[d.id] = id;
    const byId = existing.find((x) => x.id === id);
    const byName = byId ? null : existing.find((x) => x.name === d.name);
    const already = byId || byName;

    if (DRY_RUN) {
      log.skip(`${d.name} (dry run)`);
      continue;
    }

    // Matching on name is what makes this idempotent when Purview assigns its
    // own id — but it also means a domain someone else created under the same
    // name gets updated in place. Say so rather than doing it silently.
    if (byName) {
      if (NO_ADOPT) {
        failed++;
        log.fail(`${d.name} — a domain of this name already exists and --no-adopt was given`);
        continue;
      }
      log.warn(`${d.name} — adopting the existing domain of this name (id ${byName.id})`);
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
  if (!DRY_RUN) {
    try {
      existing = await listAllDataProducts();
    } catch (err) {
      // Not fatal — but it does mean this run cannot tell new from existing,
      // so it must not pass silently the way it used to. A duplicate here is
      // far more confusing to unpick than a warning is to read.
      log.warn(`could not query existing data products — ${err.message}`);
      log.warn('proceeding as if every product is new; re-run once the query works');
    }
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
      const attrs = attributesFor(p).length;
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
          // It already existed — this is an update, not a creation. Counting it
          // as created made a re-run report 14 new products every time.
          updated++;
          log.ok(`${p.name} (updated as DRAFT — publish refused: ${err.message.slice(0, 80)})`);
        } else {
          await purviewFetch('/datagovernance/catalog/dataProducts', { method: 'POST', body: draft });
          created++;
          log.ok(`${p.name} (created as DRAFT — publish refused: ${err.message.slice(0, 80)})`);
        }
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

/**
 * Managed attributes are an ARRAY of { name, value }, not a dictionary.
 *
 * Sending `{ cortexSensitivity: 'Official' }` is rejected with a 400 whose
 * message is pure .NET and says nothing useful:
 *
 *   Cannot deserialize the current JSON object ... into type
 *   'System.Collections.Generic.List`1[...ManagedAttribute]' because the type
 *   requires a JSON array
 *
 * Verified against the Data Products - Create reference for api-version
 * 2026-03-20-preview: `managedAttributes` is CatalogModelManagedAttribute[],
 * each element { name, value, isRequired? }.
 */
function attributesFor(p) {
  const attrs = [];
  const set = (name, v) => {
    if (v !== null && v !== undefined && v !== '') attrs.push({ name, value: String(v) });
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

async function apimFetch(
  pathname,
  { method = 'GET', body, query = {}, headers = {}, retryOn5xx = false } = {}
) {
  const base =
    `https://management.azure.com/subscriptions/${config.apim.subscriptionId}` +
    `/resourceGroups/${config.apim.resourceGroup}` +
    `/providers/Microsoft.ApiManagement/service/${config.apim.serviceName}`;
  const url = new URL(base + pathname);
  url.searchParams.set('api-version', config.apim.apiVersion);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

  for (let attempt = 0; ; attempt++) {
    const token = await getToken(ARM_SCOPE);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...headers
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        throw new Error(`${method} ${pathname} → no response within ${HTTP_TIMEOUT_MS}ms`);
      }
      throw err;
    }

    // A 500 here is usually a resource that is not finished being created
    // rather than a broken service, so it is worth one more look.
    const transient = res.status === 429 || res.status === 503 || (retryOn5xx && res.status >= 500);
    if (transient && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 2000 * (attempt + 1);
      log.warn(`${res.status} from ARM — waiting ${Math.round(waitMs / 1000)}s and retrying`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${pathname} → ${res.status} ${text.slice(0, 300)}`);
    }
    const payload = res.status === 204 ? null : await res.json().catch(() => null);
    // 201 means ARM created it, 200 means it replaced one that was there.
    // Returning the status is what lets the summary line tell the truth.
    return { status: res.status, body: payload, headers: res.headers };
  }
}

/**
 * APIM resource creation is ASYNCHRONOUS.
 *
 * A PUT that imports an OpenAPI document returns before the operations inside
 * it exist. The tool created in the next breath references one of those
 * operations by full ARM id, and if it is not there yet APIM answers 500 —
 * not the documented 400 for a missing operation, which is what made this look
 * like a service fault rather than a race. The first skill in the run happened
 * to be slow enough to get away with it; the other five did not.
 *
 * When ARM hands back a 201/202 with a tracking header, follow it.
 */
async function awaitAcceptedOperation(res) {
  const opUrl =
    res.headers?.get?.('azure-asyncoperation') || res.headers?.get?.('location') || null;
  if (!opUrl || (res.status !== 201 && res.status !== 202)) return;

  const deadline = Date.now() + ASYNC_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const token = await getToken(ARM_SCOPE);
    const poll = await fetch(opUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    if (poll.status === 200 || poll.status === 204) {
      const body = await poll.json().catch(() => null);
      const state = body?.status || body?.properties?.provisioningState;
      if (!state || /succeeded/i.test(state)) return;
      if (/failed|canceled|cancelled/i.test(state)) {
        throw new Error(`async operation ${state}: ${JSON.stringify(body).slice(0, 200)}`);
      }
    }
    await sleep(1500);
  }
  throw new Error(`async operation did not finish within ${ASYNC_TIMEOUT_MS}ms`);
}

/**
 * Confirm the backing operation is really there before a tool points at it.
 *
 * Belt and braces alongside the async poll above: the tracking header is not
 * always present, and this is the specific precondition that was being
 * violated.
 */
async function waitForOperation(apiId, operationId) {
  const deadline = Date.now() + ASYNC_TIMEOUT_MS;
  let lastError = 'not found';
  while (Date.now() < deadline) {
    try {
      await apimFetch(`/apis/${apiId}/operations/${operationId}`);
      return true;
    } catch (err) {
      lastError = err.message;
      await sleep(1500);
    }
  }
  throw new Error(`operation ${apiId}/${operationId} never appeared — ${lastError.slice(0, 160)}`);
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
      const api = await apimFetch(`/apis/${s.id}`, {
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
      // The import is async. Everything below depends on it having finished.
      await awaitAcceptedOperation(api);

      // Then project it as an MCP server so an agent can call it.
      const mcp = await apimFetch(`/apis/${s.id}-mcp`, {
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
      await awaitAcceptedOperation(mcp);

      // The tool references this operation by full ARM id. Do not create it
      // until the operation the OpenAPI import was supposed to produce is
      // actually queryable.
      await waitForOperation(s.id, 'invoke');

      await apimFetch(`/apis/${s.id}-mcp/tools/invoke`, {
        method: 'PUT',
        headers: { 'If-Match': '*' },
        retryOn5xx: true,
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

      // Association with the product is not fatal — but swallowing the reason
      // meant a skill that never appeared for subscribers gave no clue why.
      await apimFetch(`/products/${config.apim.productId}/apis/${s.id}-mcp`, {
        method: 'PUT',
        headers: { 'Content-Length': '0' }
      }).catch((err) => {
        log.warn(`${s.name} — not added to product "${config.apim.productId}": ${err.message.slice(0, 120)}`);
      });

      if (api.status === 201) {
        created++;
        log.ok(`${s.name} (API + MCP server created)`);
      } else {
        updated++;
        log.ok(`${s.name} (API + MCP server updated)`);
      }
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
    servers: [{ url: `${baseUrl}/shim/skills/${s.id}` }],
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

  // An unrecognised --only used to run nothing at all and exit 0, which reads
  // exactly like a successful no-op run.
  if (ONLY && !['purview', 'apim'].includes(ONLY)) {
    console.error(`\nUnknown --only=${ONLY}. Valid values: purview, apim.`);
    process.exitCode = 1;
    return;
  }

  if (!DRY_RUN) await hydrateConfig();

  const missing = DRY_RUN ? [] : missingRequired();
  if (missing.length && !DRY_RUN) {
    console.error('\nMissing required configuration:');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('\nOnboard these to Key Vault, or set them as environment variables.');
    console.error('On Windows the quickest route is:  . .\\scripts\\Set-CortexEnv.ps1');
    console.error('See docs/DEPLOY.md.');
    process.exitCode = 1;
    return;
  }

  console.log(`  purview : ${config.purview.endpoint}`);
  console.log(`  apim    : ${config.apim.serviceName || '(not set)'}`);

  const dir = path.isAbsolute(config.bootstrapDir)
    ? config.bootstrapDir
    : path.resolve(REPO_ROOT, config.bootstrapDir);

  const read = async (f) => {
    const file = path.join(dir, f);
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`Content file not found: ${file}`);
      if (err instanceof SyntaxError) throw new Error(`${file} is not valid JSON: ${err.message}`);
      throw err;
    }
  };

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
    } else if (!DRY_RUN && !config.publicBaseUrl) {
      // The generated OpenAPI carries this as its server URL. Defaulting it to
      // localhost published APIs that could never be called, and said nothing.
      log.step('API Management');
      log.fail('PUBLIC_BASE_URL not set — skills would be published pointing at an unreachable address');
      failed++;
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

  // process.exit() truncates stdout when it is a pipe — which it always is
  // under `npm run`, on Windows especially. Set the code and let Node drain.
  process.exitCode = failed ? 1 : 0;
}

/**
 * Only run when invoked as a script. Importing this file used to execute the
 * whole bootstrap as a side effect, which is why none of the logic above was
 * ever covered by a test — including the idempotency rules, where a mistake
 * silently duplicates content in a real catalogue.
 */
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('\nBootstrap failed:', err.message);
    process.exitCode = 1;
  });
}

export {
  main,
  purviewFetch,
  apimFetch,
  listAllDomains,
  listAllDataProducts,
  bootstrapDomains,
  bootstrapDataProducts,
  bootstrapSkills,
  skillSpec,
  mapFrequency,
  attributesFor,
  guidFor,
  awaitAcceptedOperation,
  waitForOperation
};

/** Counters, for tests. Not part of the script's behaviour. */
export const __counters = {
  get created() {
    return created;
  },
  get updated() {
    return updated;
  },
  get failed() {
    return failed;
  },
  reset() {
    created = 0;
    updated = 0;
    failed = 0;
  }
};
