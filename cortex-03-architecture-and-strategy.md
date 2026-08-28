# Cortex — Architecture and Development Strategy

**A build guide for the agent that will develop this proof of concept.**

| | |
|---|---|
| **Product** | Cortex — a single front door to Microsoft Purview, Azure API Management and Microsoft Foundry |
| **Client** | Department for Environment, Food & Rural Affairs (Defra) |
| **Purpose of the PoC** | Sell the Microsoft AI landing zone and Purview to senior management by making the value visible and live, not described in a deck |
| **Audience for the demo** | CTO and directors. Not a user acceptance test. |
| **Status** | **Version 2.0 — live build.** No demo mode, no seeded data, no personas. Every screen reads Purview, API Management and Foundry through their real APIs. |
| **Sources** | `Cortex_architecture_DDD.pptx`, `Copy of cortex-capability-backlog.xlsx` (190 capabilities / 359 rows), `cortex-mockup 1.html` (2,940 lines) |

---

## 0. How to use this document

This document is written for an **AI coding agent** to build from, and for a human to review. Every section is intended to be actionable without needing the original three source documents open.

- **Sections 1–3** establish what we are building and, more importantly, what we are deliberately *not* building.
- **Sections 4–6** are the architecture. Build exactly this.
- **Section 7** is the work breakdown. Each work package is sized to be a single agent session with a clear definition of done.
- **Section 8** is an API cheat sheet with verified endpoint shapes, resource types and role names. **Do not guess API shapes — they have changed recently and the changes are material.**

**The single most important instruction:** this PoC is judged on whether a CTO leans forward, not on completeness. When a decision is between "more features" and "the demo runs flawlessly", choose the demo running flawlessly. There are 190 capabilities in the backlog. We are building 33 of them.

---

## 1. What Cortex is

### 1.1 The problem, in Defra's own words

The architecture deck states the as-is position plainly: **Purview, API Management and Foundry are all live in the GIO landing zone**. The plumbing is in. Two things are missing, and neither is a new platform:

1. **No front door.** Copilot and Teams agents are turned off for anyone outside the Cloud Centre of Excellence. There is nothing for the rest of the organisation to use.
2. **No MCP servers.** Foundry cannot talk to the platform agents. There are API connections only. Four platforms — Databricks Genie, ServiceNow, AWS Bedrock, Azure AI — each with its own AI and its own data, "each answering only for itself".

The consequence is described in the deck's worked example: **seven handoffs to produce one number**. A manager wants average days sick per employee. They are entitled to the answer. They are not entitled to the individual sickness records behind it. Their AI inherits their access rights, so it cannot reach the records either. The request goes out by email, a responder digs, replies by email, someone pastes it into a spreadsheet, the spreadsheet feeds Power BI. The deck calls this a "veneer of digitisation" with a high cost to change and many failure modes.

### 1.2 What Cortex changes

Cortex is the browser front door: **Marketplace, Ask, Automate, Build, Share data**. Nothing is replaced and nothing moves. Data stays where it is. The controls do not move — only the drafting does.

### 1.3 Why this architecture matters more than it looks

Here is the finding that shapes this entire build, and it is worth stating to the client explicitly.

We verified the current state of every integration Cortex depends on. Of the three links Cortex needs:

| Link | Status | Consequence |
|---|---|---|
| **APIM MCP server → consumed as a tool by a Foundry agent** | ✅ Fully supported, GA on both sides | Wire it up. No glue. |
| **Foundry agent → published as an MCP server in APIM** | ⚠️ No first-party path. Foundry Control Plane can register an agent into APIM as **HTTP or A2A — not MCP**. | **Cortex is the glue.** |
| **Purview data product → surfaced as an agent knowledge source** | ❌ No documented path at all. Purview appears in Foundry only as sensitivity-label enforcement, never as a source. | **Cortex is the glue.** |

This maps *exactly* onto the two gaps the deck identifies — "give our data MCP servers" and "build the interface". That is not a coincidence, and it is the strongest thing you can say in the demo:

> Cortex is not a skin over three products. Cortex is the two missing pieces of connective tissue that Microsoft does not ship, built once, in the place where the user already is.

This reframes the PoC from "a nice UI" to "the component that makes the landing zone investment usable". That is a materially better pitch to a CTO, and it is defensible because it is true.

---

## 2. The demo that must land

Everything in Phase 1 exists to serve one twelve-minute narrative. Build backwards from this.

### 2.1 The golden path

> **Sarah is a data analyst in the Waste Crime observatory. She needs an assistant that can answer questions about waste carrier registrations against permit history — work that currently takes her team days of manual cross-referencing.**

