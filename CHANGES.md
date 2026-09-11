# What changed — 3 September 2026

## Addendum 7 (11 Sep): round 4 — agents that can reach their tools and their data

Six requests, all delivered, all re-deployable on their own. Nothing here has run
against the tenant yet; `docs/HANDOVER.md` §8b lists what to verify first.

### 1. The agent → tool 401, fixed

**Symptom.** Testing `data-mapper`: *Foundry POST /openai/v1/responses failed 400:
Authentication failed when connecting to the MCP server
https://prdcoreapimneu001.azure-api.net:443/magic-map-mcp/mcp: 401 Access denied
due to missing subscription key.*

**Cause.** Every Cortex-published MCP server sits behind API Management, which
requires `Ocp-Apim-Subscription-Key`. Foundry refuses a raw header on an MCP
tool; the documented route is a **project connection** (category `RemoteTool`,
`CustomKeys`) that the tool names through `project_connection_id`. The code had
the field but nothing ever created a connection (`FOUNDRY_MCP_CONNECTION` was
never set). One connection per server, because Foundry uses the *connection's*
target when it differs from the tool's URL.

**Fix.**
- `src/bff/adapters/foundry-connections.js` — ARM PUT of the connection,
  idempotent; names from the APIM id (`cx-mcp-<id>-<hash>`, ≤ 33 chars); a
  keyless `CognitiveSearch` connection for AI Search.
- `services/agents.js` creates the connection for every APIM tool when an agent
  is built or **rebuilt** (new: `rebuildAgent`, "Rebuild tools" on the agent
  page); `services/publish.js` creates one for each newly published agent;
  `bootstrap.js --only=connections` creates them for every MCP server in APIM.
- `infra/modules/foundry-existing.bicep` grants `id-cortex` **Foundry Project
  Manager** (`Microsoft.CognitiveServices/accounts/projects/*`) — the smallest
  role that can write a connection.
- **The approval loop.** Tools are registered `require_approval: 'always'`, so
  a call came back as `mcp_approval_request` and the old code showed an empty
  answer. `adapters/foundry.js respond()` now approves server-side, continues
  from `previous_response_id`, records every `mcp_call`, and returns
  `toolCalls` — shown as *Tools this answer used*.
- **The error page.** `services/explain.js` turns raw failures into a heading,
  a sentence and a fix; the raw text is behind a *Technical detail* fold. Used
  on the agent test page, in chat, and in automation runs.

### 2. Chat with an agent

`/agent/:id/chat` — a server-rendered, JavaScript-free conversation in its own
window (`Open a chat window` on the agent page, `Chat with this agent` on its
entry, `Chat` on Marketplace cards). Foundry keeps the thread via
`previous_response_id`; Cortex keeps the transcript and provenance for the
person who had it. `CORTEX_CHAT_POLICY=all-staff` (this phase) lets every
signed-in person chat with every agent; `visibility` applies the Marketplace
rules. Checked on every turn. `services/chat.js`, `views/chat.js`.

### 3. The data behind a data product

- `adapters/purview.js`: register a Data Map asset in the catalogue
  (`POST /dataAssets`, `source.assetId`), attach it to a product
  (`POST /dataProducts/{id}/relationships?entityType=DATAASSET`), read assets
  with schema and classifications.
- `adapters/datamap.js`: collection roles (metadata policy RMW), ADLS Gen2
  source, `AdlsGen2Msi` scan, run and wait, asset lookup by qualified name.
- `adapters/search.js`: index / data source (`adlsgen2`, managed identity) /
  indexer (`delimitedText`, header row) per product; stats, status, run.
- `services/grounding.js`: assets → columns → `buildIndex()`; `azure_ai_search`
  tools for agents built on indexed products; grounding notes in instructions.
- Entry pages: **The data behind it** — assets, columns, classifications,
  index state, indexer status, **Build the index now**.
- Bootstrap writes `cortexDataFolder` and `cortexSearchIndex` managed
  attributes on each product so the app finds its folder and index directly.

### 4. Sample data for all fourteen products

`scripts/sample-data.js` — deterministic (seeded) synthetic CSVs of 700–1,800
rows with snake_case headers that pass the Data Map's schema rules, and a
`README.md` data dictionary per product. `bootstrap.js --only=data` uploads
them, grants Data Map collection roles to you and the Cortex identity,
registers `cortex-sample-data`, runs `cortex-sample-scan`, waits (3–10 min;
`--no-wait` to skip), then attaches each scanned file to its product.
`--only=link` does the attachment on its own. `--only=search` builds the
indexes and the Foundry search connection.

