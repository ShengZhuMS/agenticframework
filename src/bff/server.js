/**
 * Cortex BFF — zero-dependency Node HTTP server.
 *
 * Runs on Node built-ins alone, so the container image is tiny and cold
 * start is near-instant. Cold start is the single most likely thing to
 * embarrass a live demo, so this is a deliberate architectural choice, not
 * a shortcut.
 *
 * All Azure credentials and management-plane calls live here. The browser
 * holds a session cookie and nothing else.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import index from './index/store.js';
import { decorate, visibilityFor } from './services/visibility.js';

import { marketplacePage } from '../web/views/marketplace.js';
import { entryPage, entryNotFoundPage } from '../web/views/entry.js';
import { startPage, placeholderPage, helpPage, errorPage } from '../web/views/pages.js';
import {
  buildLandingPage,
  buildFormPage,
  assuranceReferencePage
} from '../web/views/build.js';
import { agentPage, publishResultPage } from '../web/views/agent.js';
import { askPage } from '../web/views/ask.js';
import { mapPage } from '../web/views/map.js';
import { sharePage } from '../web/views/share.js';
import { requestsPage } from '../web/views/requests.js';
import { ask, threadsFor, getThread } from './services/ask.js';
import {
  knowledgeOptions,
  toolOptions,
  modelCatalogue,
  validateBuild,
  createAgent,
  resolveDefinition,
  gatesForDefinition,
  composeInstructions
} from './services/agents.js';
import { gatesFor } from './services/assurance.js';
import { publishAgent, openApiFor } from './services/publish.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.resolve(__dirname, '../web/assets');

/**
 * The last answer per agent, so a test result survives the redirect after
 * POST. Deliberately in memory and deliberately not a conversation store —
 * WP13 (Ask) owns real conversation history.
 */
const sessionAnswers = new Map();

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

/* ------------------------------------------------------------- utilities */

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...headers
  });
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2), {
    'Content-Type': 'application/json; charset=utf-8'
  });
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  const out = {};
  for (const [k, v] of params) {
    if (out[k] === undefined) out[k] = v;
    else if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = [out[k], v];
  }
  return out;
}

function multi(searchParams, key) {
  const all = searchParams.getAll(key);
  return all.length ? all : [];
}

/**
 * Resolve the effective user.
 *
 * With Entra sign-in the identity comes from the Container Apps auth headers.
 * The persona override then swaps the *effective* user for visibility
 * computation only — a demo device, always visibly flagged, never a
 * privilege escalation.
 */
function resolveUser(req, url) {
  const personaId = url.searchParams.get('persona');
  const fromPersona = personaId ? index.personaById(personaId) : null;
  if (fromPersona) return fromPersona;

  const principal = req.headers['x-ms-client-principal-name'];
  if (principal && !config.demoMode) {
    const matched = index.personas.find((p) => p.email === principal);
    if (matched) return matched;
    return {
      id: 'signed-in',
      name: principal,
      role: 'Signed in',
      team: 'Defra',
      groups: ['all-staff'],
      clearance: 'Official',
      licences: ['ogl'],
      cleared: false
    };
  }
  return index.personas[0];
}

function baseCtx(req, url) {
  const user = resolveUser(req, url);
  const query = {};
  for (const k of new Set([...url.searchParams.keys()])) {
    const vals = url.searchParams.getAll(k);
    query[k] = vals.length > 1 ? vals : vals[0];
  }
  const byName = new Map(index.all().map((e) => [e.name.toLowerCase(), e]));
  const personaId = url.searchParams.get('persona');
  return {
    user,
    personas: index.personas,
    clusters: index.clusters,
    showPersonaSwitcher: config.personaSwitcher,
    path: url.pathname,
    query,
    lastRefresh: index.lastRefresh
      ? new Date(index.lastRefresh).toLocaleString('en-GB', { timeZone: 'Europe/London' })
      : null,
    clusterName: (id) => index.clusterById(id)?.name || id,
    /**
     * Dependencies are recorded three ways: as an entry id, as an entry name,
     * or as an external system that is not in the register at all. Resolve
     * the first two to a link and leave the third as plain text — an
     * unresolvable dependency is honest information, not a broken link.
     */
    findByName: (n) => index.get(String(n)) || byName.get(String(n).toLowerCase()) || null,
    /**
     * Carry the persona across every internal link, so switching to another
     * pair of eyes survives navigation. Without this the switcher resets on
     * the first click and the demo falls apart.
     */
    personaQS: (sep = '?') => (personaId ? `${sep}persona=${encodeURIComponent(personaId)}` : '')
  };
}