| # | Screen | What the audience sees | What is actually happening |
|---|---|---|---|
| 1 | **Marketplace** | She lands on what exists, not an empty search box. 19 entries across nine clusters — data, skills, agents, apps. She filters to Data, cluster "Waste and resources". | Live read from **Purview Unified Catalog** data products, merged with **APIM** MCP servers and APIs. |
| 2 | **Entry page** | She opens *Waste carrier registrations*. Full entry standard: owner, freshness, licence and who it covers, sensitivity, known limitations, lineage, cost per use, error rate, minimum aggregation. Every field shows where it came from and who maintains it. | Purview data product + assets + lineage, plus APIM analytics for the usage numbers. |
| 3 | **Visibility state** | The entry says **"Available"**. The next one she opens says **"Available to you, needs a request"** with a Request access button. A third says **"Sensitivity precludes you"** with no route. | The six-state model, computed from Purview classifications and the user's Entra groups. **This is the governance story — do not cut it.** |
| 4 | **Build an agent** | She clicks Build. A panel warns her ~2,500 agents already exist and invites her to search first. She names it, picks an approved model, writes instructions. | Foundry agent definition being assembled. |
| 5 | **Attach knowledge** | A checklist of knowledge sources. **Entries she cannot see are shown greyed out and disabled, with the reason.** She ticks two data products. | The killer governance moment. Access control is *visible*, not asserted. |
| 6 | **Attach tools** | A list of MCP servers from APIM — *Permit history lookup*, *Address and premises matching*. She ticks both. Four permitted actions: read and summarise are available and ticked; write to a source system and send externally are greyed out with "not this phase". | Live `GET /apis?$filter=type eq 'mcp'` against APIM. |
| 7 | **Assurance gates** | A table of seven gates with status and *why each applies*: DPIA not required (no personal data), gateway security review complete, responsible AI review in progress, model catalogue approval complete, red team not started, WCAG 2.2 AA not started, service assessment not applicable. | Rules engine over the agent definition. Cheap to build, disproportionately credible. |
| 8 | **Create and test** | She creates the agent and asks it a real question. It answers, **citing its sources with freshness**, and says what it could not reach. | Live Foundry agent creation and a live streamed response. **This must work on the day.** |
| 9 | **Publish** | She clicks *Publish as MCP*. Cortex generates a shim, registers it in APIM as an MCP server, and shows the endpoint URL. | The custom glue from §1.3. **This is the moment the story closes.** |
| 10 | **Loop closes** | She returns to the Marketplace. Her agent is now an entry — category Agent, visibility Available, with an MCP endpoint another developer can consume. She searches for it and sees it in the register. | The compounding asset. This is the "wow". |

### 2.2 The line to say at step 10

> "Every agent anyone builds becomes a part everyone else can build with. That is the difference between two thousand five hundred agents and a platform."

### 2.3 Demo safety rules — non-negotiable

> **Updated for the live build.** The original plan kept a seeded fallback. That is gone by design: everything is real, which is a genuine trade rather than a free improvement. What follows is what replaced it.


A live demo to a CTO that fails is worse than no demo. Therefore:

- **Per-source fault tolerance.** A back end that fails leaves its slice of the register as it was, records the error, and the page says what is missing. It does not substitute something that looks real.
- **No demo-mode fallback.** This is a deliberate trade, made explicitly: everything is real, so a back end that is down on the day is visible rather than papered over. Record a walkthrough as insurance.
- **Pre-warm on startup.** Cold-start latency on first Foundry call is the most likely failure. Warm it.
- **The publish step must be idempotent** and safe to run repeatedly — the demo will be rehearsed a dozen times. Publishing an agent that already exists updates rather than errors.
- **Never show a raw error.** Every failure degrades to a plain-English inline message in GOV.UK error-summary style.

---

## 3. Prioritisation — what is in and what is out

### 3.1 Method

The backlog has 190 unique capabilities across 359 capability×tool rows, 9 sections and 18 users. **Nothing was marked "In PoC = Yes"** in the source — 326 rows Undecided, 33 No. So this prioritisation is ours, and it is stated here so it can be challenged.

Each capability was scored on three axes:

- **Demo weight** — does the CTO see it in the twelve minutes?
- **Proof weight** — does it prove a claim that is otherwise just an assertion? (Governance, provenance, and the publish loop are worth far more than volume of features.)
- **Build cost** — with a bias against anything needing a new Azure service.

The backlog's own `Priority` column (101 Must / 37 Should / 12 Could / 209 blank) was used as an input, not as the answer. Several `Must` capabilities are deliberately **out** of the PoC because they serve the operational product, not the sales narrative.

### 3.2 In scope — Phase 1 (the demo)

**33 capabilities.** These are the build.

| Section | Capability IDs | What it buys us |
|---|---|---|
| **Marketplace** | CAP-010, CAP-015, CAP-022, CAP-023, CAP-024, CAP-025, CAP-026, CAP-039, CAP-040, CAP-041, CAP-042, CAP-043, CAP-044, CAP-046 | Land on what exists; the six visibility states; request access; search and filter; the full entry standard with per-field provenance; limitations; lineage; licence and who it covers; usage/cost/health; minimum aggregation |
| **Build an agent** | CAP-131, CAP-132, CAP-133, CAP-134, CAP-135, CAP-136, CAP-137 | Assemble from approved parts; approved model catalogue; instructions; "search before you build"; **attach only knowledge I can already see**; permitted actions with this-phase limits; the seven assurance gates |
| **Publish** | CAP-099, CAP-100, CAP-102 | Share an agent; declare what it reads and may do; publish a skill so it is callable from Ask, an agent or an automation |
| **Ask** | CAP-001, CAP-002, CAP-011 | Ask in my own words; follow up in thread; **see where an answer came from** |
| **Cross-cutting** | CAP-179 | Was this page useful — cheap, and signals a real service |
| **Marketplace (map)** | CAP-032, CAP-033, CAP-035, CAP-036, CAP-037 | The cluster map, cross-cluster dependency count, coverage against believed estate. **High visual impact per unit of effort.** |

### 3.3 In scope — Phase 2 (credibility, build if time allows)

| Section | Capability IDs | Note |
|---|---|---|
| **Share your data** | CAP-091, CAP-092, CAP-093, CAP-095, CAP-097 | Gateway registration rather than file upload, and the callout explaining *why there is no file picker* — this is a strong governance moment |
| **Ask** | CAP-003, CAP-012, CAP-014 | Question history, the working when nothing was found, jump from claim to entry |
| **Your data and agents** | CAP-165 | What I own, its usage, cost and health |

### 3.4 In scope — Phase 3 (the narrative layer, post-PoC)

**Requests** (CAP-052 → CAP-090, 39 capabilities) and **Automate** (CAP-143 → CAP-164). 

The Requests section carries the deck's strongest story — the average-days-sick example, seven handoffs collapsed to one, the responder's agent drafting before the responder opens the form. **It is the best narrative in the source material and the most expensive thing to build.** Recommendation: build a **static, clickable walkthrough** of the four Requests screens in Phase 1 as a "coming next" appendix to the demo, and build it properly only after investment is secured.