### 5. Automate a task

`services/automations.js`, `views/automate.js`. Two kinds: ask a named agent a
fixed question, or re-run an approved request method through Ask inside the
owner's captured permissions. Cadences: every 15 minutes (demo), hourly,
daily, weekdays, weekly (UTC). A timer in the web app runs what is due; **Run
it now**, pause, resume, delete, delete a draft. Every automation states what
it does, who is accountable, what it writes (nothing), what stops it and how
it is undone. Propose-only is structural — there is no field to turn writing on.

### 6. Light persistence

`src/bff/state/store.js` — one JSON file per collection on an Azure Files share
mounted at `/data` (`infra/modules/data.bicep`, `containerapps.bicep`), memory
when unmounted. Requests, approved methods, Ask threads, chats, automations,
access and gateway requests, and the Cortex record of every agent (definition,
gates, published state) now survive restarts and redeploys. `cortex-web` stays
at one replica: one writer.

### Infrastructure

New in `PRDCORECORTEX001`: `srch-cortex-<id>` (AI Search, Basic — 15 indexes;
`SEARCH_SKU=standard` for more), `stcortexdata<id>` (ADLS Gen2, sample data,
keyless), `stcortexstate<id>` (Azure Files share). Role grants: Purview account
identity and search identity read the data account; Cortex identity writes it
and administers search; Foundry account identity holds the search roles the
`azure_ai_search` tool needs; the deployer gets Storage Blob Data Contributor
(`DEPLOYER_PRINCIPAL_ID`, set by the deploy script). `-NoData`, `-NoSearch`,
`-SearchSku`, `-ChatPolicy`, `-NoScanWait` on `Deploy-Cortex.ps1`.
`Set-CortexEnv.ps1` and `Test-Cortex.ps1` know the new values and checks.

### Numbers

Tests 226 → **289**. New: `state`, `foundry-connections`, `foundry-approval`,
`search`, `datamap`, `grounding`, `chat`, `automations`, `sample-data`,
`explain`; smoke covers `/automate`, the entry page's data panel and the form
validation.

### Things to know

- The Foundry **account** needs a system-assigned identity for keyless search;
  the deploy script warns if it has none.
- Indexes are keyword (`simple`) — no embedding model. `SEARCH_QUERY_TYPE` and
  `SEARCH_SEMANTIC` are the upgrade path.
- Agents built before this round have no tool connections: **Rebuild tools**.
- Bicep in this round could not be compiled here; `azd up` validates it. If it
  reports a property name, the three new modules are small.


## Addendum 6 (8 Sep): guests stopped by MFA with no way to set it up

The first invited tester was stopped at sign-in by *Require multifactor
authentication* and never offered the set-up screen. The sign-in log shows why:
two baseline Conditional Access policies for "Microsoft partners and vendors" —
the tenant's term for external users — one requiring MFA, the other **blocking
security-info registration**. A guest must do MFA and may not register a method
here to do it with. That is deliberate: guests are meant to bring MFA from their
home tenant, and this tenant simply was not yet configured to accept it.

Fix: inbound trust in cross-tenant access settings (`isMfaAccepted`), so the
MFA a Microsoft or Defra account already performed at home satisfies the
requirement here. `Add-CortexUser.ps1` now reads that setting on every run,
warns while it is off, and turns it on with `-TrustHomeMfa` (Graph
`PATCH /policies/crossTenantAccessPolicy/default`), printing the portal path
if it lacks the right. The two policies are not touched. For a tester whose
home tenant performs no MFA, the answer is a member account in this tenant.
`docs/DEPLOY.md` §3d and §6, `HANDOVER.md` §7.

## Addendum 5 (4 Sep, later): `'$select' is not recognized…`

`Add-CortexUser.ps1` found the account and then fell over on its own URL. On
Windows `az` is a `.cmd`, its arguments pass through cmd.exe, and the unquoted
`&` in `users?$filter=…&$select=…` split the command in two — the JSON on
screen was the first half succeeding, and `'$select' is not recognized` was
cmd.exe trying to run the second half. Same trap as `token.js` (§7 of the
handover), one layer up.