/* ---------------------------------------------------------------- routes */

async function serveAsset(res, pathname) {
  const rel = pathname.replace(/^\/assets\//, '');
  if (rel.includes('..')) return send(res, 400, 'Bad request');
  const file = path.join(ASSET_DIR, rel);
  try {
    const data = await readFile(file);
    return send(res, 200, data, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': config.nodeEnv === 'production' ? 'public, max-age=3600' : 'no-cache'
    });
  } catch {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (pathname.startsWith('/assets/')) return serveAsset(res, pathname);

  /* ---- health, for the deployment guide's four checks ---- */
  if (pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      demoMode: config.demoMode,
      adapters: config.adapters,
      ...index.stats()
    });
  }
  if (pathname === '/api/health/purview') {
    return json(res, 200, await index.purview.health().catch((e) => ({ ok: false, error: e.message })));
  }
  if (pathname === '/api/health/apim') {
    return json(res, 200, await index.apim.health().catch((e) => ({ ok: false, error: e.message })));
  }
  if (pathname === '/api/health/foundry') {
    return json(res, 200, await index.foundry.health().catch((e) => ({ ok: false, error: e.message })));
  }

  /* ---- JSON API over the index ---- */
  if (pathname === '/api/entries') {
    const ctx = baseCtx(req, url);
    const found = index.search(
      {
        q: url.searchParams.get('q') || '',
        cats: multi(url.searchParams, 'cat'),
        clusters: multi(url.searchParams, 'cluster'),
        sort: url.searchParams.get('sort') || 'name'
      },
      ctx.user
    );
    return json(res, 200, decorate(found, ctx.user));
  }

  if (pathname === '/api/index/refresh' && req.method === 'POST') {
    return json(res, 200, await index.refresh());
  }

  /* ---- feedback (CAP-179) ---- */
  if (pathname === '/feedback' && req.method === 'POST') {
    const form = parseForm(await readBody(req));
    console.log(`[feedback] ${form.page} useful=${form.useful}`);
    return redirect(res, (form.page || '/') + '?thanks=1');
  }

  /* ---- entry actions: request, claim, correction, watch ---- */
  const actionMatch = pathname.match(/^\/entry\/([^/]+)\/(request|claim|correction|watch)$/);
  if (actionMatch && req.method === 'POST') {
    const ctx = baseCtx(req, url);
    const [, entryId, action] = actionMatch;
    const entry = index.get(entryId);
    if (!entry) return send(res, 404, entryNotFoundPage(ctx, { id: entryId }));
    const form = parseForm(await readBody(req));
    const persona = ctx.personaQS('&');

    // CAP-022 — request access to an entry
    if (action === 'request') {
      const record = index.addAccessRequest({
        entryId: entry.id,
        entryName: entry.name,
        requester: ctx.user.name,
        purpose: form.purpose || '',
        cadence: form.cadence || 'once',
        owner: entry.owner
      });
      return redirect(res, `/entry/${entry.id}?requested=${record.ref}${persona}`);
    }

    // CAP-047 — claim an entry whose owner was proposed and never confirmed
    if (action === 'claim') {
      index.upsert({ ...entry, owner: ctx.user.team, ownerState: 'confirmed' });
      return redirect(res, `/entry/${entry.id}?claimed=1${persona}`);
    }

    // CAP-048 — corrections go to the owner, not to Cortex
    if (action === 'correction') {
      console.log(`[correction] ${entry.id} by ${ctx.user.name}: ${form.correction || ''}`);
      return redirect(res, `/entry/${entry.id}?corrected=1${persona}`);
    }

    // CAP-020 — watch an entry for change
    if (action === 'watch') {
      return redirect(res, `/entry/${entry.id}?watching=1${persona}`);
    }
  }

  // A GET on /claim, so the link in the entry standard table works without JS.
  const claimGet = pathname.match(/^\/entry\/([^/]+)\/claim$/);
  if (claimGet && req.method === 'GET') {
    const ctx = baseCtx(req, url);
    const entry = index.get(claimGet[1]);
    if (!entry) return send(res, 404, entryNotFoundPage(ctx, { id: claimGet[1] }));
    index.upsert({ ...entry, owner: ctx.user.team, ownerState: 'confirmed' });
    return redirect(res, `/entry/${entry.id}?claimed=1${ctx.personaQS('&')}`);
  }

  /* ============================== the invocation shim — GLUE 2, step 1 ====
   * A published agent is reachable as a plain REST operation here. APIM
   * imports this shape as an API, then projects it as an MCP server. This
   * is the only bespoke code in the publish path.
   */
  const shimMatch = pathname.match(/^\/shim\/agents\/([^/]+)\/invoke$/);
  if (shimMatch && req.method === 'POST') {
    const entry = index.get(shimMatch[1]);
    if (!entry || entry.cat !== 'Agent') {
      return json(res, 404, { error: 'No such agent' });
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { error: 'Body must be JSON' });
    }
    if (!body.question) return json(res, 400, { error: 'question is required' });

    try {
      const answer = await index.foundry.respond({
        agentName: entry._source?.id || entry.id,
        input: body.question,
        conversationId: body.conversationId
      });
      index.upsert({ ...entry, calls: (entry.calls || 0) + 1 });
      return json(res, 200, {
        answer: answer.text,
        sources: answer.sources || [],
        couldNotReach: answer.couldNotReach || [],
        confidence: answer.confidence || null,
        conversationId: body.conversationId || null
      });
    } catch (err) {
      return json(res, 502, { error: 'The agent could not be reached', detail: err.message });
    }
  }

  /* The generated OpenAPI, served for inspection. */
  const specMatch = pathname.match(/^\/shim\/agents\/([^/]+)\/openapi\.json$/);
  if (specMatch) {
    const entry = index.get(specMatch[1]);
    if (!entry) return json(res, 404, { error: 'No such agent' });
    const base =
      config.publicBaseUrl || `http://${req.headers.host || 'localhost:' + config.port}`;
    return json(res, 200, openApiFor(entry, base));
  }

  /* ---- pages ---- */
  const ctx = baseCtx(req, url);

  /* ========================== WP11 and WP12 — test and publish an agent === */

  const agentMatch = pathname.match(/^\/agent\/([^/]+)$/);
  if (agentMatch) {
    const raw = index.get(agentMatch[1]);
    if (!raw || raw.cat !== 'Agent') return send(res, 404, entryNotFoundPage(ctx, { id: agentMatch[1] }));
    const [entry] = decorate([raw], ctx.user);
    const def = entry._agent?.definition || {};
    const { knowledge, tools } = resolveDefinition(def);
    const gates = entry._agent?.gates || (await gatesForDefinition(def));
    return send(
      res,
      200,
      agentPage(ctx, {
        entry: {
          ...entry,
          _agent: { ...entry._agent, composedInstructions: composeInstructions(def, knowledge) }
        },
        gates,
        knowledge,
        tools,
        answer: sessionAnswers.get(entry.id) || null,
        question: sessionAnswers.get(entry.id)?.question || '',
        published: url.searchParams.get('published')
      })
    );
  }

  const askMatch = pathname.match(/^\/agent\/([^/]+)\/ask$/);
  if (askMatch && req.method === 'POST') {
    const entry = index.get(askMatch[1]);
    if (!entry) return send(res, 404, entryNotFoundPage(ctx, { id: askMatch[1] }));
    const form = parseForm(await readBody(req));
    try {
      const answer = await index.foundry.respond({
        agentName: entry._source?.id || entry.id,
        input: form.question || ''
      });
      sessionAnswers.set(entry.id, { ...answer, question: form.question });
      index.upsert({ ...entry, calls: (entry.calls || 0) + 1 });
    } catch (err) {
      sessionAnswers.set(entry.id, {
        text: 'The agent could not be reached just now.',
        sources: [],
        couldNotReach: [err.message],
        question: form.question
      });
    }
    return redirect(res, `/agent/${entry.id}${ctx.personaQS()}`);
  }

  const publishMatch = pathname.match(/^\/agent\/([^/]+)\/publish$/);
  if (publishMatch && req.method === 'POST') {
    const entry = index.get(publishMatch[1]);
    if (!entry) return send(res, 404, entryNotFoundPage(ctx, { id: publishMatch[1] }));
    const form = parseForm(await readBody(req));
    const base =
      config.publicBaseUrl || `http://${req.headers.host || 'localhost:' + config.port}`;
    try {
      const result = await publishAgent(entry.id, {
        baseUrl: base,
        // Pass through undefined when the form omits it, so publishAgent can
        // fall back to the visibility already in force. Defaulting here would
        // silently re-label an all-staff agent as team-only on republish.
        visibility: form.visibility || undefined,
        user: ctx.user
      });
      return send(res, 200, publishResultPage(ctx, result));
    } catch (err) {
      console.error('[publish]', err);
      return send(
        res,
        502,
        errorPage(ctx, {
          code: 502,
          heading: 'Could not publish',
          message:
            'API Management did not accept the registration. Nothing was changed, and you can try again.'
        })
      );
    }
  }

  if (pathname === '/' || pathname === '/start') {
    return send(res, 200, startPage(ctx, { stats: index.stats(), coverage: index.coverage() }));
  }

  if (pathname === '/marketplace') {
    const filters = {
      q: url.searchParams.get('q') || '',
      cats: multi(url.searchParams, 'cat'),
      clusters: multi(url.searchParams, 'cluster'),
      visStates: multi(url.searchParams, 'vis'),
      flags: multi(url.searchParams, 'flag'),
      sort: url.searchParams.get('sort') || 'name'
    };
    const all = decorate(index.all(), ctx.user);
    let entries = all;

    if (filters.q) {
      const n = filters.q.toLowerCase();
      entries = entries.filter((e) =>
        [e.name, e.desc, e.owner, ctx.clusterName(e.cluster)]
          .filter(Boolean)
          .some((f) => String(f).toLowerCase().includes(n))
      );
    }
    if (filters.cats.length) entries = entries.filter((e) => filters.cats.includes(e.cat));
    if (filters.clusters.length) entries = entries.filter((e) => filters.clusters.includes(e.cluster));
    if (filters.visStates.length) entries = entries.filter((e) => filters.visStates.includes(e.vis));
    // CAP-027 — filter by quality flag
    if (filters.flags.length) {
      entries = entries.filter((e) => (e.flags || []).some((f) => filters.flags.includes(f)));
    }

    entries = sortEntries(entries, filters.sort);

    // CAP-030 — most used in each category, shown only on the unfiltered view
    const isFiltered =
      filters.q ||
      filters.cats.length ||
      filters.clusters.length ||
      filters.visStates.length ||
      filters.flags.length;
    const byCatMostUsed = {};
    for (const cat of ['Data', 'Skill', 'Agent', 'App']) {
      const top = all
        .filter((e) => e.cat === cat && Number(e.calls || 0) > 0)
        .sort((a, b) => Number(b.calls || 0) - Number(a.calls || 0))[0];
      if (top) byCatMostUsed[cat] = top;
    }

    return send(
      res,
      200,
      marketplacePage(ctx, {
        entries,
        filters,
        total: all.length,
        coverage: index.coverage(),
        cross: index.crossClusterLinks(),
        byCatMostUsed,
        showMostUsed: !isFiltered
      })
    );
  }

  const entryMatch = pathname.match(/^\/entry\/([^/]+)$/);
  if (entryMatch) {
    const raw = index.get(entryMatch[1]);
    // CAP-049 — be told when an entry does not exist, and what to do next
    if (!raw) return send(res, 404, entryNotFoundPage(ctx, { id: entryMatch[1] }));
    const [entry] = decorate([raw], ctx.user);
    return send(
      res,
      200,
      entryPage(ctx, {
        entry,
        cluster: index.clusterById(entry.cluster),
        requested: url.searchParams.get('requested')
      })
    );
  }

  /* ================================================== WP9 — build an agent */

  if (pathname === '/build') {
    const mine = index
      .all()
      .filter((e) => e.cat === 'Agent' && e._agent?.definition?.builtByTeam === ctx.user.team);
    const agentCount = index.all().filter((e) => e.cat === 'Agent').length;
    return send(res, 200, buildLandingPage(ctx, { agentCount, myAgents: mine }));
  }

  if (pathname === '/build/new') {
    const [models, knowledge, tools] = await Promise.all([
      modelCatalogue(),
      Promise.resolve(knowledgeOptions(ctx.user)),
      toolOptions(ctx.user)
    ]);
    // Pre-tick knowledge when arriving from an entry page.
    const pre = url.searchParams.get('knowledge');
    return send(
      res,
      200,
      buildFormPage(ctx, {
        models,
        knowledge,
        tools,
        form: pre ? { knowledge: [pre] } : {}
      })
    );
  }

  if (pathname === '/build/assurance') {
    const models = await modelCatalogue();
    const gates = gatesFor(
      { model: models[0].id, actions: ['read', 'summarise'] },
      [],
      models
    );
    return send(res, 200, assuranceReferencePage(ctx, { gates }));
  }

  if (pathname === '/build/create' && req.method === 'POST') {
    const form = parseForm(await readBody(req));
    const result = await validateBuild(form, ctx.user);

    if (!result.ok) {
      const [models, knowledge, tools] = await Promise.all([
        modelCatalogue(),
        Promise.resolve(knowledgeOptions(ctx.user)),
        toolOptions(ctx.user)
      ]);
      return send(
        res,
        400,
        buildFormPage(ctx, { models, knowledge, tools, form, errors: result.errors })
      );
    }

    const { entry } = await createAgent(result.definition, ctx.user);
    return redirect(res, `/agent/${entry.id}?created=1${ctx.personaQS('&')}`);
  }

  /* ==================================================== WP13 — ask =========*/

  if (pathname === '/ask' && req.method === 'POST') {
    const form = parseForm(await readBody(req));
    if (!String(form.q || '').trim()) {
      return redirect(res, `/ask${form.thread ? `?thread=${form.thread}` : ''}${ctx.personaQS(form.thread ? '&' : '?')}`);
    }
    const r = await ask(form.q, ctx.user, { threadId: form.thread });
    return redirect(res, `/ask?thread=${r.threadId}${ctx.personaQS('&')}`);
  }

  if (pathname === '/ask') {
    const history = threadsFor(ctx.user);
    const tid = url.searchParams.get('thread');
    const thread = tid ? getThread(tid, ctx.user) : null;

    // A question can arrive by GET, so the suggested prompts are plain links.
    const q = url.searchParams.get('q');
    if (q) {
      const r = await ask(q, ctx.user, { threadId: tid });
      return redirect(res, `/ask?thread=${r.threadId}${ctx.personaQS('&')}`);
    }
    return send(res, 200, askPage(ctx, { thread, history, threadId: thread?.id }));
  }

  /* ==================================================== WP14 — the map =====*/

  if (pathname === '/marketplace/map' || pathname === '/map') {
    const all = index.all();
    const counts = {};
    for (const e of all) counts[e.cluster] = (counts[e.cluster] || 0) + 1;
    const byCat = {};
    for (const e of all) byCat[e.cat] = (byCat[e.cat] || 0) + 1;
    const clusterIds = new Set(index.clusters.map((c) => c.id));
    return send(
      res,
      200,
      mapPage(ctx, {
        clusters: index.clusters,
        links: index.crossClusterLinks().links,
        cross: index.crossClusterLinks(),
        coverage: { ...index.coverage(), byCat },
        counts,
        unclustered: all.filter((e) => !clusterIds.has(e.cluster))
      })
    );
  }

  /* ================================================== WP16 — share =========*/

  if (pathname === '/share') {
    const all = index.all();
    const team = ctx.user.team;
    const mine = all.filter((e) => e.owner === team || (ctx.user.groups || []).includes(e.cluster));
    const proposed = all.filter((e) => e.ownerState === 'proposed');
    const myIds = new Set(mine.map((e) => e.id));
    const requests = index.accessRequests
      .filter((r) => r.status === 'Pending')
      .map((r) => ({
        ...r,
        waiting: waitingSince(r.raisedAt)
      }));
    return send(
      res,
      200,
      sharePage(ctx, {
        mine,
        proposed,
        requests,
        neverCalled: mine.filter((e) => !e.calls),
        submitted: url.searchParams.get('submitted')
      })
    );
  }

  if (pathname === '/share/connect' && req.method === 'POST') {
    const form = parseForm(await readBody(req));
    const ref = `GW-${String(index.accessRequests.length + 1).padStart(4, '0')}`;
    console.log(
      `[gateway] registration requested: ${form.system}/${form.object} by ${ctx.user.name}`
    );
    return redirect(res, `/share?submitted=${ref}${ctx.personaQS('&')}`);
  }

  const decisionMatch = pathname.match(/^\/share\/requests\/([^/]+)$/);
  if (decisionMatch && req.method === 'POST') {
    const form = parseForm(await readBody(req));
    const r = index.accessRequests.find((x) => x.ref === decisionMatch[1]);
    if (r) {
      r.status = form.decision === 'approve' ? 'Approved' : 'Declined';
      r.decidedBy = ctx.user.name;
      r.decidedAt = new Date().toISOString();
      // Approving grants the requester's groups access to the entry.
      if (r.status === 'Approved') {
        const entry = index.get(r.entryId);
        const requester = index.personas.find((p) => p.name === r.requester);
        if (entry && requester) {
          index.upsert({
            ...entry,
            allowedGroups: [...new Set([...(entry.allowedGroups || []), ...requester.groups])]
          });
        }
      }
    }
    return redirect(res, `/share${ctx.personaQS()}`);
  }

  /* ================================================ WP17 — requests ========*/

  if (pathname === '/requests') {
    return send(res, 200, requestsPage(ctx, { view: url.searchParams.get('view') || 'problem' }));
  }

  if (pathname === '/automate') {
    return send(
      res,
      200,
      placeholderPage(ctx, {
        heading: 'Automate a task',
        section: 'automate',
        wp: 'Phase 3',
        lede: 'Automations that draft, with a person at the checkpoint.',
        bullets: [
          'Every automation states what it writes in one sentence, who is accountable, what stops it and how it is undone.',
          'Everything starts in propose-only. Nothing writes until the accountable owner turns writing on.'
        ]
      })
    );
  }

  if (pathname === '/help' || pathname.startsWith('/help/')) {
    const health = {
      Purview: await index.purview.health().catch((e) => ({ ok: false, error: e.message })),
      'API Management': await index.apim.health().catch((e) => ({ ok: false, error: e.message })),
      Foundry: await index.foundry.health().catch((e) => ({ ok: false, error: e.message }))
    };
    return send(res, 200, helpPage(ctx, { stats: index.stats(), health }));
  }

  return send(res, 404, errorPage(ctx, notFound()));
}

