# Cortex — Handover

**For the agent picking this up. Read this first; it is the only document you need before writing code.**

---

## 1. What this is

Cortex is a single front door to Microsoft Purview, Azure API Management and Microsoft Foundry, built for Defra. A user browses a marketplace of data products, skills and agents; builds an agent from parts they are allowed to use; tests it; and publishes it back as an MCP server so the next person can build on it.

**The pitch, in one line:** every agent anyone builds becomes a part everyone else can build with.

**Everything is live.** No demo mode, no seeded data, no mock adapters. Every screen reads the real APIs. Tests stub at the HTTP boundary instead.

---

## 2. State of play

| Area | State |
|---|---|
| Marketplace, entry standard, map | Working |
| Build an agent → gates → test → publish → reappears | Working, end to end |
| Ask, with provenance | Working |
| Requests lifecycle | Working |
| Share your data | Working |
| Key Vault configuration | Working |
| Entra sign-in | Working |
| **Verified against real Azure** | **Partly — see §8** |

127 unit tests and a 23-step end-to-end script pass against HTTP stubs shaped like real Azure responses.

---

## 3. The two pieces of custom glue

This is why Cortex exists. Microsoft ships neither.

**Glue 1 — `src/purview-mcp/server.js`.** There is no official Purview MCP server, and no Purview knowledge source or tool inside Foundry agents. Purview relates to Foundry only as governance *over* agents (DSPM, DLP, audit), never as a source *for* them. So a Foundry agent cannot look up a data product. This exposes the catalogue as MCP tools. **Catalogue metadata only, never the underlying data** — adding a `read_rows` tool would break the access-control model and should be refused.

This runs as its own container app, `cortex-purview-mcp`, built from `Dockerfile.mcp` and declared as the `purview-mcp` service in `azure.yaml`. It was not always: the app existed and the Bicep tagged it, but `azure.yaml` declared only `web`, so azd never deployed to it and it served the `mcr` quickstart placeholder permanently. If you add a third app, declare it in `azure.yaml` at the same time or you will repeat this.

**Glue 2 — `src/bff/services/publish.js`.** There is no documented way to expose a Foundry agent as an MCP server. Foundry's own Control Plane registration produces an HTTP or A2A API in APIM, not MCP. So Cortex: generates an OpenAPI document for the agent → imports it into APIM as a REST API → creates an MCP server over it (`properties.type: 'mcp'`) → adds a tool → writes the endpoint back to the register. Only the ~100-line shim in `server.js` (`/shim/agents/:id/invoke`) is bespoke; the rest is documented APIM management API.

---

## 4. Repository map

```
infra/                Bicep. Reuses existing Azure resources; creates only what is absent.
  main.bicep          Subscription scope. Every resource name and RG is a parameter.
  modules/*-existing  Grant access to a resource you already own. Create nothing.
scripts/
  Deploy-Cortex.ps1     Probes what exists, sets create* flags, deploys, bootstraps, verifies.
  Preprovision-Check.ps1 azd hook. Guards a bare `azd up` against the two known provision failures.
  Start-Local.ps1       Run on your machine against real Azure.
  Test-Cortex.ps1       Health check a deployment, including the MCP server.
  bootstrap.js          Writes the Defra content into real Purview + APIM. Idempotent.
bootstrap/            Domains, data products, skills. INPUT to the script, not runtime data.
Dockerfile            cortex-web.
Dockerfile.mcp        cortex-purview-mcp. Same tree, different entry point.
src/bff/
  server.js           Zero-dependency HTTP server. All routing.
  config.js           Shape + defaults. hydrateConfig() overlays Key Vault at startup.
  adapters/           purview, apim, foundry, keyvault, token. One implementation each: live.
  services/
    visibility.js     THE governance engine. Read this before touching anything.
    identity.js       Entra claims → user. Groups are everything.
    assurance.js      Seven gates, computed from the agent definition.
    agents.js         Build + validate. Server-side refusal lives here.
    publish.js        Glue 2.
    ask.js            Question answering + provenance.
    requests.js       Request lifecycle.
  index/store.js      The Cortex Index — merged register over all three back ends.
src/web/              Server-rendered GOV.UK pages. No client JS at all.
src/purview-mcp/      Glue 1.
test/
  fixtures.js         HTTP-level Azure stubs. Start here to write a test.
```

---

## 5. The governance model — do not break this

**Entra group membership decides everything.** There are no personas and no anonymous access. Clearance and licence entitlement are *derived* from groups so they live in Entra, where they can be governed and revoked.

Three rules the code enforces, each with tests:

1. **An agent can never reach further than the person who built it.** The greyed-out checkbox in the UI is a courtesy. The control is `validateBuild()` re-checking every attachment server-side on submit. Never remove that.