The fix is structural: **no query string is ever written into `--url`.** Each
parameter goes through `az rest --uri-parameters`, one argument each, and the
CLI URL-encodes them. The guest fallback no longer uses `startswith(...)` — an
unquoted `)` ends az.cmd's own IF block — but builds the exact
`name_home.com#EXT#@<initial domain>` UPN from the tenant's verified domains.
`Set-CortexAuth.ps1 -MapMyGroups` had the same `&` and is fixed the same way.
A copy published for a few minutes earlier this afternoon encoded `&` as `%26`
instead; that was wrong (an encoded ampersand is data, not a separator — Graph
would have read it as part of the filter) and is superseded. If you took that
copy, replace it.

What the failed lookup had already answered: `shengzhu@microsoft.com` is
**already a guest** in the tenant. Nothing to invite — open Cortex in a private
window and pick that account. The script now says exactly that when it finds an
accepted guest.

## Addendum 4 (4 Sep): inviting people from other tenants

`scripts/Add-CortexUser.ps1` — give somebody access: a colleague, or your own
account from another tenant. Cortex's app registration is single-tenant, so an
outside account comes in as an **Entra B2B guest**: the script finds them in the
directory or POSTs a Graph invitation with Cortex's URL as the landing page,
optionally adds them to Entra groups (`-Groups`), and says what they will see.
`-NoEmail` prints the redemption link, `-Resend` re-invites. Idempotent, with
the same stale-token handling as `Set-CortexAuth.ps1`.

`identity.js` now shows a guest by the address in their `preferred_username` or
`email` claim rather than the synthetic `name_home.com#EXT#@tenant` UPN, and
exposes `isGuest`. Groups work for guests exactly as for members — they are
this tenant's groups — so `all-staff` and any `-Groups` apply from the first
sign-in. `docs/DEPLOY.md` §3d covers it; two troubleshooting rows cover a home
tenant that refuses and a browser already signed in as someone else.

## Addendum 3, same day: the API Management 500 was the request shape, not a race

`node scripts/bootstrap.js --only=apim` failed the same five skills again with
`500 InternalServerError` on `PUT /apis/<skill>-mcp/tools/invoke` — now after a
genuine 150 seconds of back-off per skill. Timing was never the cause.

**The verified shape** (api-version `2025-09-01-preview`, checked against a
working May 2026 implementation): an MCP server is created with **one PUT**
that carries **both** `type: 'mcp'` **and** a non-empty `mcpTools` array —
`{ name, description, operationId: <full ARM id of the backing operation> }`.
Two things follow, and both bit us:

- **Without `mcpTools`, ARM silently drops the type.** The `…-mcp` API was
  created as a plain HTTP API (a GET shows `type: null`). Everything that then
  treated it as an MCP server failed with an unhelpful 500.
- **The child `/apis/{id}/tools/{tool}` resource does not work via PUT** in
  this api-version, even though the TypeSpec describes it. The repository's
  "verified fact" that tools are a child resource was wrong.

The one skill that "worked" — Permit history lookup — was a server that
already existed in the right shape from an earlier portal-side experiment, so
its tool update was accepted; the five new ones could never have been.

Fixed in both places that create MCP servers:

- `src/bff/adapters/apim.js` — `createMcpServer({ …, tools })` sends the tools
  inline, deletes and recreates a type-null leftover (it cannot be converted in
  place), and **verifies** the GET shows `type: mcp` with tools. `addTool()` is
  now a read-modify-write of `mcpTools`. `listMcpServers()` reads the tools
  inline and derives the endpoint as `{gateway}/{path}/mcp` — `serviceUrl` is
  null on an MCP API, which is why the Marketplace never showed an MCP endpoint
  for the skills. Listings now follow `nextLink`.
- `scripts/bootstrap.js` — the same one-PUT shape, the same leftover
  replacement, the same verification.
- `src/bff/services/publish.js` (Glue 2) — passes the `ask` tool into
  `createMcpServer`; the separate "add tool" step is gone.
- `test/fixtures.js` now behaves like ARM (type survives only with tools;
  `GET /apis/{id}` reads back what was PUT) and `test/bootstrap.test.js` pins
  the shape: never `/tools/`, type + tools in one body, full ARM operation id.

**Also:** `/profile` showed *8 unmapped group ids*. Those are the Entra groups
you are already in, shown by object id because nothing had named them. Not a
fault — an id only affects access once a rule refers to it.
`Set-CortexAuth.ps1 -MapMyGroups` now names every group you are in after its
Entra display name (additive; an explicit `-GroupMap` alias always wins), and
the profile page says so instead of pointing at a raw setting.