### 3.5 Explicitly out, and why

| Not building | Reason |
|---|---|
| The full 359-row backlog | It is a specification, not a plan. Building it all is a two-year programme. |
| Automations with write access | The backlog itself constrains agents to read/summarise/cite this phase. Writing to source systems is out of scope by the source's own rules. |
| Impact assessments, data-sharing agreements, standards conformance (CAP-117 → CAP-130) | Governance workflow. Essential to the product, invisible in a demo. |
| Reference data / canonical entities (CAP-111 → CAP-116) | The backlog names "Reference data owner" as a role that **does not exist**. Do not build on a dependency the client has flagged as absent. |
| Real cost and carbon figures | Show them, clearly marked illustrative, exactly as the mockup does. Do not wire up Cost Management for a PoC. |
| iPad / SwiftUI client | A third mockup exists. Out of scope. |
| Copilot and Teams agent enablement | A tenant configuration change, not application code. Mention it in the deck, do not build it. |

### 3.6 The tension in your instructions, resolved

You asked for all five sections **and** for a small PoC that starts simple. These pull against each other. The resolution above is: **all five sections are architected, Phase 1 builds two and a half of them.** The Marketplace, Build and Publish loop is complete and live; Ask is present with real provenance; Share and Requests are represented but thin. If the demo lands, Phases 2 and 3 are the investment ask.

---

## 4. Application architecture

### 4.1 Shape

A **thin single-page front end** over a **backend-for-frontend (BFF)**. All Azure credentials, tokens and management-plane calls live in the BFF. The browser never holds an Azure token and never calls Purview, APIM or Foundry directly.

```
┌──────────────────────────────────────────────────────────────────────┐
│  BROWSER                                                             │
│  GOV.UK Frontend SPA — Marketplace · Entry · Build · Ask · Share      │
│  Session cookie only. No Azure tokens. WCAG 2.2 AA.                   │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTPS, same origin, session cookie
┌───────────────────────────────▼──────────────────────────────────────┐
│  CORTEX BFF  (Azure Container Apps, managed identity)                │
│                                                                      │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────────┐   │
│  │ Catalogue  │ │  Agent     │ │  Publish   │ │  Access &        │   │
│  │ service    │ │  service   │ │  service   │ │  visibility      │   │
│  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └────────┬─────────┘   │
│        │              │              │                 │             │
│  ┌─────▼──────────────▼──────────────▼─────────────────▼─────────┐   │
│  │  INTEGRATION ADAPTERS  — one interface, two implementations    │   │
│  │  One implementation each. Live only — no seeded path.          │   │
│  └─────┬──────────────┬──────────────┬─────────────────┬─────────┘   │
│        │              │              │                 │             │
│  ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐   ┌───────▼────────┐    │
│  │ Purview   │  │   APIM    │  │  Foundry  │   │  Entra Graph   │    │
│  │ adapter   │  │  adapter  │  │  adapter  │   │   adapter      │    │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘   └───────┬────────┘    │
│        │              │              │                 │             │
│  ┌─────▼──────────────▼──────────────▼─────────────────▼─────────┐   │
│  │  CORTEX INDEX  — the merged register. Cosmos DB or Postgres.  │   │
│  │  Rebuilt on a timer, served from cache, never blocks a page.  │   │
│  └───────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
         │                    │                    │
   ┌─────▼──────┐      ┌──────▼──────┐      ┌──────▼──────┐
   │  Purview   │      │    APIM     │      │  Foundry    │
   │  Unified   │      │  MCP servers│      │  project    │
   │  Catalog + │      │  + REST APIs│      │  agents +   │
   │  Data Map  │      │  + products │      │  responses  │
   └────────────┘      └─────────────┘      └─────────────┘
```

### 4.2 The Cortex Index — the one idea that makes this work

Purview, APIM and Foundry have no shared identifier, no shared vocabulary and very different latency. **Do not query them live on page load.** The Marketplace must render in under a second and must render even when a back end is down.

Build a **merged register** — the Cortex Index — populated by a background refresh job and served to every read path.

- Refresh on a timer (default 15 minutes) and on demand via an admin endpoint.
- Every record keeps its **source system, source ID and last-synced timestamp**, because the entry standard requires each field to show where it came from and who maintains it (CAP-040). This is a UI requirement that forces a data-model decision — honour it.
- Writes (create agent, publish, request access) go **direct to the live system**, then optimistically upsert the index so the user sees their change immediately. This is what makes step 10 of the demo work instantly.

### 4.3 The canonical Entry model

Derived directly from the mockup's `E()` factory. Every marketplace item, regardless of source, is an Entry.

```jsonc
{
  "id": "waste-carrier-registrations",
  "name": "Waste carrier registrations",
  "cat": "Data",                    // Data | Skill | Agent | App
  "cluster": "waste",               // one of nine
  "desc": "…",
  "owner": "EA Waste Regulation",
  "ownerState": "confirmed",        // confirmed | proposed  (drives CAP-047 Claim)
  "fresh": "Daily",
  "sens": "Official",               // Official | Official–Sensitive
  "access": "Open to all staff",
  "vis": "available",               // the six-state model — see 4.4
  "licence": "Open Government Licence — covers all staff and contractors",
  "calls": 41200, "consumers": 186, "cpu": "£0.002",
  "err": "0.2%", "lat": "240ms", "rag": "g",
  "carbon": "~12 kgCO₂e per month, estimated",
  "limits": "Sampling is not uniform in space or time…",
  "deps": ["WIMS", "Catchment Data Explorer"],
  "location": "Point, OSGB36",
  "minAgg": null,                   // e.g. "Directorate" — CAP-046
  "askable": null,
  "flags": [],

  "_source": {                      // NEW — required by CAP-040
    "system": "purview",            // purview | apim | foundry | cortex
    "id": "<data product GUID>",
    "maintainedBy": "agent",        // agent | human
    "syncedAt": "2026-08-21T09:14:00Z"
  },
  "_endpoints": {                   // NEW — populated for Skill/Agent
    "mcp": "https://<apim>.azure-api.net/permit-history-mcp/mcp",
    "openapi": "https://…/openapi.json"
  }
}
```

