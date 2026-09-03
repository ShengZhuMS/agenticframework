# Cortex — Architecture and Strategy

**A front door to Microsoft Purview, Azure API Management and Microsoft Foundry, for Defra.**

---

## 1. Why this exists

Defra's own architecture review states the position: **Purview, API Management and Foundry are all live in the GIO landing zone.** The plumbing is in. Two things are missing, and neither is a new platform:

1. **No front door.** Copilot and Teams agents are off for anyone outside the Cloud Centre of Excellence.
2. **No MCP servers.** Foundry cannot reach the platform agents. Four platforms, each answering only for itself.

The cost is visible in one worked example: **seven handoffs to produce one number.** A manager wants average days sick per employee. They are entitled to the answer. They are not entitled to the records behind it. Their AI inherits their access, so it cannot reach the records either — and that means email, a spreadsheet, and a week.

## 2. The strategic argument

We verified the current state of every integration Cortex needs:

| Link | Status |
|---|---|
| APIM MCP server → consumed by a Foundry agent | ✅ Fully supported, GA both sides |
| Foundry agent → published as an MCP server in APIM | ⚠️ No first-party path. Foundry's own registration yields HTTP or A2A, not MCP |
| Purview data product → agent knowledge source | ❌ No documented path at all |

**Those two gaps map exactly onto the two gaps Defra identified.** That is the pitch, and it is defensible because it is true:

> Cortex is not a skin over three products. It is the two pieces of connective tissue Microsoft does not ship, built once, in the place the user already is.

Say three things to a CTO, in this order:

1. *"The plumbing is already in. What is missing is the front door and the connections between them."*
2. *"We built the two pieces Microsoft does not ship: your catalogue as something an agent can read, and a way to publish an agent back as a reusable part."*
3. *"Every agent anyone builds becomes a part everyone else can build with — that is the difference between two and a half thousand agents and a platform."*

---

## 3. The demo

Twelve minutes. Everything live.

| # | Screen | What is actually happening |
|---|---|---|
| 1 | **Marketplace** | Live read from Purview data products, merged with APIM MCP servers and Foundry agents |
| 2 | **Entry page** | Full entry standard, every field showing its source and who maintains it |
| 3 | **Visibility state** | Six states computed from Entra group membership. *This is the governance story — do not cut it* |
| 4-6 | **Build an agent** | Approved models; knowledge checklist with **unavailable items greyed out and explained**; permitted actions |
| 7 | **Assurance gates** | Seven gates, computed from what the agent reads and does, each stating why it applies |
| 8 | **Test it** | Live Foundry agent, answering with sources and freshness named |
| 8b | **Ask** | The `cortex-ask` Foundry agent answers from the catalogue entries the asker can reach; the provenance panel names what it could not |
| 9 | **Publish** | Glue 2 runs: OpenAPI → APIM API → MCP server → endpoint written back |
| 10 | **Loop closes** | The agent is now a Marketplace entry another agent can consume |

Sign in as a second person with different groups and walk the Marketplace again. The same page renders differently. That contrast is the most persuasive thing in the product.

---

## 4. Application architecture

A **server-rendered front end** over a **backend-for-frontend**. All Azure credentials and management-plane calls live in the BFF; the browser holds a session cookie and nothing else.

```
Browser ── GOV.UK pages, no client JavaScript
   │
Cortex BFF (Container Apps, managed identity)
   ├── services: visibility · identity · assurance · agents · publish · ask · requests
   ├── adapters: purview · apim · foundry · keyvault · token
   └── Cortex Index — the merged register
   │
   ├── Purview Unified Catalog + Data Map
   ├── API Management (MCP servers, APIs, analytics)
   └── Foundry (agents, conversations, responses)
```

### The Cortex Index

The three back ends share no identifier, no vocabulary and no latency profile, and the Unified Catalog List operation is capped at **100 calls per 20 seconds**. A page that fanned out per card would exhaust it with a handful of users.

So a background refresh builds a merged register and every read is served from it. Writes go direct to the live system and optimistically upsert the index, which is what makes publishing feel instant. Each source is independently fault-tolerant: one failing back end leaves its slice as it was and records the error, rather than emptying the register.

### The visibility engine

Six states, from the original mockup, computed by a pure function:

| State | Meaning |
|---|---|
| **Available** | Use it now |
| **Available to you, needs a request** | Eligible, ask the owner |
| **Licence does not cover you** | A commercial question, not a technical one |
| **Sensitivity precludes you** | No route in your role |
| **Not yet registered for use** | Connected, not cleared |
| **Answerable by a person** | You cannot have the data; a holder can answer from it |