Re-run: `. .\scripts\Set-CortexEnv.ps1` then `node scripts/bootstrap.js --only=apim`
— expect the five `…-mcp` leftovers to be reported as *replacing* and each
skill to end `created — tool "invoke", endpoint https://…/<skill>-mcp/mcp`.

## Addendum 2, same day: what the first successful run showed

The full run got through. **Purview is fixed**: the Cortex identity was granted
Data Governance Administrator and Global Catalog Reader at catalogue level and
Governance Domain Owner on the nine domains, and **all fourteen data products
were created and published** — the owner was indeed what the catalogue had been
waiting for. Three things still went wrong, all now fixed:

1. **Sign-in: `TokenCreatedWithOutdatedPolicies`.** You had just added yourself
   to Application Administrator, and the Azure CLI was still using a Graph token
   issued *before* that change. Entra's continuous access evaluation refuses such
   a token and the CLI cannot renew it silently — so `az ad app create` failed
   with a message that read like a missing permission. `Set-CortexAuth.ps1` now
   pre-flights a directory call, recognises the challenge, signs you in again
   and retries; `Deploy-Cortex.ps1` step 2 does the same. **On Windows a plain
   `az login` is not enough** — the Web Account Manager broker signs you in
   silently and hands back the same revoked token (that is what the second
   failure was). The scripts therefore clear the CLI cache first and, if the
   challenge persists, fall back to `az login --use-device-code`, which always
   re-authenticates. By hand: `az account clear; az login --use-device-code;
   az account set --subscription <id>`. You
   also deleted the old "Cortex" registration, which left the container app's
   sign-in pointing at a client id that no longer exists — **nobody can sign in
   until `Set-CortexAuth.ps1` has replaced it.** The script now says exactly that.
2. **API Management: five skills failed with 500 — and the retry waited 0 s.**
   `Number(headers.get('retry-after'))` is `Number(null)` = 0 when the header is
   absent, so every "retry" happened inside the same second. Fixed with a tested
   `retryDelayMs()`; the tool step now also waits for the MCP server resource to
   read back and retries five times from ten seconds upward. Re-run bootstrap
   (`. .\scripts\Set-CortexEnv.ps1` then `node scripts/bootstrap.js --only=apim`).
3. **Every health check "returned ok=false".** Not the app: sign-in is guarding
   `/api/health*`, so the checks were following a 302 to the login page and
   reading HTML. `Deploy-Cortex.ps1` and `Test-Cortex.ps1` no longer follow
   redirects and say "redirected to sign-in" instead; `Set-CortexAuth.ps1`
   excludes the machine paths, after which the checks are real.

Order now: `.\scripts\Set-CortexAuth.ps1` (fixes sign-in and unblocks the
health paths) → `.\scripts\Test-Cortex.ps1` → bootstrap `--only=apim` for the
five skills.

## Addendum 1, same day: the first full run

`Deploy-Cortex.ps1` failed at `azd up` with two errors on screen:

```
'preprovision' hook failed ... Preprovision-Check.ps1 cannot be loaded. The file ... is not
digitally signed. You cannot run this script on the current system.
step "package-web" failed: ... open ...\azd-docker-build...\imgId: The system cannot find the file specified.
```

**One cause, not two.** The repository sits in a OneDrive folder; files that
arrive by sync, download or an extracted zip carry the *Mark of the Web*, and
PowerShell's default `RemoteSigned` policy refuses to run them. That stopped the
pre-provision hook. azd builds the container images in parallel with
provisioning and cancelled the builds when the hook failed — the missing
`imgId` is the cancellation, not Docker.

Why it "worked yesterday": yesterday's deployment was `-AppOnly` (`azd deploy`),
which never runs the pre-provision hook. Today was the first `azd up` since the
hook was added on 2 September, and the first time its file was executed.

Fixed in three places:

- `azure.yaml` — the hook runs through a nested `pwsh -NoProfile -ExecutionPolicy Bypass -File …`, so the file's zone cannot block it, and propagates the exit code.
- `Deploy-Cortex.ps1` step 1 — unblocks every `.ps1` in the repository (outside `node_modules`, `.venv`, `.git`) and reports how many carried the mark; the `azd up` failure text now names both signatures.
- `Set-CortexAuth.ps1` — while here: if sign-in is already configured on the app (you did this by hand), the script keeps that app registration instead of creating a second "Cortex" one and switching the app over.