2. **`visibilityFor()` and `canReachUnderlying()` are different questions.** `visibilityFor` returns the *viewer's* state — and `Answerable by a person` is returned for **everyone**, because that data is never released to anyone. `canReachUnderlying` asks whether someone genuinely holds it. Using the first where you need the second makes every requester their own holder. That bug existed and is now regression-tested.

3. **Requests draft inside the holder's permissions, never the requester's.** `draft()` takes the holder as the acting identity. Nothing reaches a requester without a person calling `release()`.

---

## 6. Verified API facts

These cost real time to establish. They were correct in August 2026 and several contradict older samples.

### Foundry
- Endpoint `https://<account>.services.ai.azure.com/api/projects/<project>`
- `api-version=v1` — a literal string, not a date
- Token scope `https://ai.azure.com/.default`
- **Threads/messages/runs are gone.** The model is **agents + conversations + responses** (an OpenAI Responses API superset)
- Agents are identified by **name + version**, not a GUID
- Agent CRUD at `{ENDPOINT}/agents?api-version=v1`; conversations and responses at `{ENDPOINT}/openai/v1/...` with **no** api-version
- MCP tool is GA: `{ type: 'mcp', server_label, server_url, require_approval, allowed_tools, project_connection_id }`
- **Roles renamed.** Use **Foundry User**, **Foundry Project Manager**, **Foundry Agent Consumer**. **`Azure AI Developer` will not work** — it targets ML workspaces and hubs. Do not assign roles beginning `Cognitive Services`.
- 🔴 **A model deployment must name its version.** Omitting it resolves the account's current default, which moves. See §7.

### API Management
- MCP server support is **GA**, but the management **api-version is `2025-09-01-preview`** — pin it
- **MCP servers are not a distinct resource type.** They are APIs with `properties.type === 'mcp'`. List with `GET /apis?$filter=type eq 'mcp'`
- A tool's `properties.operationId` is a **full ARM resource id**, not a short name. Most common mistake here.
- Creation is async — poll `Azure-AsyncOperation`. Deletes need `If-Match: *` or return 412
- Not supported in APIM **workspaces**. **Consumption tier not supported**
- Analytics: `GET /reports/byApi` on api-version `2024-05-01` (stable, not the preview one)

### Purview
- Endpoint **`https://api.purview-service.microsoft.com`** — *not* `https://{account}.purview.azure.com`, which is legacy
- `api-version=2026-03-20-preview`. **There is no GA version.**
- Scope `https://purview.azure.net/.default` — one token also covers Data Map
- `businessdomains` is lowercase; `dataProducts` is camelCase
- **Publishing is a status transition, not an operation.** No publish verb. `PUT` the whole object with `status: 'PUBLISHED'`. PUT is a **full replace** — read-modify-write. Casing differs between planes: entity reads `PUBLISHED`, query filters use `Published`
- The `Policies` group is **RBAC role assignment**, not data access policy
- 🔴 **No access-request API of any kind** — not submit, approve, read or configure. Cortex owns that workflow, deliberately
- Rate limits per 20s: List 100, Query 800, Get 1500. This is *why* the Cortex Index exists

---

## 7. Traps that will cost you a day

| Trap | What happens | Fix |
|---|---|---|
| **Unpinned model version** | `ServiceModelDeprecating` on a template that has not changed. ARM resolved the account default, which moved onto a deprecated build | Name `properties.model.version` explicitly, always. Set `versionUpgradeOption: 'OnceCurrentVersionExpired'`. `Deploy-Cortex.ps1` validates it before provisioning |
| **Hardcoded image in the Container App** | Every `azd provision` rolls the app back to the placeholder before deploy pushes the real one, and any app azd does not deploy stays on it forever | Take the image as a parameter fed from `SERVICE_<NAME>_IMAGE_NAME`. Never hardcode anything but the first-run placeholder |
| **Container App declared in Bicep but not in `azure.yaml`** | The app exists, answers on its URL, and serves the placeholder. Nothing errors | Every `azd-service-name` tag needs a matching service in `azure.yaml` |
| **Hardcoded `azd-env-name` tag** | azd locates its resources by that tag. A second environment claims the first one's resources | Tag from `environmentName`, never a literal |
| **Missing groups claim** | Everyone appears to be in no groups; Marketplace looks empty and broken | Add the groups claim to the app registration. `/profile` diagnoses it |
| **Purview roles in one plane only** | Assets silently invisible, including in search | Data Product Owner **and** Data reader. Both |
| **Key Vault on access policies** | RBAC assignment silently ignored | `--enable-rbac-authorization true`. Deploy script warns |
| **Two azd environments, one Key Vault** | The last one provisioned owns every endpoint in the vault; the other app talks to the wrong container | `cortex-environment-name` records the owner and the deploy script warns. Give the second environment its own vault |
| **Key Vault with public access disabled** | The vault seeds fine and is then unreadable at runtime, because KV firewall rules are data-plane only and Container Apps is not a trusted service. App starts, falls back to environment, marketplace is empty — looks like an app fault | `-ConfigSource direct` passes configuration to the apps instead. Only a private endpoint restores the vault path |
| **`fetch()` has no timeout** | A hanging back end blocks startup forever; readiness probe never passes | Bounded in `keyvault.js`. Apply the same pattern to any new outbound call |
| **Readiness probe against the placeholder** | First provision hangs, then fails for a reason unrelated to the template | The probe and target port are only applied once a real image is present |
| **APIM and Purview in different regions** | Yours are North Europe and East US | Works fine; adds latency. Do not "fix" by moving anything |

