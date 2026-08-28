/**
 * GLUE 1 — the Cortex Purview MCP server.
 *
 * WHY THIS EXISTS
 * There is no official Microsoft Purview MCP server for data governance, and
 * no Purview tool or knowledge source inside Foundry agents. Purview relates
 * to Foundry only as governance OVER agents (DSPM, DLP, audit) — never as a
 * source FOR them. So a Foundry agent cannot look up a data product, read its
 * lineage, or check who owns it.
 *
 * This server closes that gap. It exposes the Purview Unified Catalog and
 * Data Map as MCP tools, is published through APIM as a passthrough MCP
 * server, and is then attached to agents as an ordinary MCP tool.
 *
 * SCOPE DISCIPLINE — read this before extending it.
 * This server exposes CATALOGUE METADATA, not the underlying data. It answers
 * "what exists, who owns it, what does it mean, where did it come from" —
 * never "give me the rows". That keeps the access-control story clean: an
 * agent using this learns about data it cannot read, which is exactly what
 * the marketplace already shows on screen. Adding a read_rows tool would
 * break the model and should be refused.
 *
 * Transport: Streamable HTTP at /mcp, per MCP 2025-06-18.
 */

import http from 'node:http';
import { hydrateConfig } from '../bff/config.js';
import { createPurviewAdapter } from '../bff/adapters/purview.js';

const PORT = Number(process.env.PORT || 3000);

// This runs as its own container app, so it reads Key Vault itself rather
// than inheriting anything from the web app.
await hydrateConfig();

const purview = createPurviewAdapter();

const PROTOCOL_VERSION = '2025-06-18';

/* ---------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: 'search_data_products',
    description:
      'Search the Defra data catalogue for registered data products by keyword, ' +
      'governance domain or owner. Returns catalogue metadata only — names, ' +
      'owners, descriptions, freshness and sensitivity — never the underlying data.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Free text to match against name and description.' },
        domain: { type: 'string', description: 'Governance domain, e.g. water, waste, farm.' },
        owner: { type: 'string', description: 'Owning team.' }
      }
    }
  },
  {
    name: 'get_data_product',
    description:
      'Read the full entry standard for one data product: owner, freshness, ' +
      'sensitivity, licence and who it covers, known limitations, and the minimum ' +
      'aggregation enforced on any answer derived from it.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'The data product id.' } }
    }
  },
  {
    name: 'get_lineage',
    description:
      'Read what a data product is built from and what depends on it. Use this to ' +
      'explain where a figure came from, or to find an authoritative source.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } }
    }
  },
  {
    name: 'get_schema',
    description:
      'Read the fields of a data product and their classifications, so a question ' +
      'can be answered about what is recorded without reading any records.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } }
    }
  }
];

/* ------------------------------------------------------------ tool impls */

async function callTool(name, args = {}) {
  switch (name) {
    case 'search_data_products': {
      const all = await purview.listDataProducts();
      const k = String(args.keyword || '').toLowerCase();
      const out = all.filter((e) => {
        if (args.domain && e.cluster !== args.domain) return false;
        if (args.owner && !String(e.owner || '').toLowerCase().includes(String(args.owner).toLowerCase()))
          return false;
        if (!k) return true;
        return `${e.name} ${e.desc}`.toLowerCase().includes(k);
      });
      return {
        count: out.length,
        dataProducts: out.map((e) => ({
          id: e.id,
          name: e.name,
          domain: e.cluster,
          owner: e.owner,
          description: e.desc,
          freshness: e.fresh,
          sensitivity: e.sens
        }))
      };
    }

    case 'get_data_product': {
      const all = await purview.listDataProducts();
      const e = all.find((x) => x.id === args.id);
      if (!e) return { error: `No data product with id ${args.id}` };
      return {
        id: e.id,
        name: e.name,
        domain: e.cluster,
        owner: e.owner,
        ownerConfirmed: e.ownerState === 'confirmed',
        description: e.desc,
        freshness: e.fresh,
        sensitivity: e.sens,
        licence: e.licence,
        accessRoute: e.access,
        knownLimitations: e.limits || null,
        minimumAggregation: e.minAgg || null,
        answerableByAPerson: e.askable || null,
        // Stated explicitly so an agent reasoning over this cannot mistake
        // catalogue access for data access.
        note: 'Catalogue metadata only. This tool never returns the underlying data.'
      };
    }

    case 'get_lineage': {
      const all = await purview.listDataProducts();
      const e = all.find((x) => x.id === args.id);
      if (!e) return { error: `No data product with id ${args.id}` };
      const dependents = all.filter((x) => (x.deps || []).includes(e.id) || (x.deps || []).includes(e.name));
      return {
        id: e.id,
        name: e.name,
        buildsOn: e.deps || [],
        dependedOnBy: dependents.map((d) => ({ id: d.id, name: d.name })),
        // Skills, agents and apps that consume this product live in API
        // Management, not the Purview catalogue, so they are not counted here.
        // An empty list means "nothing in the catalogue", never "nothing at all".
        note:
          'Dependents are counted within the data catalogue only. Skills, agents ' +
          'and applications that consume this product are registered in API ' +
          'Management and are not visible to this tool.'
      };
    }

    case 'get_schema': {
      const all = await purview.listDataProducts();
      const e = all.find((x) => x.id === args.id);
      if (!e) return { error: `No data product with id ${args.id}` };
      if (typeof purview.getAssets === 'function') {
        try {
          const assets = await purview.getAssets(e.id);
          if (assets?.length) {
            return {
              id: e.id,
              assets: assets.map((a) => ({
                name: a.name,
                fields: (a.schema || []).map((f) => ({
                  name: f.name,
                  type: f.type,
                  classifications: f.classifications || []
                }))
              }))
            };
          }
        } catch {
          /* fall through to the catalogue-only answer */
        }
      }
      return {
        id: e.id,
        name: e.name,
        location: e.location || null,
        note: 'No field-level schema is registered for this product in the catalogue.'
      };
    }

    default:
      return { error: `Unknown tool ${name}` };
  }
}

/* ------------------------------------------------------------ JSON-RPC */

async function handleRpc(msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cortex-purview', version: '0.1.0' }
      });

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return ok({ tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      if (!TOOLS.find((t) => t.name === name)) return err(-32602, `Unknown tool: ${name}`);
      try {
        const result = await callTool(name, args);
        return ok({
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: Boolean(result?.error)
        });
      } catch (e) {
        return err(-32603, e.message);
      }
    }

    case 'ping':
      return ok({});

    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

/* -------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    const h = await purview.health().catch((e) => ({ ok: false, error: e.message }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, tools: TOOLS.length, purview: h }));
  }

  if (req.url !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not found. The MCP endpoint is /mcp' }));
  }

  if (req.method === 'GET') {
    // Streamable HTTP allows a GET to open a stream. Nothing is pushed.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    return res.write(': cortex-purview\n\n');
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let msg;
  try {
    msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    );
  }

  const batch = Array.isArray(msg) ? msg : [msg];
  const results = [];
  for (const m of batch) {
    const r = await handleRpc(m);
    if (r) results.push(r);
  }

  if (!results.length) {
    res.writeHead(202);
    return res.end();
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(Array.isArray(msg) ? results : results[0]));
});

server.listen(PORT, () => {
  console.log(`Cortex Purview MCP server on http://localhost:${PORT}/mcp`);
  console.log(`  tools: ${TOOLS.map((t) => t.name).join(', ')}`);
  console.log('  catalogue metadata only — this server never returns underlying data');
});

export { TOOLS, callTool, handleRpc };