`docs/DEPLOY.md` §1 and §6 cover it. Re-run `.\scripts\Deploy-Cortex.ps1`.

---

Round 3. The Purview 403, a live Ask page, sign-in automation, and a deployment
guide that reads in the order you need it. Every file below lands where it
belongs when the folder is copied over `agenticframework/`. Nothing was
deleted; `FIXES.md` (round 2) is unchanged and still accurate.

```
CHANGES.md                              this file
README.md                               MODIFIED  — what is automated now, test count, docs index
azure.yaml                              MODIFIED  — post-provision message no longer says "none can be automated"
docs/DEPLOY.md                          REWRITTEN — logical order: before / deploy / after / iterate / how / troubleshoot / reference
docs/HANDOVER.md                        MODIFIED  — state of play, Purview facts, traps, next steps, conventions
docs/ARCHITECTURE.md                    MODIFIED  — tool list, demo table, risks
infra/main.bicep                        MODIFIED  — purview-existing module, defaultGroups, webMaxReplicas
infra/main.parameters.json              MODIFIED  — CORTEX_DEFAULT_GROUPS, WEB_MAX_REPLICAS
infra/modules/containerapps.bicep       MODIFIED  — web maxReplicas 1 (param), CORTEX_DEFAULT_GROUPS env
infra/modules/purview.bicep             MODIFIED  — Reader role for the Cortex identity on a new account
infra/modules/purview-existing.bicep    NEW       — Reader role for the Cortex identity on your account
scripts/Deploy-Cortex.ps1               MODIFIED  — masked-source check, sign-in step, Purview access, register refresh, honest summary
scripts/Set-CortexAuth.ps1              NEW       — Entra sign-in + groups claim + group mapping + default group, idempotent
scripts/Set-CortexEnv.ps1               MODIFIED  — exports CORTEX_IDENTITY_PRINCIPAL_ID
scripts/Test-Cortex.ps1                 MODIFIED  — Purview counts; names the fix on a 403
scripts/bootstrap.js                    MODIFIED  — Purview access step (--only=roles), product owners, bearer helper
scripts/purview-access.js               NEW       — the Unified Catalog Policies API grant
scripts/postprovision.sh                MODIFIED  — accurate next steps
src/bff/config.js                       MODIFIED  — ask.*, foundry.extraModels, timeouts, defaultGroups, purview.timeoutMs
src/bff/adapters/purview.js             MODIFIED  — pagination, drafts shown, 403 hint, timeout, cached health, resolveDomainId
src/bff/adapters/foundry.js             MODIFIED  — ensureAgent, previous_response_id, real model catalogue, timeouts
src/bff/index/store.js                  MODIFIED  — domain slug↔GUID resolution; internal agent hidden
src/bff/services/ask.js                 REWRITTEN — live against Foundry, honest fallback, thread carry-over
src/bff/services/identity.js            MODIFIED  — default groups
src/bff/services/agents.js              MODIFIED  — new MCP tool in the allowed list
src/bff/server.js                       MODIFIED  — default groups reach the user
src/purview-mcp/server.js               MODIFIED  — list_governance_domains tool, domain by name, caching
src/web/views/ask.js                    MODIFIED  — how the answer was produced; degraded warning
src/web/views/entry.js                  MODIFIED  — catalogue status row
src/web/views/marketplace.js            MODIFIED  — "Draft in Purview" tag
src/web/views/pages.js                  MODIFIED  — default group labelled on /profile
.vscode/tasks.json                      MODIFIED  — "Configure sign-in", "Grant Purview access"
test/purview-access.test.js             NEW       — 17 tests
test/ask-live.test.js                   NEW       — 9 tests
test/identity.test.js                   NEW       — 6 tests
test/smoke.test.js                      NEW       — boots the real server, opens every page
test/register.test.js                   MODIFIED  — domain resolution, internal agent
```

**214 tests pass**, up from 163. `npm test`.

---

## 1. The Purview 403 — root cause and fix

```
Purview GET /datagovernance/catalog/businessdomains failed 403:
{"error":{"code":"Unauthorized","message":"Not authorized to access account"}}
```

The web app authenticated correctly — API Management and Foundry were green on
the same page — and was then refused by the Unified Catalog, because the Cortex
managed identity (`id-cortex`) held **no Purview role**. Your own bootstrap run
had created the nine domains as *you*; nothing had ever granted the identity
anything.