### 4.4 Source-to-Entry mapping

| Entry field | Data (Purview) | Skill / API (APIM) | Agent (Foundry) |
|---|---|---|---|
| `id` | data product ID | API `name` | agent `name` |
| `name` | data product name | API `displayName` | agent `name` |
| `cat` | `Data` | `Skill` | `Agent` |
| `owner` | data product owner / domain | product or tag | creating team from Cortex metadata |
| `desc` | data product description | API description | agent description |
| `sens` | classification / sensitivity label | tag | inherited from attached knowledge |
| `deps` | Data Map lineage | backing API | attached knowledge + tools |
| `calls`, `err`, `lat` | — (illustrative) | APIM analytics | APIM analytics once published |
| `vis` | computed — §4.4 | computed from product subscription | computed |
| `_endpoints.mcp` | — | MCP server URL where `type='mcp'` | set at publish |

**A field with no live source is not shown at all.** Usage, error rate and latency come from the API Management Reports API. Cost per use, carbon and "believed estate" coverage had no source and were removed rather than labelled — a number nobody can defend is worse than an absent one, because it invites a question that cannot be answered.

### 4.5 The visibility state engine

Six states, from the mockup. This is the governance story — it must be computed, not hardcoded, or it will not survive a question from the floor.

| State | Label | Next action | Computed from |
|---|---|---|---|
| `available` | Available | Use it now | User's Entra groups include an allowed group, and sensitivity ≤ Official |
| `request` | Available to you, needs a request | Request access | Access policy exists and user is eligible but not a member |
| `licence` | Licence does not cover you | Commercial question | Licence is seat-limited and user not in covered population |
| `sensitivity` | Sensitivity precludes you | No route in your role | Sensitivity is Official–Sensitive and user lacks clearance |
| `notcleared` | Not yet registered for use | Connected, not cleared | Registered in Purview but no gateway clearance decision |
| `person` | Answerable by a person | Request an answer | `askable` set — the data cannot be released but a holder can answer |

**Implement as a pure function** `visibilityFor(entry, user) → state`, with unit tests. `user` comes from the Entra groups claim, so signing in as two different people renders the same page differently. That contrast is the most persuasive thing in the product — have a second account ready in a demo.

A second function, `canReachUnderlying(entry, user)`, answers a different question: does this person genuinely hold the data? It is deliberately not the same as `visibilityFor`, because `Answerable by a person` is returned for *everyone* — the data is never released to anyone. Deciding holdership from the visibility state would make every requester their own holder.

The `person` state matters more than it looks — it is the deck's "allowed the answer, not allowed the data" problem rendered as a UI state, and it is the hook into Phase 3 Requests.

### 4.6 The two pieces of custom glue

#### Glue 1 — Purview data product as agent knowledge

There is no first-party path. Build **a Purview MCP server**: a small service exposing the Unified Catalog and Data Map over MCP tools (`search_data_products`, `get_data_product`, `get_lineage`, `get_schema`). Publish it through APIM as a passthrough MCP server, then attach it to Foundry agents as a standard MCP tool.

This is genuinely valuable beyond the demo, and it is precisely what the deck asks for: *"give our data MCP servers… thin slice first: a small number of high-value sources, not the whole estate."*

> **Scope discipline:** the PoC Purview MCP server exposes **catalogue metadata**, not the underlying data. It answers "what exists, who owns it, what does it mean, where did it come from" — not "give me the rows". That keeps the access-control story clean, and it is exactly the thin slice the deck describes.

#### Glue 2 — publishing a Foundry agent as an MCP server in APIM

Foundry's own registration path produces an **HTTP or A2A** API in APIM, not MCP. So Cortex does it:

1. Cortex hosts a generic **agent invocation shim** — one route, `POST /shim/agents/{agentName}/invoke`, that calls the Foundry Responses API with `agent_reference`.
2. On publish, Cortex generates an **OpenAPI operation** for that agent and imports/updates it as an API in APIM.
3. Cortex then creates an **MCP server** in APIM over that API (`properties.type: 'mcp'`) and adds one **tool** per agent capability.
4. Cortex writes the resulting MCP endpoint back onto the Entry, and the agent appears in the Marketplace as a consumable part.

All four steps use documented, supported APIM management APIs. Only the shim is our code, and it is perhaps 100 lines.

### 4.7 Front end

**GOV.UK Frontend.** This is confirmed by the backlog itself: GOV.UK Frontend is the most-named underpinning technology across all 190 capabilities (14 mentions), ahead of Foundry Agent Service (13). It is the documented intent, not a preference.

- Use `govuk-frontend` (npm) — header, footer, phase banner, back link, error summary, tables, tabs, checkboxes, radios, summary lists, notification banner, task list.
- **Defra masthead** with the departmental crown and "Department for Environment, Food & Rural Affairs".
- **Phase banner: `ALPHA`**, with "This is a prototype. Data shown is illustrative." Honest and it inoculates against detail questions.
- Retain from the mockup, because they carry meaning the GOV.UK kit does not: the **six visibility marks** (filled / open / half / cross / dash / nest) as accessible shapes with text labels — never colour alone; the **large grey numerals** for section numbering; the **cluster map**.
- Crown green `#01A13B` used as GOV.UK green, sparingly.
- **WCAG 2.2 AA is a stated gate (CAP-137).** Every state must have a text label. Keyboard path through the entire golden path must work. This will be asked about in a government demo.

