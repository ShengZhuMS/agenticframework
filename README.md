# Cortex

A front door to Microsoft Purview, Azure API Management and Microsoft Foundry, built for Defra.

**Status: Phase 1 and Phase 2 complete.** WP0–WP17, less the parts explicitly deferred.

Every section in the navigation now does something real, except Requests — which is a deliberate, clearly-labelled walkthrough of what the next phase buys, and Automate, which is out of scope by the backlog's own rules.

---

## Run it

```bash
node src/bff/server.js
```

Then open http://localhost:3000

There is no install step. Cortex runs on Node built-ins alone — no npm dependencies at runtime. That keeps the container image tiny and cold start near-instant, which matters because cold start is the top demo risk.

```bash
npm test        # 100 tests: visibility, register, assurance gates, build, publish and ask
```

---

## What works today

| | |
|---|---|
| **GOV.UK Defra shell** | Crown, masthead, alpha phase banner, six-section nav, skip link, footer, WCAG 2.2 AA focus states |
| **Persona switcher** | Four personas. The same page renders four different sets of visibility states. |
| **Marketplace** | 23 entries, 9 clusters. Search, category filter, cluster filter, visibility filter, sort. |
| **Visibility engine** | Six states, computed by a pure function, 18 unit tests |
| **Entry page** | Full entry standard — 17 fields, each showing its source and who maintains it. Limitations, followable lineage, licence and who it covers, use/cost/health, minimum aggregation, release record, askable panel |
| **Entry actions** | Request access, claim an unowned entry, report a correction, watch for change |
| **Quality flags** | Shown on cards and entries, and filterable |
| **Cortex Index** | Merged register over Purview, APIM and Foundry, fault-tolerant per source |
| **Adapters** | Seeded and live implementations for all four integrations |
| **Build an agent** | Model catalogue, instructions, knowledge checklist with unavailable items greyed out and explained, permitted actions |
| **Assurance gates** | Seven gates, computed from what the agent reads and does — change the selection and the table changes |
| **Test it** | Live answer with a provenance panel: sources, freshness, confidence, and what it could not reach |
| **Publish (Glue 2)** | Generates OpenAPI, imports it into APIM, creates an MCP server over it, adds tools, writes the endpoint back to the register |
| **Purview MCP server (Glue 1)** | `npm run mcp` — catalogue metadata as MCP tools, because Foundry has no Purview knowledge source |
| **Ask a question** | Answers with a provenance panel — sources, freshness, confidence, and what it could not reach, computed from the visibility engine |
| **Map** | The estate as nine clusters with cross-cluster dependencies, plus a full text alternative |
| **Share your data** | What your team shares, the gateway registration form, the access-request queue, and why there is no file picker |
| **Requests** | A five-screen walkthrough of the sick-days narrative, labelled as the investment ask |
| **Health endpoints** | `/api/health` and one per back end, with pre-warm at startup |

## The golden path

```
Marketplace -> entry -> Build -> attach only what you can see -> gates
           -> test it live -> publish as MCP -> back in the Marketplace
```

Every agent anyone builds becomes a part everyone else can build with. That is the whole argument.

## Try this first

Open `/marketplace`, then change the persona in the yellow bar. Seven of the 23 entries change state depending on who is looking. That is the governance story: access is *shown*, not asserted.

| Entry | Analyst | Owner | Builder | Consumer |
|---|---|---|---|---|
| Permit history lookup | Available | Available | Needs request | Needs request |
| Catchment summariser | Available | Needs request | Available | Needs request |
| Livestock movements | Sensitivity | Available | Sensitivity | Sensitivity |
| Address matching | Licence | Available | Licence | Licence |

---

## Layout

```
infra/            Bicep. `azd up` provisions everything.
src/bff/          Backend for frontend. All Azure credentials live here.
  adapters/       purview, apim, foundry, token — each seeded + live
  index/          the Cortex Index (merged register)
  services/       visibility engine
src/web/          GOV.UK templates and CSS
seed/             23 entries, 9 clusters, 4 personas
test/             visibility engine tests
```

## Configuration

Everything is off by default and switched on one integration at a time.