That last state is the deck's problem rendered as a UI state rather than a dead end, and it is the hook into Requests.

`canReachUnderlying()` answers a *different* question — does this person genuinely hold the data — because `Answerable by a person` is true for everyone.

### The two pieces of glue

**Glue 1 — Purview MCP server.** Exposes the catalogue as MCP tools (`list_governance_domains`, `search_data_products`, `get_data_product`, `get_lineage`, `get_schema`), published through APIM and attached to agents as an ordinary MCP tool. **Catalogue metadata only, never the underlying data** — it answers "what exists, who owns it, what does it mean", never "give me the rows". That keeps the access-control story clean and is exactly the thin slice Defra's deck asks for.

**Glue 2 — publish an agent as MCP.** Cortex hosts a generic invocation shim, generates an OpenAPI operation per agent, imports it into APIM, projects an MCP server over it, and writes the endpoint back onto the entry. All four steps use documented APIM management APIs; only the shim is ours.

---

## 5. Infrastructure

**Reuses the existing estate.** Every resource name and resource group is a Bicep parameter, defaulted to the resources already in the subscription. The deploy script probes each one and sets a `create*` flag; where a resource exists Cortex is granted access to it, where it does not Cortex creates it.

| Component | Default | Action |
|---|---|---|
| API Management | `prdcoreapimneu001` | Reuse — role assignment + a `cortex` product |
| Purview | `prdcorepurvieweus` | Reuse — roles are a manual portal step either way |
| Foundry | `prdcorefdryeus001` / `prdcorefdryproj-default` | Reuse — role assignments |
| Key Vault | `prdcorekveus` | Reuse — Secrets User |
| Container registry | `prdcoreamlacr001` | Reuse — AcrPull |
| Monitoring | `prdcoreamlneu08774392429` | Reuse |
| **Container Apps** | — | **Create** |
| **Managed identity** | — | **Create** |

Only two things are always created: the container apps, and an identity of Cortex's own. Reusing an identity that belongs to another workload would make its permissions impossible to reason about and impossible to revoke without collateral damage.

### Identity and configuration

One user-assigned managed identity holds every permission. No secrets in code, no client credentials. Endpoints and keys come from **Key Vault**, read once at startup; environment variables remain a fallback. Key Vault wins where both are set, so onboarding a value always takes effect.

**Sign-in is Microsoft Entra only.** Container Apps built-in authentication terminates it before the request reaches the process. Group membership is the whole governance model, so clearance and licence entitlement are derived from groups and live in Entra where they can be governed — not in this application's own store.

---

## 6. What was built, and what was not

The source backlog holds **190 capabilities across 359 rows**, and made no PoC decisions — 326 rows `Undecided`, none marked `Yes`. The prioritisation was ours, scored on demo weight, proof weight and build cost.

**Built:** Marketplace, entry standard, map, Build an agent with computed gates, publish as MCP, Ask with provenance, Share your data, and the Requests lifecycle.

**Deliberately not built:**

| Excluded | Reason |
|---|---|
| Automations that write | The backlog's own rule limits agents to read, summarise and cite this phase |
| Reference data, canonical entities | The backlog records that the owning role **does not exist**. Do not build on a dependency the client has flagged as absent |
| Standards conformance | Same — no owner for data standards |
| Impact assessments, sharing agreements | Governance workflow. Essential to the product, invisible in a demo |
| Cost per use, carbon, coverage percentage | **No live source.** Removed rather than labelled — a figure nobody can defend invites a question that cannot be answered |

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Purview publish transition behaves differently than inferred** | High | Least certain call in the codebase. Bootstrap falls back to `DRAFT` and reports it. Test in week one. |
| **Groups claim missing from the app registration** | High | `Set-CortexAuth.ps1` switches it on and the deploy script runs it. `/profile` diagnoses it. |
| **Cortex identity without a Unified Catalog role** | High | Purview answers 403 to every call. Bootstrap grants the roles through the Policies API; `Test-Cortex.ps1` names the fix when it sees the error. |
| **Only partly verified against real Azure** | High | Provisioning, APIM and Foundry verified live; the Purview grant, product publish and the Ask agent are written to the documented shapes and tested against stubs. Deploy early, expect small fixes. |
| **Preview APIs shift** | Medium | Unified Catalog has no GA version. Isolated behind one adapter. Say so openly — it is a real platform-maturity point. |
| **No persistence** | Medium | Requests and threads die on restart. First item on the next-work list. |
| **Live demo back-end failure** | **Critical** | Accepted deliberately — everything is real, so there is no fallback that hides it. Per-source fault tolerance keeps the app up and names what failed. **Record a walkthrough as insurance.** |
