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
| Ask, with provenance | **Live against Foundry** since 3 Sep — the `cortex-ask` agent writes the answer from the entries the asker can reach; the register-only text it used to show (which said "demo mode is on") is now only the fallback when the model cannot be reached |
| Requests lifecycle | Working |
| Share your data | Working |
| Key Vault configuration | Working (direct mode in the sandbox — see DEPLOY.md §5) |
| Entra sign-in, groups claim, group mapping | **Scripted** — `Set-CortexAuth.ps1`, run by the deploy script |
| Purview roles for the Cortex identity | **Scripted** — bootstrap grants them through the Unified Catalog Policies API. This was the cause of "Purview UNAVAILABLE — 403" |
| **Verified against real Azure** | **Partly — see §8** |

214 unit tests pass against HTTP stubs shaped like real Azure responses, including a smoke test that boots the real server and opens every page.

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
  Deploy-Cortex.ps1     Probes what exists, sets create* flags, deploys, configures sign-in,
                        grants Purview access, bootstraps, verifies. 12 steps, all re-runnable.
  Set-CortexAuth.ps1    Entra app registration + groups claim + Container Apps auth + group
                        mapping + default group. Idempotent.
  Preprovision-Check.ps1 azd hook. Guards a bare `azd up` against the two known provision failures.
  Set-CortexEnv.ps1     Dot-source to load config into a session, for running bootstrap by hand.
  Start-Local.ps1       Run on your machine against real Azure.
  Test-Cortex.ps1       Health check a deployment, including the MCP server.
  bootstrap.js          Grants the Cortex identity its Purview roles, then writes the Defra
                        content into real Purview + APIM. Idempotent. --only=roles|purview|apim
  purview-access.js     The Unified Catalog Policies API mutation, as pure functions + grants.
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
  token.test.js       How the Azure CLI is invoked. Both Windows spawn traps, pinned.
  bootstrap.test.js   The idempotency rules. A mistake here duplicates a real catalogue.
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
- **MCP servers are not a distinct resource type.** They are APIs with `properties.type === 'mcp'`. List all APIs and filter on that field
- 🔴 **The tools are INLINE. One PUT, carrying BOTH `type: 'mcp'` AND a non-empty `mcpTools: [{ name, description, operationId }]`.** Without `mcpTools`, ARM silently drops the type: the API is created as a plain HTTP API, a later GET shows `type: null`, and anything treating it as an MCP server answers **500 InternalServerError**. The child resource `…/apis/{id}/tools/{tool}` that the TypeSpec describes **does not work via PUT** in this api-version. The earlier note here that "tools are a child resource" was wrong, and it cost two rounds of retry tuning for what was never a race
- `mcpTools[].operationId` is the **full ARM resource id** of the backing operation, with **no `;rev=N` suffix**. The operation must exist before the PUT (an OpenAPI import is async — wait for it)
- A type-null leftover cannot be converted in place: delete it (`If-Match: *`) and recreate. `apim.js` and `bootstrap.js` do this
- The MCP endpoint is `https://{gateway}/{path}/mcp` — APIM adds `/mcp`. `serviceUrl` is **null** on an MCP API; never read the endpoint from it
- Creation is async — poll `Azure-AsyncOperation`. Deletes need `If-Match: *` or return 412
- Not supported in APIM **workspaces**. **Consumption tier not supported**
- Analytics: `GET /reports/byApi` on api-version `2024-05-01` (stable, not the preview one)

### Purview
- Endpoint **`https://api.purview-service.microsoft.com`** — *not* `https://{account}.purview.azure.com`, which is legacy
- `api-version=2026-03-20-preview`. **There is no GA version.**
- Scope `https://purview.azure.net/.default` — one token also covers Data Map
- `businessdomains` is lowercase; `dataProducts` is camelCase
- **Publishing is a status transition, not an operation.** No publish verb. `PUT` the whole object with `status: 'PUBLISHED'`. PUT is a **full replace** — read-modify-write. Casing differs between planes: entity reads `PUBLISHED`, query filters use `Published`
- A data product needs at least one **owner** (`contacts.owner[].id` = an Entra object id) before it will publish. Bootstrap names the signed-in person
- The `Policies` group is **RBAC role assignment**, not data access policy — and it is how roles are automated. `GET /datagovernance/catalog/policies` returns one policy per scope (`dgpolicy_datagovernanceapp_<id>` for the catalogue, `dgpolicy_businessdomain_<id>` per domain); each role is an `attributeRules[]` entry `purviewdatagovernancerole_builtin_<role>:<scope>` whose `principal.microsoft.id` condition lists the object ids. `PUT` the whole policy back with the same `version`. **Service principals and managed identities are accepted** — the older note here saying roles could not be automated was wrong
- **`403 {"code":"Unauthorized","message":"Not authorized to access account"}`** from any Unified Catalog call means the caller holds no Unified Catalog role. Not an Azure RBAC problem, not a network problem
- Roles the app needs: catalog-level **Data Governance Administrator** + **Global Catalog Reader**; **Governance Domain Owner** on each Cortex domain. Data Map (collection) roles only matter once data products carry real assets
- 🔴 **No access-request API of any kind** — not submit, approve, read or configure. Cortex owns that workflow, deliberately
- Rate limits per 20s: List 100, Query 800, Get 1500. This is *why* the Cortex Index exists, and why `purview.js` and the MCP server cache health and listings