| Variable | Default | Notes |
|---|---|---|
| `DEMO_MODE` | `true` | Pins every adapter to seeded data. No external calls. |
| `ADAPTER_PURVIEW` | `seeded` | `live` uses the Unified Catalog API |
| `ADAPTER_APIM` | `seeded` | `live` lists MCP servers from APIM |
| `ADAPTER_FOUNDRY` | `seeded` | `live` creates and runs real agents |

## Two things this deliberately does not do

**The stylesheet is hand-written GOV.UK, not the npm package.** The class names are the real `govuk-*` names, so `npm install govuk-frontend` and swapping the import is mechanical. Done this way so the app has zero runtime dependencies.

**Purview governance roles cannot be assigned from Bicep.** They are data-plane roles assigned in the Purview portal, and tenant-level role groups do not accept service principals at all. See section 4 of the deployment guide — both the catalogue plane *and* the Data Map plane are required, and missing the second one is the most common way this setup fails.

---

## The two pieces of custom glue

Microsoft does not ship either of these, and Cortex is mostly the fact that they exist.

**Glue 1 — `src/purview-mcp/`.** There is no official Purview MCP server, and no Purview tool or knowledge source inside Foundry agents. Purview relates to Foundry only as governance *over* agents, never as a source *for* them. This exposes the catalogue as MCP tools so an agent can actually reach it. It serves catalogue metadata only — never the underlying data — which is what keeps the access-control story clean.

**Glue 2 — `src/bff/services/publish.js`.** There is no documented way to expose a Foundry agent as an MCP server; Foundry's own registration path produces HTTP or A2A in APIM instead. So Cortex generates an OpenAPI document for the agent, imports it into APIM as a REST API, creates an MCP server over it, and writes the endpoint back to the register. Only the ~100-line shim is bespoke; the rest is documented APIM management API.

## Going live

Each adapter switches independently, so you can prove one integration at a time.

```bash
DEMO_MODE=false ADAPTER_APIM=live ADAPTER_FOUNDRY=live ADAPTER_PURVIEW=live \
FOUNDRY_PROJECT_ENDPOINT=https://<res>.services.ai.azure.com/api/projects/cortex \
APIM_SERVICE_NAME=apim-cortex AZURE_SUBSCRIPTION_ID=... AZURE_RESOURCE_GROUP=... \
PUBLIC_BASE_URL=https://<your-app>.azurecontainerapps.io \
PURVIEW_MCP_URL=https://<mcp-app>.azurecontainerapps.io/mcp \
npm start
```

For Foundry to call an APIM MCP server it needs a project connection carrying the subscription key:

```bash
azd ai connection create cortex-apim --kind remote-tool \
  --target <mcp-url> --auth-type custom-keys \
  --custom-key "Ocp-Apim-Subscription-Key=<key>"
```

Then set `FOUNDRY_MCP_CONNECTION` to its id.

---

## Hardening

- **Pre-warm at startup.** Every back end is called once at boot, so nobody pays cold-start latency during a demo.
- **Per-source fault tolerance.** A back end that fails degrades that slice to seeded data and records the error. Verified: with Purview *and* APIM both throwing, all 23 entries still serve.
- **No raw errors.** Failures log in full and render as a GOV.UK error page. No stack traces, no internal paths.
- **Accessibility.** Every page: one `h1`, skip link, `lang`, `main` landmark, all form controls labelled, all six visibility states carry a shape *and* a text label. The map has a full table alternative. Zero `<script>` tags — the whole app works with JavaScript off.
- **Security headers** on every response, and every interpolation escaped.

## What is deliberately not built

| | |
|---|---|
| **Requests, working** | The strongest narrative and the most expensive thing in the backlog — it needs a request lifecycle, a method registry, versioned approvals, a recurrence engine and a release workflow. Shipped as a walkthrough instead. |
| **Automate** | Out of scope by the backlog's own rules: agents may read, summarise and cite this phase, never write. |
| **Reference data, standards conformance** | The backlog records that the owning roles *do not exist*. Building on a dependency the client has flagged as absent would be a mistake. |
| **Real cost and carbon** | Shown, clearly marked illustrative, exactly as the mockup does. Wiring Cost Management for a PoC buys nothing. |