The repository said this step could not be automated ("tenant-level role groups
do not accept service principals"). That is true of the Purview *role groups*
and irrelevant here: the roles the app needs are Unified Catalog roles, and the
Unified Catalog **Policies API** assigns them, to users, groups, service
principals and managed identities alike:

```
GET  {endpoint}/datagovernance/catalog/policies?api-version=2026-03-20-preview
PUT  {endpoint}/datagovernance/catalog/policies/{policyId}?api-version=2026-03-20-preview
```

One policy per scope; one attribute rule per role; the object ids sit in a
`principal.microsoft.id` condition inside the rule. `scripts/purview-access.js`
reads the policies, adds the identity to the right rules and puts each changed
policy back — idempotent, never removing anybody. Bootstrap runs it first, as
you, before touching content:

| Scope | Roles granted to `id-cortex` | Why |
|---|---|---|
| Catalogue (`dgpolicy_datagovernanceapp_*`) | **Data Governance Administrator**, **Global Catalog Reader** | The first clears the 403; the second lets it read published products in every domain |
| Each Cortex governance domain | **Governance Domain Owner** | So the app can manage the products bootstrap creates |

Plus Azure RBAC **Reader** on the Purview account from Bicep (`purview-existing.bicep`) — control plane, least privilege, cheap.

Run it alone with `node scripts/bootstrap.js --only=roles` (after dot-sourcing
`Set-CortexEnv.ps1`), or via the VS Code task **Cortex: Grant Purview access**.
`Test-Cortex.ps1` now names this fix when it sees the error.

**What you may still see once:** the roles can take a minute to propagate. A
health check straight after the grant can be red; the next one is green.

## 2. Data products were never created

Your catalogue has the nine domains and no products. Two causes, both fixed:

- **No owner.** The create payload named no `contacts.owner`, and the catalogue
  requires at least one before it will publish. Bootstrap now adds the signed-in
  person (object id read from the token — no extra directory call), merged with
  any owner already on the product so a re-run never removes one.
- **Drafts were invisible.** The adapter queried `Published` only, so a product
  that publish had refused — created as `DRAFT`, by design — never reached the
  Marketplace, which then looked empty. Drafts are now read too, and shown with
  a **Draft in Purview** tag and a "Catalogue status" row on the entry page.
  Honest beats hidden.

Also in the adapter: the query pages at the documented ceiling of 100 (it asked
for 200 in one call), every call has a timeout, the 403 carries the fix in its
message, and health is cached for a minute so the readiness probe stops spending
the rate limit.

## 3. Ask is live

`services/ask.js` never called Foundry. It keyword-matched the register and
returned canned text that said, on screen, *"This is a seeded response — the app
is running with demo mode on"*. The documentation described it as working.

Now: Cortex decides **what the model may see**, Foundry decides **what to say**.

1. The register is scored against the question and every relevant entry is
   sorted into reachable / could not reach / answerable by a person, using the
   asker's own groups — unchanged, and still what builds the provenance panel.
2. The reachable entries' catalogue metadata (never rows — Cortex holds none)
   is passed, numbered, to a Foundry agent called **`cortex-ask`** with house
   rules: answer only from these, cite as `[n]`, say what you cannot know,
   respect minimum aggregation, treat entry text as untrusted. The agent is
   created on first use with `FOUNDRY_MODEL` (`gpt-5.4-mini`) and reused.
3. A follow-up carries `previous_response_id`, so Foundry keeps the thread;
   a follow-up that matches nothing by itself ("and how fresh is it?") inherits
   the previous turn's sources, each re-checked against the asker's access.
4. If nothing is reachable no model is called — the working is shown, as
   before. If the model cannot be reached, the register's summary is shown
   **with a warning that says so** and the reason.

The panel gains one line: *how* the answer was produced. `ASK_USE_PURVIEW_MCP=true`
attaches the Purview MCP server to the agent as a live tool instead of inline
grounding — off by default because inline is faster and has one failure mode
fewer in front of an audience.

## 4. Sign-in: automated, and everyone is staff

`scripts/Set-CortexAuth.ps1` does what §6 of the old guide asked you to do by
hand: the "Cortex" app registration, **`groupMembershipClaims = SecurityGroup`**,
a service principal, Container Apps authentication on `cortex-web` with
anonymous visitors redirected to sign in, and — optionally — the group mapping.
A client secret is minted only when authentication is first configured (or with
`-RotateSecret`), so re-running does not pile up credentials. The deploy script
runs it as step 10; `-SkipAuth` leaves it alone.

Your screenshot showed *"cleared to Official · no groups"*. In that state almost
every entry is unavailable and every "Internal only" licence reads as not
covering you. Every signed-in user is now treated as **`all-staff`** by default
(`CORTEX_DEFAULT_GROUPS`) — a signed-in person is a member of staff — while
team-scoped and cleared groups still come only from Entra. `/profile` labels the
default as configuration, not Entra. Empty string = strict mode.

## 5. One replica, on purpose

`cortex-web` could scale to three replicas while requests, Ask threads, access
requests and every published agent's record live in memory. A person publishing
an agent on one replica and reloading on another would watch it vanish.
`webMaxReplicas` is now a parameter defaulting to **1**. Persistence stays the
first item of next work.

## 6. Smaller things you would have hit

- **Model catalogue.** `listModels()` offered a hard-coded `gpt-5` that is not
  deployed to your project; choosing it passed validation and failed at agent
  creation. The catalogue is now the deployment(s) that exist: `FOUNDRY_MODEL`
  plus `FOUNDRY_MODELS`.
- **Domains named two ways.** Purview names a domain by GUID; `domains.json`,
  the MCP tool's description and a new agent's default (`corp`) name it by slug.
  Agents landed in "unclustered" and the MCP domain filter never matched.
  `resolveDomainId()` accepts either, everywhere.
- **MCP server.** A fifth tool, `list_governance_domains`; domain filter by
  name or slug; listings cached for a minute; a data product can be fetched by
  name as well as id.
- **`cortex-ask` is hidden from the Marketplace.** It is plumbing, not a part.
- **Masked source.** Files that pass through a chat or transfer tool can come
  back with credential-shaped text replaced by asterisks — *including the
  authorization header template literal (scheme word plus token)*, which still parses and then
  fails every call. Round 2 restored four such files by hand. The adapters and
  bootstrap now compose the header with a `bearer(token)` helper so the pattern
  never appears in source, and Deploy-Cortex.ps1 step 1 refuses to deploy a
  tree that contains a run of six asterisks.
- **Timeouts** on every Purview and Foundry call (`PURVIEW_TIMEOUT_MS`,
  `FOUNDRY_TIMEOUT_MS`, `FOUNDRY_RESPONSE_TIMEOUT_MS`).
- **Register refresh after bootstrap.** The deploy script posts to
  `/api/index/refresh` so the Marketplace shows the content when the script
  finishes, not fifteen minutes later.

## 7. The deployment guide

`docs/DEPLOY.md` is rewritten in the order you need it: what one command does →
before you start (tools, *your* permissions, the *identity's* permissions and
who grants each) → deploy → after the first deploy → iterating (which command
for which change) → how it fits together → troubleshooting (symptom → cause →
fix) → reference. The Key Vault discussion, which dominated the old guide while
the vault is not in the runtime path, is a section of §5 and a route-back in §7.

---

## Not verified against Azure — read before the first run

This round was written against the documented API shapes and tested against
stubs (214 tests, including a smoke test that boots the real server). Nothing
here has run against your tenant. The calls most likely to need a small
adjustment on first contact, in order:

1. **The Policies API grant.** The request and response shapes are the ones
   the reference documents, pinned in `test/purview-access.test.js`. If Purview
   rejects the `PUT`, the error text is printed with the policy id; send it back
   and it is a one-line change.
2. **Data product create with `contacts.owner`.** If publish is still refused
   the product is created as a draft and the reason is printed.
3. **`cortex-ask` creation and the first answer.** If it fails, the Ask page
   still answers from the register and prints the reason in the panel.
4. **`Set-CortexAuth.ps1`** — `az ad app update --set groupMembershipClaims`
   and `az containerapp auth microsoft update` are the two commands that vary
   most between CLI versions. Each prints the command that failed.

## Run it

```powershell
npm test                                 # 214 green, no Azure
.\scripts\Deploy-Cortex.ps1 -WhatIfResources
.\scripts\Deploy-Cortex.ps1              # steps 10 and 11 are the new ones
.\scripts\Test-Cortex.ps1                # six green; Purview may need a minute
```

Then sign in, open `/profile`, and Ask a question.