### 4.8 Authentication

**Microsoft Entra sign-in only. No personas, no anonymous browsing.**

- **Container Apps built-in authentication** terminates sign-in before the request reaches the process and injects the result as headers. No auth code in the app, no token validation, no secret.
- **Group membership is the entire governance model.** Clearance and licence entitlement are derived from groups, so they live in Entra where they can be governed, reviewed and revoked — not in this application's own store.
- **The groups claim is mandatory.** The app registration must emit it. Without it every user appears to be in no groups, almost every entry correctly resolves to "not available", and the Marketplace looks broken for reasons that are not obvious. `/profile` exists to diagnose exactly this.
- Entra emits group **object ids**; access rules read against names. `CORTEX_GROUP_NAMES` maps one to the other, and both forms match.
- An unauthenticated visitor is redirected to sign in. Where nothing is terminating sign-in in front of the app, a page says so rather than looping.

---

## 5. Infrastructure architecture

### 5.1 Target resources

| Resource | SKU / config | Why |
|---|---|---|
| **Azure Container Apps environment** | Consumption workload profile | Chosen deployment target. Scale to zero between rehearsals. |
| **Container App — `cortex-web`** | 0.5 vCPU / 1 GiB, min 1 replica | BFF + static front end. **Min 1 replica for the demo** — cold start is the top demo risk. |
| **Container App — `cortex-purview-mcp`** | 0.25 vCPU / 0.5 GiB | Glue 1. The Purview MCP server. |
| **Azure Container Registry** | Basic | Image hosting. |
| **Microsoft Foundry resource + project** | `Microsoft.CognitiveServices/accounts` + `/projects` | Agent service. Use the **new Foundry account+project model**, not hub-based. |
| **Model deployment** | `gpt-5-mini` or tenant-approved equivalent | Cheap, fast, good enough. The approved-model-catalogue screen can list more than is deployed. |
| **API Management** | **Standard v2** | MCP server management needs Developer/Basic/Standard/Premium or a v2 tier. **Consumption tier is not supported.** v2 also keeps the Foundry AI Gateway path open. |
| **Microsoft Purview account** | Standard | Unified Catalog + Data Map. |
| **Cosmos DB (serverless) or Postgres Flexible (B1ms)** | Serverless | The Cortex Index. Serverless keeps idle cost near zero. |
| **Log Analytics + Application Insights** | Pay-as-you-go | Required for the health/error-rate figures and for demo diagnostics. |
| **Managed identity (user-assigned)** | — | One identity, assigned across Foundry, APIM and Purview. |

**Provisioning time warning:** API Management takes **30–45 minutes** and Purview takes **10–15 minutes** to provision. Build this into the plan — do not discover it the day before. Provision these two first, in parallel with everything else.

### 5.2 Identity and RBAC

One user-assigned managed identity, `id-cortex`, used by both container apps.

| Scope | Role | Purpose |
|---|---|---|
| Foundry project | **Foundry User** | Create, test and run agents. ⚠️ **Not `Azure AI Developer`** — that role is scoped to ML workspaces and hubs and will not work. |
| Foundry project | **Foundry Project Manager** | Create project connections for MCP auth, and publish agents. |
| APIM instance | **API Management Service Contributor** | Create MCP servers, tools, policies and product bindings. |
| Purview | **Data Governance / catalogue reader roles** (see §8.3) | Read data products, domains, assets and lineage. |
| ACR | **AcrPull** | Image pull. |
| Cosmos / Postgres | Data contributor | The index. |

The **Foundry project's own managed identity** is a second, distinct identity — tools authenticate as the project, not as Cortex. Where an agent tool reaches a resource, that resource must be RBAC'd to the *project* identity.

### 5.3 Networking

**Public endpoints throughout for the PoC.** Private networking for Foundry MCP tools requires a dedicated MCP subnet delegated to `Microsoft.App/environments`, plus internal-ingress container apps. That is real work and buys nothing in a demo.

State this explicitly in the deployment guide as a **known PoC deviation**, with the private path named as the production route. A CTO will ask, and "we deliberately deferred it, here is the production design" is a much better answer than not having thought about it.

### 5.4 Secrets

No secrets in code, no secrets in the repo. Managed identity for Azure-to-Azure. The one unavoidable secret — the APIM subscription key used when Foundry calls an APIM MCP server — lives in a Container Apps secret and is referenced by a Foundry project connection.

---

## 6. Development strategy

### 6.1 Principles

1. **Demo-backwards.** Build §2.1 step 1, then step 2, then step 3. Do not build a feature that does not appear in the golden path until the golden path runs end to end.
2. **Live only.** There is one implementation of each integration and it calls the real API. There is no seeded adapter, no demo mode and no offline path. Tests stub at the HTTP boundary instead, so a response-shape change breaks a test rather than a demo.
3. **The Defra content is bootstrap input, not runtime data.** The mockup's entries are good, domain-credible content. They are pushed *into* Purview by `npm run bootstrap` and read back through the Unified Catalog API. Delete a data product in the Purview portal and it disappears from the Marketplace on the next refresh.
4. **Never break the golden path.** Any commit that breaks it is reverted, not fixed forward.
5. **No figure without a source.** A number Cortex cannot trace to a live API is not shown at all. Usage, error rate and latency come from API Management analytics. Cost per use, carbon and "believed estate" coverage had no source and have been removed rather than labelled.

### 6.2 Repository layout

