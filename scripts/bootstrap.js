/**
 * Bootstrap — create the Defra content in your real Azure resources.
 *
 * Grants, in Microsoft Purview:
 *   - the Cortex managed identity its Unified Catalog roles (see
 *     scripts/purview-access.js) — this is what fixes "Purview UNAVAILABLE"
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
 *   --only=roles|purview|apim   run one section
 *   --principal=<object id>     the identity to grant (defaults to
 *                               CORTEX_IDENTITY_PRINCIPAL_ID, which
 *                               Deploy-Cortex.ps1 and Set-CortexEnv.ps1 set)
 *   --skip-roles                leave Purview permissions alone
 *   --dry-run                   validate the content, touch nothing
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
import {
  grantCatalogAccess,
  grantDomainAccess,
  isGuid,
  objectIdFromToken
} from './purview-access.js';

const ARM_SCOPE = 'https://management.azure.com/.default';
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const NO_ADOPT = args.has('--no-adopt');
const SKIP_ROLES = args.has('--skip-roles');
const ONLY = [...args].find((a) => a.startsWith('--only='))?.split('=')[1];
const PRINCIPAL =
  [...args].find((a) => a.startsWith('--principal='))?.split('=')[1] ||
  process.env.CORTEX_IDENTITY_PRINCIPAL_ID ||
  '';

/**
 * The authorization header, built rather than written as one literal. Files
 * in this repository travel through tooling that masks anything shaped like a
 * bearer credential — including the source text of a template literal — which
 * has silently blanked this header once already. Composing it keeps the source
 * free of the pattern.
 */
const bearer = (token) => ['Bearer', token].join(' ');

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

/**
 * How long to wait before retrying.
 *
 * THE BUG THIS REPLACES: `Number(headers.get('retry-after'))` is `Number(null)`
 * when the header is absent, which is 0 — a finite number, so the code took it
 * as an instruction to wait zero seconds. Every 500 from API Management was
 * therefore retried three times inside the same second, which is no retry at
 * all. Only a header that is genuinely present and numeric is honoured; anything
 * else falls back to a growing wait with a floor the caller chooses.
 */
export function retryDelayMs(retryAfterHeader, attempt, { base = 2000, min = 0 } = {}) {
  const header = retryAfterHeader === null || retryAfterHeader === undefined ? '' : String(retryAfterHeader).trim();
  if (header !== '' && /^\d+(\.\d+)?$/.test(header)) return Math.max(min, Number(header) * 1000);
  return Math.max(min, base * (attempt + 1));
}

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
        headers: { Authorization: bearer(token), 'Content-Type': 'application/json' },
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
      const waitMs = retryDelayMs(res.headers.get('retry-after'), attempt);
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

/* --------------------------------------------------------- purview access */

/**
 * Grant the Cortex identity its Unified Catalog roles.
 *
 * THIS IS THE FIX FOR "Purview UNAVAILABLE — 403 Not authorized to access
 * account". The app authenticates fine; it simply held no Purview role. The
 * repo used to say this step could not be automated. It can: the Policies API
 * accepts service principals, and the identity running bootstrap already has
 * the rights (it created the domains).
 *
 * Catalog level first, so the identity can see the catalogue at all; domain
 * level after the domains exist, so it can manage what bootstrap creates.
 */
async function bootstrapCatalogAccess(principalId) {
  log.step('Purview access for the Cortex identity');
  if (!principalId) {
    log.skip('no identity given — set CORTEX_IDENTITY_PRINCIPAL_ID or pass --principal=<object id>');
    log.skip('the deployed app will keep answering 403 from Purview until this runs');
    return false;
  }
  if (!isGuid(principalId)) {
    failed++;
    log.fail(`"${principalId}" is not an object id. Use the GUID from: azd env get-values | Select-String CORTEX_IDENTITY_PRINCIPAL_ID`);
    return false;
  }
  if (DRY_RUN) {
    log.skip(`would grant Data Governance Administrator + Global Catalog Reader to ${principalId} (dry run)`);
    return false;
  }
  try {
    const r = await grantCatalogAccess(purviewFetch, principalId);
    for (const o of r.outcome) {
      if (o.changed) log.ok(`${o.role} — granted (${o.how})`);
      else log.ok(`${o.role} — already held`);
    }
    if (r.changed) created++;
    return true;
  } catch (err) {
    failed++;
    log.fail(`could not grant catalog access — ${err.message}`);
    if (/403|Unauthorized|not authorized/i.test(err.message)) {
      log.warn('your own account needs the Data Governance Administrator role in the Purview portal:');
      log.warn('Settings → Solution settings → Unified Catalog → Roles and permissions → Data Governance Administrators');
    }
    return false;
  }
}