function notFound() {
  return {
    code: 404,
    heading: 'Page not found',
    message:
      'If you typed the address, check it is right. If you followed a link, it may be out of date.'
  };
}

/** How long an access request has been waiting, in plain words. */
function waitingSince(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days} day${days > 1 ? 's' : ''}`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `${hours} hour${hours > 1 ? 's' : ''}`;
  return 'Just now';
}

/**
 * CAP-028 — sort by any column. Numeric fields sort numerically, everything
 * else alphabetically, and the visibility state sorts by how usable it is
 * rather than by the alphabet, which would be meaningless.
 */
function sortEntries(entries, sort) {
  const dir = sort.startsWith('-') ? -1 : 1;
  const key = sort.replace(/^-/, '');
  const visRank = { available: 0, request: 1, person: 2, licence: 3, notcleared: 4, sensitivity: 5 };
  return [...entries].sort((a, b) => {
    if (key === 'vis') return ((visRank[a.vis] ?? 9) - (visRank[b.vis] ?? 9)) * dir;
    const av = a[key] ?? '';
    const bv = b[key] ?? '';
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    if (key === 'calls') return (Number(av || 0) - Number(bv || 0)) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

/* ----------------------------------------------------------------- start */

export async function start() {
  await index.init();

  const server = http.createServer((req, res) => {
    const started = Date.now();
    handle(req, res)
      .catch((err) => {
        // Log the detail; never show it. A stack trace on screen in front of a
        // CTO is worse than the failure it describes.
        console.error('[error]', req.method, req.url, err);
        if (!res.headersSent) {
          try {
            const url2 = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            send(
              res,
              500,
              errorPage(baseCtx(req, url2), {
                code: 500,
                heading: 'Sorry, there is a problem with the service',
                message: 'Try again in a moment. If it keeps happening, tell the Cortex team.'
              })
            );
          } catch {
            send(res, 500, 'Sorry, there is a problem with the service. Try again later.', {
              'Content-Type': 'text/plain'
            });
          }
        }
      })
      .finally(() => {
        if (!req.url.startsWith('/assets/')) {
          console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
        }
      });
  });

  server.listen(config.port, async () => {
    const s = index.stats();
    console.log(`Cortex listening on http://localhost:${config.port}`);
    console.log(
      `  demo mode: ${config.demoMode} · adapters: ${JSON.stringify(config.adapters)}`
    );
    console.log(`  register: ${s.entries} entries across ${s.clusters} clusters`);
    await prewarm();
  });

  return server;
}

/**
 * Pre-warm every back end at startup.
 *
 * Cold-start latency on the first live Foundry call is the single most likely
 * thing to embarrass a demo — a twenty-second pause on the first question
 * asked in front of an audience. Paying that cost at boot, before anyone is
 * watching, removes it. Failures here are logged and ignored: a back end that
 * is down must not stop the app serving seeded data.
 */
async function prewarm() {
  if (config.demoMode) {
    console.log('  pre-warm: skipped, demo mode uses no external calls');
    return;
  }
  const checks = [
    ['purview', () => index.purview.health()],
    ['apim', () => index.apim.health()],
    ['foundry', () => index.foundry.health()]
  ];
  for (const [name, fn] of checks) {
    const t = Date.now();
    try {
      await fn();
      console.log(`  pre-warm ${name}: ready in ${Date.now() - t}ms`);
    } catch (err) {
      console.warn(`  pre-warm ${name}: unavailable — serving seeded data (${err.message})`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