```
cortex/
├─ azure.yaml                    # azd manifest
├─ infra/
│  ├─ main.bicep                 # subscription-scope entry point
│  ├─ main.parameters.json
│  └─ modules/
│     ├─ containerapps.bicep     ├─ foundry.bicep
│     ├─ apim.bicep              ├─ purview.bicep
│     ├─ cosmos.bicep            ├─ identity.bicep
│     └─ monitoring.bicep
├─ src/
│  ├─ web/                       # GOV.UK Frontend SPA
│  │  ├─ pages/                  # marketplace, entry, build, ask, share
│  │  ├─ components/             # visibility-mark, entry-card, cluster-map,
│  │  │                          #   provenance-panel, gate-table, identity-bar
│  │  └─ styles/                 # govuk-frontend + defra overrides
│  ├─ bff/
│  │  ├─ routes/                 # /api/entries /api/agents /api/publish /api/ask
│  │  ├─ services/               # catalogue, agent, publish, visibility
│  │  ├─ adapters/
│  │  │  ├─ purview.js      # Unified Catalog + Data Map
│  │  │  ├─ apim.js         # MCP servers, APIs, analytics
│  │  │  ├─ foundry.js      # agents, conversations, responses
│  │  │  ├─ keyvault.js     # endpoints and keys
│  │  │  └─ token.js        # managed identity
│  │  ├─ index/                  # Cortex Index build + refresh
│  │  └─ shim/                   # Glue 2 — agent invocation shim
│  └─ purview-mcp/               # Glue 1 — Purview MCP server
├─ seed/
│  ├─ entries.json               # the 19 entries, from the mockup
│  ├─ clusters.json              # nine clusters with owners
│  ├─ skills.json                # input to bootstrap, not runtime data
│  └─ load-purview.ts            # pushes entries into Purview as data products
├─ docs/                         # these documents
└─ scripts/                      # post-provision wiring
```

### 6.3 Seeding strategy — the part that is easy to get wrong

The demo needs Purview to contain believable Defra data products. The sandbox will be empty. So:

1. `seed/entries.json` holds the 19 entries from the mockup.
2. `seed/load-purview.ts` runs post-provision and, for each entry of category `Data`:
   - creates a **governance domain** per cluster if absent (nine domains: water, land, farm, animal, waste, marine, air, flood, corp);
   - creates the **data product** with `id` generated client-side, `name`, `description`, `businessUse`, `contacts.owner`, `updateFrequency`, `audience`, `termsOfUse`;
   - transitions `status` to `PUBLISHED`.
3. Skills are created in **APIM** as REST APIs and MCP servers by the same script.

> ⚠️ **Publishing is a status transition, not an operation** — there is no `publish` verb. You `PUT` the full object with `"status": "PUBLISHED"`. Two traps: `PUT` is a **full replace**, so read-modify-write; and the **casing differs between planes** — the entity uses `DRAFT`/`PUBLISHED`/`EXPIRED`, the query filter uses `Draft`/`Published`/`Expired`. Also, the portal enforces preconditions (assets attached, access policy configured, parent domain published) whose API-side behaviour is **not documented**. **Test this transition against the sandbox in week 1** — it is the single least-certain thing in this build.

### 6.4 The access-request decision — read this before building CAP-022

Purview has **no access-request API at all**. Not for submitting, not for approving, not for reading status, not for configuring policies. It is entirely portal-driven, and approvers must provision access to the underlying assets **manually**.

Cortex cannot therefore proxy Purview's request workflow. Purview provides an intended escape hatch — a **"Disable Access Management"** checkbox during data product curation, for exactly the case where an external solution owns access management.

**Decision: Cortex owns the access request workflow.** Set Disable Access Management on the data products, and implement request/approve/track in Cortex. This is the right call for three reasons: it is the only thing that works; it makes CAP-097 ("handle access requests in one place") real; and "one place to ask, whatever the underlying system" is a *better* pitch than "we forward you to the Purview portal".

Say this out loud in the demo. It is a genuine product insight, not a workaround.

### 6.5 Rate limits force the index — and validate it

The Unified Catalog API publishes per-operation limits per 20-second window: **List 100**, Query 800, Get 1,500, Update 150. A marketplace page that fans out to `list` per card would exhaust the List budget with a handful of concurrent users. The Cortex Index in §4.2 is not an optimisation — it is a requirement. Refresh writes to the index; reads never touch Purview.

### 6.6 Definition of done, per work package

- The golden-path step it serves runs end to end, live, twice in a row.
- When its back end is unavailable, that slice of the register is left as it was, the failure is recorded, and the page says what is missing rather than substituting anything.
- Keyboard-navigable, and every state carries a text label as well as a shape (WCAG 2.2 AA).
- No hardcoded figure without a visible "illustrative" marker.
- No secret in source.

---

## 7. Work packages

Each is one agent session. Order matters — this is the build sequence.