---

## 7. Traps that will cost you a day

| Trap | What happens | Fix |
|---|---|---|
| **Unpinned model version** | `ServiceModelDeprecating` on a template that has not changed. ARM resolved the account default, which moved onto a deprecated build | Name `properties.model.version` explicitly, always. Set `versionUpgradeOption: 'OnceCurrentVersionExpired'`. `Deploy-Cortex.ps1` validates it before provisioning |
| **Hardcoded image in the Container App** | Every `azd provision` rolls the app back to the placeholder before deploy pushes the real one, and any app azd does not deploy stays on it forever | Take the image as a parameter fed from `SERVICE_<NAME>_IMAGE_NAME`. Never hardcode anything but the first-run placeholder |
| **Container App declared in Bicep but not in `azure.yaml`** | The app exists, answers on its URL, and serves the placeholder. Nothing errors | Every `azd-service-name` tag needs a matching service in `azure.yaml` |
| **Hardcoded `azd-env-name` tag** | azd locates its resources by that tag. A second environment claims the first one's resources | Tag from `environmentName`, never a literal |
| **Missing groups claim** | Everyone appears to be in no groups; Marketplace looks empty and broken | Add the groups claim to the app registration. `/profile` diagnoses it |
| **Cortex identity with no Purview role** | Help page: Purview UNAVAILABLE, `403 Not authorized to access account`. APIM and Foundry fine | `node scripts/bootstrap.js --only=roles` (after `. .\scripts\Set-CortexEnv.ps1`). Deploy-Cortex.ps1 does it |
| **Your own account not a Data Governance Administrator** | Bootstrap gets 403 from Purview | Purview portal → Settings → Solution settings → Unified Catalog → Roles and permissions |
| **Source masked in transit** | A file that passed through a chat or transfer tool has a run of asterisks where a credential-shaped value was — including the authorization header template literal (scheme word plus token). It parses; every Azure call then fails | Deploy-Cortex.ps1 step 1 refuses to deploy it. The adapters compose the header with `bearer(token)` so the pattern never appears in source |
| **More than one web replica** | A user publishes an agent, the next page load hits another replica where it does not exist | `webMaxReplicas` is 1 until there is a store. Do not raise it |
| **A model in the catalogue that is not deployed** | Passes validation, fails at agent creation | `listModels()` offers only `FOUNDRY_MODEL` and `FOUNDRY_MODELS` |
| **MCP server PUT without `mcpTools`** | Type silently dropped; every later call about it answers 500 | One PUT with type AND tools inline, then verify the GET shows `type: mcp`. Never `/tools/{id}` |
| **`Number(headers.get('retry-after'))`** | `Number(null)` is 0, so an absent header meant a zero-second wait — three "retries" in one second | `retryDelayMs()` honours only a present numeric header, else backs off with a floor |
| **Stale CLI token after a directory role change** | `TokenCreatedWithOutdatedPolicies … InteractionRequired`, reads like a missing permission; on Windows a plain `az login` hands back the same token via the broker | `az account clear` → `az login --use-device-code`. Both scripts do this automatically |
| **Key Vault on access policies** | RBAC assignment silently ignored | `--enable-rbac-authorization true`. Deploy script warns |
| **Two azd environments, one Key Vault** | The last one provisioned owns every endpoint in the vault; the other app talks to the wrong container | `cortex-environment-name` records the owner and the deploy script warns. Give the second environment its own vault |
| **Key Vault with public access disabled** | The vault seeds fine and is then unreadable at runtime, because KV firewall rules are data-plane only and Container Apps is not a trusted service. App starts, falls back to environment, marketplace is empty — looks like an app fault | `-ConfigSource direct` passes configuration to the apps instead. Only a private endpoint restores the vault path |
| **Running bootstrap without loading config** | `Missing required configuration` listing all 8 required secrets. bootstrap.js runs on your machine, not in the container, so it has neither the deployed env vars nor a readable vault | `. .\scripts\Set-CortexEnv.ps1` first — dot-sourced. `Deploy-Cortex.ps1` does it in-process |
| **`spawn az ENOENT` on Windows** | Any local run that needs a token dies instantly. The CLI is installed and works from the same prompt | `execFile` does not apply PATHEXT, and on Windows the CLI is `az.cmd` — there is no `az.exe`. Name the `.cmd` explicitly |
| **`spawn EINVAL` after fixing the above** | Node found `az.cmd` and refused to run it | Since CVE-2024-27980 (Node 18.20.2 / 20.12.2+) a `.bat`/`.cmd` cannot be spawned without `shell: true`. There is no alternative — so `token.js` uses a shell on Windows only, allowlists the one variable argument first, and passes a single command string (an args array with `shell: true` is DEP0190) |
| **`fetch()` has no timeout** | A hanging back end blocks startup forever; readiness probe never passes | Bounded in `keyvault.js`. Apply the same pattern to any new outbound call |
| **Readiness probe against the placeholder** | First provision hangs, then fails for a reason unrelated to the template | The probe and target port are only applied once a real image is present |
| **APIM and Purview in different regions** | Yours are North Europe and East US | Works fine; adds latency. Do not "fix" by moving anything |