---

## 8. What is verified, and what to do first

**One live provision has now run.** It reached Azure, created the resource group, the Container Apps environment and both container apps, and failed on the model deployment — which is the trap at the top of §7. The infrastructure path is real; the model, image and idempotency fixes in this repo came out of that run.

**Still unverified:** bootstrap against real Purview, the publish status transition, the APIM MCP server creation, and the end-to-end golden path.

**Do these in order:**

1. `.\scripts\Deploy-Cortex.ps1 -WhatIfResources` — confirms the resource mapping and that the pinned model is deployable. Changes nothing.
2. `node scripts/bootstrap.js --dry-run` — validates the content payloads. No Azure needed.
3. Deploy. Then check `cortex-purview-mcp` is serving `/health` and not a placeholder — `Test-Cortex.ps1` does this.
4. Bootstrap. **Watch the Purview publish transition** — it is the least certain call in the codebase. If it is refused the script falls back to `DRAFT` and says so.
5. `npm install` fetches `govuk-frontend`. The app falls back to a bundled stylesheet with the same class names, so it renders either way, but verify the vendored path works.

---

## 9. Next work, in priority order

1. **Persistence.** Requests, methods, threads and access requests are all in memory and die on restart. Cosmos was removed from the Bicep because nothing used it — add it back and implement a store when you do this. This is the biggest real gap.
2. **Purview access policies.** Cortex owns the request workflow; it does not yet call anything to actually *grant* access. Approval currently updates the register only.
3. **Streaming for Ask.** `LiveFoundry.stream()` exists and is unused; the UI posts and re-renders.
4. **Recurring requests.** Cadence is captured and approved methods are stored, but nothing issues them on a schedule.
5. **Skill invocation shim.** `bootstrap.js` publishes skills pointing at `/shim/skills/:id`, which is not implemented. Either implement it or stop publishing those APIs.
6. **Data Map lineage.** `getAssets()` exists; lineage on the entry page comes from managed attributes, not real lineage.
7. **Get Key Vault back in the runtime path.** The sandbox vault has public network access disabled, so the apps run on direct configuration with three Container Apps secrets. That is weaker than a vault — the secrets are readable by anyone with Contributor on the app. Fixing it means a VNet-integrated Container Apps environment and a private endpoint, and the environment cannot be VNet-joined after creation, so it has to be rebuilt. `docs/DEPLOY.md` §5c has the order.

---

## 10. Conventions

- **Zero runtime dependencies.** Node built-ins only. `govuk-frontend` is a build-time dependency, vendored into `src/web/assets/vendor/` by `npm install`. Keep it that way — it is why cold start is fast, and cold start is the top demo risk.
- **No client JavaScript.** Every page works with JS disabled. Two inline `onchange` handlers exist for convenience with `<noscript>` fallbacks.
- **Never show a number without a source.** Usage, error rate and latency come from APIM analytics. Cost per use, carbon and "believed estate" coverage were removed rather than labelled illustrative. If you add a figure, wire it to something real or leave it out.
- **Escape everything.** `esc()` in `layout.js` on every interpolation. XSS is tested.
- **Comments explain *why*.** The code says what it does; comments should say why it is that way, especially where a shape is surprising or a rule is load-bearing.
- **Business language in the UI.** No jargon, no product names in user-facing copy where a plain word will do.
- **Infrastructure must survive a re-run.** Assume every template is applied many times. Anything that only works the first time is a bug, not a limitation.
- **Configuration has two supported sources, and the app must not care which.** Key Vault when it is reachable, the environment otherwise. `SECRET_CATALOGUE` in `adapters/keyvault.js` is the contract between them: add a value there and to `containerapps.bicep`, or it will work in one mode and not the other.