| # | Package | Depends on | Output |
|---|---|---|---|
| **WP0** | **Provision.** `azd` scaffold, Bicep for all resources, managed identity, RBAC. Start APIM and Purview first (30–45 min and 10–15 min respectively). | — | `azd up` succeeds |
| **WP1** | **Shell.** GOV.UK Frontend, Defra masthead, phase banner, six-section nav, identity bar, skip link, footer. | — | Every route renders with correct chrome |
| **WP2** | **Bootstrap + Index.** `bootstrap/*.json` as input to a script that writes real Purview domains and data products. Cortex Index and refresh job over the live APIs. | WP1 | Marketplace renders what is genuinely registered |
| **WP3** | **Marketplace.** List, search, category and cluster filters, the six visibility marks, sort, result count. | WP2 | Golden path steps 1 and 3 |
| **WP4** | **Visibility engine.** `visibilityFor(entry, user)` as a pure function with unit tests. Persona switcher recomputes live. | WP3 | Same page, four sets of eyes |
| **WP5** | **Entry page.** Full entry standard table with per-field provenance, limitations, lineage with followable links, licence, usage/cost/health boxes, minimum aggregation, request access. | WP4 | Golden path step 2 |
| **WP6** | **Purview live adapter.** Domains, data products, query, assets, lineage. `load-purview.ts`. **Verify the publish transition.** | WP2, WP0 | Marketplace serves live Purview data |
| **WP7** | **APIM live adapter.** List MCP servers (`$filter=type eq 'mcp'`), list APIs, read analytics. | WP2, WP0 | Skills and APIs appear live |
| **WP8** | **Purview MCP server (Glue 1).** Container app exposing `search_data_products`, `get_data_product`, `get_lineage`, `get_schema`. Registered in APIM as a passthrough MCP server. | WP6, WP7 | Purview reachable by an agent |
| **WP9** | **Build an agent.** Form, approved model list, instructions, knowledge checklist **with unavailable items greyed out and explained**, permitted actions, "search before you build" panel. | WP4, WP7 | Golden path steps 4–6 |
| **WP10** | **Assurance gates.** Seven-gate rules engine and table with reasons. | WP9 | Golden path step 7 |
| **WP11** | **Foundry live adapter.** Create agent, attach MCP tools, conversations, streamed responses. | WP0, WP8 | Golden path step 8 |
| **WP12** | **Publish (Glue 2).** Invocation shim, OpenAPI generation, APIM API import, MCP server + tools creation, write endpoint back to the index. Idempotent. | WP11 | Golden path steps 9–10 |
| **WP13** | **Ask.** Chat over published products with the provenance panel — sources, what was taken from each, confidence, and what could not be reached. | WP11 | Phase 1 complete |
| **WP14** | **Cluster map.** Nine clusters, dependency links, cross-cluster count, coverage screen. | WP3 | High visual impact |
| **WP15** | **Hardening.** Per-source fault tolerance, pre-warm, bounded timeouts, error states, accessibility pass, keyboard path. | all | Demo-safe |
| **WP16** | *(Phase 2)* Share your data — gateway registration, "why there is no file picker", access request queue. | WP12 | |
| **WP17** | *(Phase 2)* Requests walkthrough — four static screens for the sick-days narrative. | WP5 | The investment ask |

**Critical path to a demo: WP0 → WP1 → WP2 → WP3 → WP4 → WP5 → WP9 → WP11 → WP12.** Everything else is enhancement.

---

## 8. API cheat sheet

> Verified August 2026. **These surfaces have changed recently and in ways that break older samples.** Do not substitute remembered shapes.

### 8.1 Microsoft Foundry Agent Service

| | |
|---|---|
| Project endpoint | `https://<resource>.services.ai.azure.com/api/projects/<project>` |
| api-version | **`v1`** (literal string, not a date) |
| Token scope | `https://ai.azure.com/.default` |
| Create agent | `POST {ENDPOINT}/agents?api-version=v1` |
| Conversations | `POST {ENDPOINT}/openai/v1/conversations` |
| Responses | `POST {ENDPOINT}/openai/v1/responses` |
| SDK | Python `azure-ai-projects>=2.0.0` · JS `@azure/ai-projects` |

**Threads / messages / runs no longer apply** — the model is **agents + conversations + responses**, an OpenAI Responses API superset. Agents are identified by **name + version**, not a GUID.

Create agent body:
```json
{ "name": "waste-carrier-assistant",
  "definition": { "kind": "prompt", "model": "gpt-5-mini",
                  "instructions": "…", "tools": [ … ] } }
```

Run it:
```json
POST {ENDPOINT}/openai/v1/responses
{ "input": "…", "conversation": "conv_…",
  "agent_reference": { "name": "waste-carrier-assistant", "type": "agent_reference" } }
```

MCP tool definition (`type: "mcp"`, **GA**):
```json
{ "type": "mcp", "server_label": "permit-history",
  "server_url": "https://<apim>.azure-api.net/permit-history-mcp/mcp",
  "require_approval": "always",
  "allowed_tools": ["lookup_permit"],
  "project_connection_id": "<connection>" }
```

Streaming events to handle: `response.output_text.delta`, `response.output_item.done` (carries `url_citation` annotations — **use these for the provenance panel**), `response.completed`.

⚠️ **Roles were renamed.** Use **Foundry User** (build/test), **Foundry Project Manager** (connections, publish), **Foundry Agent Consumer** (invoke only, `eed3b665-ab3a-47b6-8f48-c9382fb1dad6`). **Do not use `Azure AI Developer`** — it targets ML workspaces and hubs, not Foundry projects, and will fail. Do not assign roles beginning `Cognitive Services`.

⚠️ Treat MCP tool descriptions and results as **untrusted input** — indirect prompt injection is the live risk, and it is one of the seven assurance gates.

### 8.2 Azure API Management — MCP

| | |
|---|---|
| Feature status | **GA** (Ignite, 25 Nov 2025) |
| Management api-version | **`2025-09-01-preview`** — pin it |
| Tiers | Developer, Basic, Standard, Premium, Basic v2, Standard v2, Premium v2. **Not Consumption.** |
| Endpoint shape | `https://<apim>.azure-api.net/<name>-mcp/mcp` — **read it from the resource, do not construct it** |
| Transport | Streamable HTTP |

MCP servers are **not a distinct resource type** — they are APIs with `properties.type = 'mcp'`:

| Resource type (all `@2025-09-01-preview`) | Purpose |
|---|---|
| `Microsoft.ApiManagement/service/apis` | the MCP server (`properties.type: 'mcp'`) |
| `Microsoft.ApiManagement/service/apis/tools` | one tool (`properties.operationId` = **full ARM resource ID**) |
| `Microsoft.ApiManagement/service/apis/policies` | policy at MCP scope |
| `Microsoft.ApiManagement/service/products/apis` | product binding |

```http
GET {BASE}/apis?api-version=2025-09-01-preview&$filter=type eq 'mcp'     # list MCP servers
PUT {BASE}/apis/{id}?api-version=2025-09-01-preview                      # create (If-Match: *)
PUT {BASE}/apis/{id}/tools/{toolId}?api-version=2025-09-01-preview       # add tool
```