---

## 8. What is verified, and what to do first

**One live provision has now run.** It reached Azure, created the resource group, the Container Apps environment and both container apps, and failed on the model deployment — which is the trap at the top of §7. The infrastructure path is real; the model, image and idempotency fixes in this repo came out of that run.

**Verified against Azure (3 Sep, live runs):** provisioning end to end; the Purview grant through the Policies API — Data Governance Administrator + Global Catalog Reader at catalogue level, Governance Domain Owner on all nine domains; **all fourteen data products created and published** once they carried an owner; the nine domains adopted and updated idempotently; Entra sign-in through `Set-CortexAuth.ps1` after a device-code re-login.

**Seen against Azure and now fixed:** the deployed app's `403 Not authorized to access account` from Purview (§7); data products never created (managed-attribute shape, then the missing owner); five of six skills failing with 500 in API Management (the MCP request shape — see §6, not a race).

**Still unverified — written against the verified shapes and stubs, not yet a live run:**
- the inline-`mcpTools` MCP server creation for the five skills and for Publish (`apim.js`, `bootstrap.js`);
- `ensureAgent` for `cortex-ask` and a `previous_response_id` follow-up;
- `Set-CortexAuth.ps1 -MapMyGroups`.

**Do these in order:**

1. `npm test` — 214 green, no Azure.
2. `.\scripts\Deploy-Cortex.ps1 -WhatIfResources` — confirms the resource mapping and the model. Changes nothing.
3. `.\scripts\Deploy-Cortex.ps1` — the full run. Watch step 11: the **Purview access** step should report the two catalog roles granted and Governance Domain Owner on nine domains, then the products created (published, or as drafts with the reason).
4. `.\scripts\Test-Cortex.ps1` — six green. If Purview alone is red straight after the deploy, wait a minute; the roles propagate.
5. Sign in, open `/profile`, then Ask a question — the panel should say "Answered by the Foundry agent cortex-ask".

---

## 9. Next work, in priority order

1. **Persistence.** Requests, methods, threads and access requests are all in memory and die on restart, and `cortex-web` is pinned to one replica because of it. Cosmos was removed from the Bicep because nothing used it — add it back (or a small JSON store on a mounted share) and implement a store when you do this. This is the biggest real gap.
2. **Purview access policies.** Cortex owns the request workflow; it does not yet call anything to actually *grant* access. Approval currently updates the register only.
3. **Streaming for Ask.** `LiveFoundry.stream()` exists and is unused; the UI posts and re-renders.
4. **Recurring requests.** Cadence is captured and approved methods are stored, but nothing issues them on a schedule.
5. **Skill invocation shim.** `bootstrap.js` publishes skills pointing at `/shim/skills/:id`, which is not implemented. Either implement it or stop publishing those APIs.
5b. **The shim trusts the gateway.** `/shim/*` and `/api/health*` are excluded from Easy Auth so API Management and the scripts can reach them; the shim does not verify that a call came through API Management. Add a shared header check (APIM policy sets it, the shim requires it) before this leaves the sandbox.
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
- **Never write a bearer header as one literal.** Use the `bearer(token)` helper each adapter defines. Source that travels through a chat or transfer tool comes back with credential-shaped text masked — including template literals — and the result parses and then fails every call. Deploy-Cortex.ps1 step 1 checks for it.
- **Bound every outbound call.** `AbortSignal.timeout` on every `fetch`; the adapters have per-call and per-answer budgets in config. A hanging back end must degrade a page, not hang it.
- **Cortex decides what the model may see; the model decides what to say.** Ask passes catalogue metadata for entries the asker can reach and nothing else. Keep that boundary — it is the governance story.
