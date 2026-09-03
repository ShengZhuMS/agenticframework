# What changed — 3 September 2026

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