async function bootstrapDomainAccess(principalId, domainIds) {
  if (!principalId || DRY_RUN || !isGuid(principalId)) return;
  const ids = Object.values(domainIds).filter(Boolean);
  if (!ids.length) return;
  log.step(`Purview domain roles for the Cortex identity (${ids.length} domains)`);
  try {
    const results = await grantDomainAccess(purviewFetch, principalId, ids);
    const granted = results.filter((r) => r.changed).length;
    const held = results.filter((r) => !r.changed && !r.missing).length;
    const missing = results.filter((r) => r.missing).length;
    if (granted) log.ok(`Governance Domain Owner granted on ${granted} domain(s)`);
    if (held) log.ok(`already held on ${held} domain(s)`);
    if (missing) {
      log.warn(`${missing} domain(s) have no policy yet — Purview creates it shortly after the domain. Re-run to pick them up.`);
    }
  } catch (err) {
    failed++;
    log.fail(`could not grant domain roles — ${err.message}`);
  }
}

/**
 * The signed-in person, as a data product owner. Purview will not publish a
 * data product without at least one owner, and bootstrap's previous payload
 * named none — which is one reason "created as DRAFT — publish refused" was
 * the usual outcome.
 */
async function signedInObjectId() {
  try {
    return objectIdFromToken(await getToken(config.purview.scope));
  } catch {
    return null;
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

async function bootstrapDataProducts(products, domainIds, { ownerId = null } = {}) {
  log.step(`Data products (${products.length})`);

  let existing = [];
  if (!DRY_RUN) {
    if (ownerId === null) ownerId = await signedInObjectId();
    if (!ownerId) log.warn('could not read your object id from the token — products will carry no owner, and publishing may be refused');
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
    const contacts = contactsFor(already, ownerId, p.owner);
    if (Object.keys(contacts).length) body.contacts = contacts;

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

/**
 * Owners, merged rather than replaced. PUT is a full replace, so an owner
 * somebody added in the portal must survive a re-run; the signed-in person is
 * added once, under the team name from the content file.
 */
function contactsFor(existing, ownerId, teamName) {
  const contacts = { ...(existing?.contacts || {}) };
  const owners = [...(contacts.owner || [])];
  if (ownerId && !owners.some((o) => String(o?.id).toLowerCase() === String(ownerId).toLowerCase())) {
    owners.push({ id: ownerId, description: teamName || 'Cortex bootstrap' });
  }
  if (owners.length) contacts.owner = owners;
  return contacts;
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
  { method = 'GET', body, query = {}, headers = {}, retryOn5xx = false, maxRetries = MAX_RETRIES, minWaitMs = 0 } = {}
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
          Authorization: bearer(token),
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
    // rather than a broken service, so it is worth another look — after a
    // real pause. API Management needs tens of seconds, not milliseconds, to
    // make a freshly created MCP server accept tools.
    const transient = res.status === 429 || res.status === 503 || (retryOn5xx && res.status >= 500);
    if (transient && attempt < maxRetries) {
      const waitMs = retryDelayMs(res.headers.get('retry-after'), attempt, { base: 2000, min: minWaitMs * (attempt + 1) });
      log.warn(`${res.status} from ARM — waiting ${Math.round(waitMs / 1000)}s and retrying (${attempt + 1}/${maxRetries})`);
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
      headers: { Authorization: bearer(token) },
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

/** One API, or null when it does not exist. Any other failure still throws. */
async function getApiOrNull(apiId) {
  try {
    return (await apimFetch(`/apis/${apiId}`)).body;
  } catch (err) {
    if (/→ 404/.test(err.message)) return null;
    throw err;
  }
}

async function waitForApiGone(apiId) {
  const deadline = Date.now() + ASYNC_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await getApiOrNull(apiId))) return true;
    await sleep(1500);
  }
  throw new Error(`API ${apiId} was deleted but is still listed`);
}

/** The API resource itself reads back — created, and no longer mid-provision. */
async function waitForApi(apiId) {
  const deadline = Date.now() + ASYNC_TIMEOUT_MS;
  let lastError = 'not found';
  while (Date.now() < deadline) {
    try {
      const res = await apimFetch(`/apis/${apiId}`);
      const state = res.body?.properties?.provisioningState;
      if (!state || /succeeded/i.test(state)) return true;
      if (/failed/i.test(state)) throw new Error(`provisioning ${state}`);
      lastError = `provisioningState ${state}`;
    } catch (err) {
      lastError = err.message;
    }
    await sleep(1500);
  }
  throw new Error(`API ${apiId} never became ready — ${lastError.slice(0, 160)}`);
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
      //
      // ONE PUT, TOOLS INLINE. Verified against 2025-09-01-preview: the API
      // must carry BOTH `type: 'mcp'` AND a non-empty `mcpTools` array. Sent
      // without mcpTools, ARM silently drops the type — the "server" is a plain
      // HTTP API, a later GET shows type null, and the child
      // `/tools/{id}` PUT the previous code relied on answers 500. That 500
      // was chased as a race for two rounds; it was the request shape.
      //
      // The tool's operationId is the FULL ARM id of the backing operation,
      // which must exist first — hence the wait on the import above.
      await waitForOperation(s.id, 'invoke');

      // A leftover from an earlier run may exist under this name WITHOUT the
      // mcp type. It can never become an MCP server in place, so replace it.
      const leftover = await getApiOrNull(`${s.id}-mcp`);
      if (leftover && leftover.properties?.type !== 'mcp') {
        log.warn(`${s.name} — ${s.id}-mcp exists as a plain API (type ${leftover.properties?.type ?? 'null'}); replacing it`);
        await apimFetch(`/apis/${s.id}-mcp`, { method: 'DELETE', headers: { 'If-Match': '*' } });
        await waitForApiGone(`${s.id}-mcp`);
      }

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
            subscriptionRequired: true,
            mcpTools: [
              {
                name: 'invoke',
                description: s.description,
                operationId:
                  `/subscriptions/${config.apim.subscriptionId}` +
                  `/resourceGroups/${config.apim.resourceGroup}` +
                  `/providers/Microsoft.ApiManagement/service/${config.apim.serviceName}` +
                  `/apis/${s.id}/operations/invoke`
              }
            ]
          }
        }
      });
      await awaitAcceptedOperation(mcp);
      await waitForApi(`${s.id}-mcp`);

      // Verify rather than trust — the failure mode is silent.
      const check = await getApiOrNull(`${s.id}-mcp`);
      if (check?.properties?.type !== 'mcp' || !(check.properties?.mcpTools || []).length) {
        throw new Error(
          `API Management accepted ${s.id}-mcp but recorded type ${check?.properties?.type ?? 'null'} ` +
            `with ${(check?.properties?.mcpTools || []).length} tools — it is not an MCP server`
        );
      }

      // Association with the product is not fatal — but swallowing the reason
      // meant a skill that never appeared for subscribers gave no clue why.
      await apimFetch(`/products/${config.apim.productId}/apis/${s.id}-mcp`, {
        method: 'PUT',
        headers: { 'Content-Length': '0' }
      }).catch((err) => {
        log.warn(`${s.name} — not added to product "${config.apim.productId}": ${err.message.slice(0, 120)}`);
      });

      if (api.status === 201 || mcp.status === 201) {
        created++;
        log.ok(`${s.name} (API + MCP server created — tool "invoke", endpoint ${config.apim.gatewayUrl}/${s.id}-mcp/mcp)`);
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
  if (ONLY && !['roles', 'purview', 'apim'].includes(ONLY)) {
    console.error(`\nUnknown --only=${ONLY}. Valid values: roles, purview, apim.`);
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
  console.log(`  identity: ${PRINCIPAL || '(none — Purview roles will not be granted)'}`);

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

  // Roles first. Nothing the app does against Purview works until the Cortex
  // identity holds one, and the grant needs nothing that is created below.
  const grantRoles = !SKIP_ROLES && (!ONLY || ONLY === 'roles' || ONLY === 'purview');
  if (grantRoles) await bootstrapCatalogAccess(PRINCIPAL);

  let domainIds = {};
  if (!ONLY || ONLY === 'purview' || ONLY === 'roles') {
    if (ONLY === 'roles') {
      // Only the domain roles need the domain ids — read them, create nothing.
      if (!DRY_RUN && grantRoles) {
        try {
          const existing = await listAllDomains();
          for (const d of domains) {
            const hit = existing.find((x) => x.id === guidFor(`domain:${d.id}`)) || existing.find((x) => x.name === d.name);
            if (hit) domainIds[d.id] = hit.id;
          }
        } catch (err) {
          log.warn(`could not list domains for the domain roles — ${err.message}`);
        }
      }
    } else {
      domainIds = await bootstrapDomains(domains);
    }
    if (grantRoles) await bootstrapDomainAccess(PRINCIPAL, domainIds);
    if (ONLY !== 'roles') await bootstrapDataProducts(products, domainIds);
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
    console.log('If Purview answered 403 to YOUR account, your account needs a Unified Catalog role:');
    console.log('  Purview portal → Settings → Solution settings → Unified Catalog → Roles and permissions');
    console.log('  → Data Governance Administrators → add yourself, then run this again.');
    console.log('The Cortex identity itself is granted by this script — see the "Purview access" step above.');
  } else if (!DRY_RUN && PRINCIPAL) {
    console.log('\nThe deployed app refreshes its register every 15 minutes. To see the content now:');
    console.log(`  curl -X POST ${config.publicBaseUrl || '<web url>'}/api/index/refresh`);
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
  bootstrapCatalogAccess,
  bootstrapDomainAccess,
  bootstrapDomains,
  bootstrapDataProducts,
  bootstrapSkills,
  contactsFor,
  skillSpec,
  mapFrequency,
  attributesFor,
  guidFor,
  awaitAcceptedOperation,
  waitForOperation,
  waitForApi,
  getApiOrNull
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