Gotchas: creation is **async — poll `Azure-AsyncOperation`**; deletes require `If-Match: *` or return 412; delete tools before their backing operations; MCP servers are **not supported in APIM workspaces**; only tools are supported for REST-backed servers (no resources or prompts); **set frontend-response payload logging to 0 bytes** or App Insights breaks MCP streaming.

Security: `validate-azure-ad-token` for Entra JWTs, or `Ocp-Apim-Subscription-Key`. The `Authorization` header may need explicit forwarding via `set-header` in outbound policy. AI-gateway policies available: `llm-token-limit`, `llm-emit-token-metric`, `llm-semantic-cache-store` / `-lookup`.

### 8.3 Microsoft Purview

| | |
|---|---|
| **Unified Catalog endpoint** | **`https://api.purview-service.microsoft.com/`** — **not** `https://{account}.purview.azure.com/`, which is the legacy form |
| Path root | `/datagovernance/catalog/…` |
| api-version | **`2026-03-20-preview`** (no GA version exists) |
| Token scope | `https://purview.azure.net/.default` — **one token covers Data Map too** |
| Data Map | GA `2023-09-01`. Base URL + path prefix vary by portal generation — **make both runtime config and probe** |

```http
GET  {ep}/datagovernance/catalog/businessdomains?api-version=2026-03-20-preview   # lowercase
GET  {ep}/datagovernance/catalog/dataProducts?api-version=…                       # camelCase
POST {ep}/datagovernance/catalog/dataProducts/query?api-version=…                 # marketplace search
GET  {ep}/datagovernance/catalog/dataProducts/{id}/relationships?entityType=DATAASSET
POST {ep}/datagovernance/catalog/dataAssets/query?api-version=…                   # hydrate assets
```

`dataProducts/query` body accepts `nameKeyword`, `domainIds[]`, `owners[]`, `types[]`, `multiStatus[]`, `managedAttributes[]`, `orderby[]`, `skip`, `top` — that is the whole Marketplace search and filter surface in one call.

⚠️ **The API still says "business domain" where the product UI says "governance domain".** Same object.
⚠️ `listRelationships` returns only `entityId` — you must hydrate assets separately. Two round-trips per entry page. Cache them.
⚠️ **Status casing differs between planes:** filter with `{"multiStatus":["Published"]}`, read back `"status":"PUBLISHED"`.
⚠️ **`Policies` is not data-access policy** — it is the RBAC role-assignment plane (List and Update only).
🔴 **No access-request API of any kind.** See §6.4.

**Roles the Cortex service principal needs — in both planes:**

| Need | Role | Assigned where |
|---|---|---|
| Read data products | `Global Catalog Reader`, or per-domain `Local Catalog Reader` / `Governance Domain Reader` | Settings → Unified Catalog → Roles and permissions, or the domain Roles tab |
| Create / publish data products | **`Data Product Owner`** | Per governance domain, Roles tab |
| Search Data Map, read assets and lineage | **`Data reader`** | Data Map collection role assignments |

🔴 **Cross-plane dependency:** a product owner also needs Data Map read on the underlying assets, or those assets are invisible — including in search results.
🔴 **Tenant-level role groups do not accept service principals.** Design so Cortex never needs one; assign at governance-domain and collection level, both of which explicitly support SPNs.
⚠️ Microsoft recommends a **dedicated, newly created service principal** — reusing an existing one has a high documented failure rate.

### 8.4 What does not exist — do not go looking

- **No official Purview MCP server.** `microsoft/purview-dlm-mcp` is Exchange lifecycle diagnostics, unrelated. Azure MCP Server has no `purview` namespace. Hence Glue 1.
- **No Purview tool or knowledge source in Foundry agents.** Purview relates to Foundry only as governance *over* agents (DSPM, DLP, audit), never as a source *for* them.
- **No documented way to expose a Foundry agent as an MCP server.** Foundry's own registration path yields HTTP or A2A in APIM. Hence Glue 2.

---

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Purview publish transition behaves differently than inferred | **High** | High | Test in week 1 (WP6). Fall back to seeding products in `DRAFT` and filtering client-side. |
| APIM provisioning delay blocks integration work | High | Medium | Provision first, day one, in parallel. Seeded adapters unblock all UI work. |
| Service principal rejected at Purview catalog level | Medium | Medium | Assign per-governance-domain instead — SPNs are explicitly supported there. |
| Foundry API shape drifts again before the demo | Medium | High | Pin `api-version=v1` and the SDK major. Adapter isolates the blast radius. |
| Live demo network or back-end failure | Medium | **Critical** | Accepted deliberately: everything is real, so there is no fallback that hides it. Per-source fault tolerance keeps the app up and names what failed. **Record a walkthrough as insurance.** |
| Preview APIs change under us | Medium | Medium | Unified Catalog has no GA version. Accept it, isolate it in one adapter, and say so in the deck — it is a genuine platform-maturity point worth being honest about. |
| Scope creep from the 359-row backlog | **High** | High | §3.5 is the contract. Anything not in §3.2 is Phase 2 or later. |

---

## 10. What to say to the CTO

Three sentences, in this order:

1. **"The plumbing is already in — Purview, API Management and Foundry are live in your landing zone. What is missing is the front door and the connections between them."** (Their own deck's finding, repeated back.)
2. **"We built the two pieces Microsoft does not ship: your catalogue as something an agent can actually read, and a way to publish an agent back as a reusable part."** (The honest technical differentiator from §1.3.)
3. **"Every agent anyone builds becomes a part everyone else can build with — that is the difference between two and a half thousand agents and a platform."** (The compounding-asset argument, demonstrated live at step 10.)
