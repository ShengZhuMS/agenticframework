# Cortex — Deploy, run and iterate

**Windows 11 · VS Code · PowerShell 7.** Everything is live — there is no demo mode and no offline path.

Read in order the first time. Afterwards you will mostly need §4 (iterating) and §6 (troubleshooting).

| § | | When you need it |
|---|---|---|
| 1 | [Before you start](#1-before-you-start) | Once |
| 2 | [Deploy](#2-deploy) | First deploy, and any infrastructure change |
| 3 | [After the first deploy](#3-after-the-first-deploy) | Once, then whenever you change who can see what |
| 4 | [Iterating](#4-iterating--which-command-for-which-change) | Every day |
| 5 | [How it fits together](#5-how-it-fits-together) | When something surprises you |
| 6 | [Troubleshooting](#6-troubleshooting) | When it does not work |
| 7 | [Reference](#7-reference) | Switches, settings, teardown, demo day |

---

## What one command does

```powershell
.\scripts\Deploy-Cortex.ps1
```

Cortex **reuses your existing Azure estate** — API Management, Purview, Foundry, Key Vault, the container registry and monitoring — and creates its own small footprint in `PRDCORECORTEX001`: two container apps, a managed identity, an **Azure AI Search** service (Basic) and two **storage accounts** (sample data; application state). The script then:

1. checks your tools and that no source file has been damaged in transit;
2. signs you in to Azure;
3. reports what will be **reused** and what will be **created**;
4. checks the pinned model version is still deployable;
5. registers resource providers, installs dependencies and vendors GOV.UK Frontend;
6. provisions with `azd up` (Bicep in `infra/`) and pushes both container images;
7. reconciles the live apps (image, ingress port);
8. puts the API Management subscription key onto the web app as a secret;
9. **switches on Entra sign-in with the groups claim** (`Set-CortexAuth.ps1`);
10. **grants the Cortex identity its Purview roles** and creates the Defra content (`npm run bootstrap`), then in the same run:
    - a **Foundry project connection per MCP server**, carrying the API Management key — the fix for the agent → tool `401`;
    - **synthetic sample files** behind all 14 data products, into the sample-data account;
    - a **Purview Data Map source and scan** over them (3–10 minutes; `-NoScanWait` skips the wait), and the scanned **assets attached to each data product** in the Unified Catalog;
    - **one Azure AI Search index per data product**, built from the same files, and the Foundry connection that lets an agent query it;
11. refreshes the app's register and health-checks everything.

Nothing is left for the portal. Every part of step 10 is a `--only=` section of bootstrap and re-runs safely on its own (§4).

---

## 1. Before you start

### Tools

```powershell
winget install Microsoft.PowerShell Microsoft.AzureCLI Microsoft.Azd OpenJS.NodeJS.LTS Docker.DockerDesktop Git.Git
```

Reopen the terminal, then check:

```powershell
pwsh --version; az version; azd version; node --version; docker --version
```

Node **20 or later**. Docker Desktop must be **running** when you deploy (the script checks before it starts provisioning). If PowerShell refuses to run scripts:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

**This repository lives in a OneDrive folder.** Files that arrive by OneDrive sync, browser download or an extracted zip carry the *Mark of the Web*, and `RemoteSigned` then refuses to run them — *"…is not digitally signed. You cannot run this script on the current system."* The deploy script unblocks every script in the repository at step 1, and the azd hook runs with `-ExecutionPolicy Bypass`, so you should never see it. If it ever stops `Deploy-Cortex.ps1` itself:

```powershell
Get-ChildItem -Recurse -Include *.ps1 | Unblock-File
```

In VS Code, accept the recommended extensions (Azure Dev CLI, Container Apps, Bicep, PowerShell). Every command in this guide is also a task: **Ctrl+Shift+P → Tasks: Run Task → Cortex: …**

### Permissions *you* need

| Where | Role | Why |
|---|---|---|
| Subscription | **Contributor** + **User Access Administrator** | Create the container apps; grant the Cortex identity roles on your existing resources |
| Registry `prdcoreamlacr001` | **AcrPush** | Push the two images |
| Entra | **Application Administrator** | Create the "Cortex" app registration for sign-in |
| Purview portal | **Data Governance Administrator** | Bootstrap creates domains and grants the Cortex identity its roles *as you*. Settings → Solution settings → Unified Catalog → Roles and permissions → Data Governance Administrators |
| Purview Data Map | **Data Source Administrator**, **Data Curator** on the root collection | Registering the sample-data account and scanning it. **Bootstrap grants these to you** through the collection's metadata policy; if that is refused, add yourself: Data Map → Domains and collections → *root* → Role assignments |
| Sample-data storage account | **Storage Blob Data Contributor** | Bootstrap uploads the sample files as you. **The Bicep grants it** to whoever deploys (`DEPLOYER_PRINCIPAL_ID`, filled in by the script). An Owner without it still gets `403` on a blob write |
| Key Vault `prdcorekveus` | Key Vault Secrets Officer | Only if the vault is used (§5). Missing it is a warning, not a failure |

A sandbox Global Administrator has the first four. The Purview ones are Purview-internal roles that Global Administrator does **not** confer automatically — if bootstrap answers `403` to *your* account, this is why (§6).

One thing to check on the **Foundry account** itself: it needs a **system-assigned managed identity** (Azure portal → `prdcorefdryeus001` → Identity → System assigned → On). That identity is what an agent signs in to Azure AI Search with; the Bicep grants it the search roles, and the deploy script warns if it is missing.

### Permissions the *Cortex identity* gets — all automated

`id-cortex` is a user-assigned managed identity created by the Bicep. Everything it needs is granted for it:

| Resource | Role | Granted by |
|---|---|---|
| API Management | API Management Service Contributor | Bicep (`apim-existing.bicep`) |
| Foundry account | Foundry User, Foundry Agent Consumer, **Foundry Project Manager** (creates project connections — nothing wider than the project) | Bicep (`foundry-existing.bicep`) |
| Purview account | Reader (control plane) | Bicep (`purview-existing.bicep`) |
| **Purview Unified Catalog** | **Data Governance Administrator, Global Catalog Reader** (catalog level); **Governance Domain Owner** on each Cortex domain | **bootstrap** (`scripts/purview-access.js`), through the Unified Catalog Policies API |
| Purview Data Map | Data Source Administrator, Data Curator, Data Reader on the root collection | bootstrap (`--only=data`), through the collection metadata policy |
| Azure AI Search | Search Service Contributor, Search Index Data Contributor | Bicep (`search.bicep`) |
| Sample-data storage | Storage Blob Data Contributor | Bicep (`data.bicep`) |
| Container registry | AcrPull | Bicep |
| Key Vault | Key Vault Secrets User | Bicep (only matters in Key Vault mode) |

Two other identities are granted by the same Bicep, because the data chain runs through them: the **Purview account's** identity gets Storage Blob Data Reader on the sample-data account (it runs the scan), and the **AI Search service's** identity gets the same (it runs the indexers). The **Foundry account's** identity gets Search Index Data Contributor and Search Service Contributor on the search service (the `azure_ai_search` tool signs in as it).

The Purview row is the one that matters most. Without it the app authenticates and is then refused: `403 Not authorized to access account` — shown on the Help page as **Purview UNAVAILABLE**. Older notes in this repository said it could not be automated; it can, and bootstrap does it.

### See what will happen

```powershell
git clone <your-repo> cortex
cd cortex
.\scripts\Deploy-Cortex.ps1 -WhatIfResources
```

Changes nothing. Expect every existing resource to be reported as `REUSE`, the two container apps and the identity as `CREATE`, and a line saying the pinned model is deployable:

```
REUSE   API Management   prdcoreapimneu001 (PRDCOREAPIM001)
REUSE   Purview          prdcorepurvieweus (PRDCOREPVW001)
REUSE   Foundry          prdcorefdryeus001/prdcorefdryproj-default
REUSE   Key Vault        prdcorekveus (PRDCOREPVW001)
REUSE   Registry         prdcoreamlacr001 (PRDCOREAML001)
REUSE   Monitoring       prdcoreamlneu08774392429 (PRDCOREAML001)
CREATE  Container Apps   cortex-web, cortex-purview-mcp (PRDCORECORTEX001)
CREATE  Managed identity id-cortex (PRDCORECORTEX001)
CREATE  AI Search        srch-cortex-<id> (basic) (PRDCORECORTEX001)
CREATE  Storage          stcortexdata<id> (sample data), stcortexstate<id> (state share) (PRDCORECORTEX001)
OK      gpt-5.4-mini 2026-03-17 is deployable (GenerallyAvailable)
```

The last two are new in round 4 and cost a few pounds a month between them (Basic search is the bulk of it). `-NoSearch` and `-NoData` leave them out — the app then describes data products but cannot read their rows, and state lives in memory again.

Anything reported `CREATE` that you expected to `REUSE` means a name or resource group is wrong. Every one is a parameter:

```powershell
.\scripts\Deploy-Cortex.ps1 -WhatIfResources -ApimName my-apim -ApimResourceGroup my-rg
```

---

## 2. Deploy

```powershell
.\scripts\Deploy-Cortex.ps1
```

About 10 minutes when reusing the estate. The end of the run tells you what was automated and where to look next.

### Re-running is the design

Run the same command as often as you like. Every step reconciles rather than recreates:

| Situation | What happens |
|---|---|
| The apps are already running your code | The live image is read back and fed into the template, so a re-provision never rolls them back to the placeholder |
| The model version has been retired | Checked before provisioning; the account's deployable versions are listed |
| The resource group is in a different region from `-Location` | Its real location is read and reused |
| You lack Key Vault Secrets Officer | Seeding is skipped with a warning; the app runs on direct configuration |
| A name is soft-deleted | Detected first, recover/purge command printed |
| Sign-in is already configured | Reused; no new client secret is minted |
| The Cortex identity already holds its Purview roles | Reported as held; nothing is written |
| The domains and data products already exist | Updated in place, never duplicated |
| A Foundry connection for an MCP server exists | Reported as already there; the key is rewritten only if the target changed |
| The sample files, Data Map source and scan exist | Files are rewritten (they are generated from a fixed seed, so nothing changes); the source and scan are kept; a new scan run starts |
| An asset is already attached to its data product | Skipped |
| An index, data source or indexer exists | Updated in place (a PUT on a fixed name); the indexer is run again |

### If it fails

The script stops at the failing step and says what to check. Nothing it does is destructive except `-Reset`. Fix the cause and run the same command again — or, if provisioning succeeded and a later step failed, `-SkipProvision` resumes from step 8. §6 has the specific failures.

---

## 3. After the first deploy

### a. Check it

```powershell
.\scripts\Test-Cortex.ps1
```

```
  OK    cortex-web  web-cortex:azd-deploy-...
  OK    cortex-purview-mcp  purview-mcp-cortex:azd-deploy-...
  OK    App and register
        23 entries across 9 domains
  OK    Key Vault
        Direct configuration — 14 values from the environment, no vault in use
  OK    Purview
        9 domains, 14 data products (14 published)
  OK    API Management
  OK    Foundry
  OK    Azure AI Search (data indexes)
  OK    Sample-data storage
  OK    Purview Data Map
  OK    Application state (file share)
  OK    Purview MCP server (5 tools)
```

Purview roles can take a minute to propagate after bootstrap grants them. If Purview alone is red straight after a deploy, wait a minute and run it again. The Help page (`/help`) shows the same seven services with the underlying error text when one is not working.

### b. Sign in

Open the web URL. You are redirected to Microsoft sign-in, then to the Marketplace. Open **`/profile`** ("What can I see?" in the header): it lists your groups and how many entries fall into each visibility state.

Every signed-in user is treated as a member of **`all-staff`** — the default group. That is what makes "Open to all staff" entries available to you on a tenant with no group mapping. The profile page marks it as coming from configuration, not Entra.

> Signed in *before* the groups claim was switched on? Your token predates it. Sign out and back in.

### c. Map your Entra groups (optional, but it is the demo)

Access rules read group **names** (`waste-crime`, `analysts`, `cortex-official-sensitive`); Entra sends group **object ids**. Map one to the other once:

```powershell
.\scripts\Set-CortexAuth.ps1 -GroupMap 'waste-crime=Waste Crime Observatory','analysts=Data Analysts'
```

The mapping is written to the azd environment (so a re-provision keeps it) and to the live app (so it applies now). To create the groups and add yourself — for the "same page, different eyes" moment — add `-CreateGroups`. To turn the default group off and rely on Entra alone: `-DefaultGroups ''`.

If `/profile` lists **unmapped group ids**, that is the groups you are already in, shown by object id because nothing has named them yet. It is not a fault — an id only affects access once a rule refers to it. To name them all after their Entra display names:

```powershell
.\scripts\Set-CortexAuth.ps1 -MapMyGroups
```

Mappings are additive across runs, and an explicit `-GroupMap` alias always wins over an automatic name.

The special group names the rules understand:

| Group name | Effect |
|---|---|
| `all-staff` | Covers "Internal only" licences and "Open to all staff" entries |
| `cortex-official-sensitive` | Clearance to Official–Sensitive |
| `cortex-commercial-licence` | Covers seat-limited and commercial licences |
| `cortex-team-<name>` | Display team name only; no access effect |
| anything else | Matches an entry whose allowed groups name it (e.g. `waste-crime`) |

### d. Invite a colleague — or your own account from another tenant

Cortex signs people in through **this** tenant's Entra ID, and its app registration is single-tenant. Anyone whose account lives elsewhere — a Defra colleague, a partner, your own corporate account — comes in as a **guest** (Entra B2B): they keep their own password and MFA, this tenant holds only a guest object for them, and Cortex sees them exactly as it sees a member, by the groups they are in.

```powershell
.\scripts\Add-CortexUser.ps1 -Email shengzhu@microsoft.com
.\scripts\Add-CortexUser.ps1 -Email colleague@defra.gov.uk -Groups 'Waste Crime Observatory'
```

The script finds the person if they are already in the tenant, otherwise sends Microsoft's invitation email with Cortex as the landing page; `-Groups` adds them to Entra groups (which must also be mapped with `Set-CortexAuth.ps1 -GroupMap` to mean anything to the rules); `-NoEmail` prints the redemption link for you to pass on; `-Resend` sends the invitation again. Idempotent.

What the invitee sees: an email from *Microsoft Invitations* → **Accept** → the Cortex sign-in → on the first visit only, a prompt to accept this organisation's terms → the Marketplace. They are treated as `all-staff` like everyone signed in, so they see the "Open to all staff" entries; anything more comes from groups. Tell them to use a **private browser window** if the computer is already signed in to Cortex as somebody else.

**MFA for guests — do this once, before the first invitee signs in.** This tenant's baseline Conditional Access has two policies for external users ("Microsoft partners and vendors"): one **requires MFA**, the other **blocks security-info registration**. Together they mean a guest must do MFA but cannot set up a method here — they are stopped at sign-in and never shown the set-up screen. The intended answer is to accept the MFA they already did in their home tenant:

```powershell
.\scripts\Add-CortexUser.ps1 -Email <address> -TrustHomeMfa
```

or by hand: Entra admin center → External Identities → Cross-tenant access settings → Default settings → Inbound access settings → Edit inbound defaults → **Trust settings** → tick **Trust multifactor authentication from Microsoft Entra tenants**. The invitee then signs out fully and signs in again. `Add-CortexUser.ps1` checks this setting on every run and warns while it is off. It only helps when the home tenant *did* perform MFA (a Microsoft or Defra account always does); for a tenant that did not, give the tester a **member** account in this tenant instead — members are not targeted by those two policies.

Two things this cannot do. It cannot override the invitee's **home tenant**: if that tenant blocks guest access to this one, redemption stops with an AADSTS error and the fix is on their side (or use an account that lives here). And it does not make the app multi-tenant — signing your corporate account in *directly* would need its tenant to consent to a sandbox app and would put that tenant's group ids in the token, which nothing here maps. Guest is the right shape.

### e. Walk the golden path once

Marketplace → a data product → **The data behind it** (the scanned file, its columns, the index) → Build an agent with it → test it → **Open a chat window** → publish → it reappears in the Marketplace with a **Chat** link. Then **Ask a question** — the answer is written by the `cortex-ask` agent in Foundry from the catalogue entries you can reach, with the provenance panel underneath. Ask is live: if the model cannot be reached the page says so and falls back to the register's own summary.

When you test an agent, the panel under the answer now lists **Tools this answer used** — every MCP call, approved by Cortex on your behalf and recorded — and a failure reads as a sentence about what to do, with the raw text folded underneath.

### f. Look at what bootstrap put behind the products

Three places, all real:

| Where | What you see |
|---|---|
| Storage account `stcortexdata…` → container `products` | One folder per data product: `<id>.csv` (the data, header row first) and `README.md` (the data dictionary). All synthetic, generated by `scripts/sample-data.js` from a fixed seed — no real people, holdings or measurements |
| Purview portal → Data Map → Data sources | `cortex-sample-data` (ADLS Gen2) with scan `cortex-sample-scan`. Open a run to see the assets discovered, each CSV with its extracted schema and any classifications the system ruleset applied |
| Purview portal → Unified Catalog → a data product → **Data assets** | The scanned file attached to the product. This is the join Cortex reads: product → asset → file |
| Azure portal → `srch-cortex-…` → Indexes | `cortex-<product-id>` for each product, with the row count; Indexers shows the last run |

In Cortex, a data product's entry page has the same chain under **The data behind it**, plus **Build the index now** for a product whose index is missing (or after you replace its file). An agent built on the product gets an `azure_ai_search` tool for its index and instructions naming its columns; an agent built *before* the index existed picks it up with **Rebuild tools** on its page.

### g. Automate a task

**Automate a task** in the navigation is real now. Set one up: pick an agent and the question it is asked, or an approved request method, how often, and what the drafts are for. It runs on a timer inside the web app and files a **draft** — with its sources and the tools it used — into its run history. It writes nothing anywhere else; that switch does not exist in this phase. **Run it now** on the page shows one in front of an audience without waiting; *Every 15 minutes* is there for the same reason.

---

## 4. Iterating — which command for which change

| You changed | Run | Time |
|---|---|---|
| Application code (`src/`) | `.\scripts\Deploy-Cortex.ps1 -AppOnly` | ~2 min. Builds and pushes both images, touches nothing else |
| Content (`bootstrap/*.json`) | `. .\scripts\Set-CortexEnv.ps1` then `npm run bootstrap` | ~1 min plus the scan wait. Idempotent. `-- --no-wait` to skip the scan wait |
| Only Purview permissions | `. .\scripts\Set-CortexEnv.ps1` then `node scripts/bootstrap.js --only=roles` | seconds |
| Foundry connections for the MCP servers (after publishing skills, or an agent says it "could not sign in to one of its tools") | `node scripts/bootstrap.js --only=connections` | seconds |
| The sample data (`scripts/sample-data.js`) | `node scripts/bootstrap.js --only=data` (uploads, rescans, re-attaches) then `--only=search` (re-indexes) | 5–15 min, mostly the scan |
| The scan finished after a `--no-wait` run | `node scripts/bootstrap.js --only=link` | seconds |
| Only the search indexes | `node scripts/bootstrap.js --only=search` | ~1 min; rows appear a minute or two later |
| Who can see what (groups) | `.\scripts\Set-CortexAuth.ps1 -GroupMap ...` | seconds |
| Infrastructure (`infra/`) | `.\scripts\Deploy-Cortex.ps1` | ~10 min |
| A setting the Bicep reads (`azd env set X y`) | `.\scripts\Deploy-Cortex.ps1 -SkipBootstrap` | ~5 min |
| The model | `.\scripts\Deploy-Cortex.ps1 -ModelName gpt-5-mini -ModelVersion 2025-08-07 -UpgradeModel` | ~5 min |

Two rules that keep iteration safe:

- **The leading dot on `Set-CortexEnv.ps1` is load-bearing.** It loads the deployment's configuration into *your* session so a local `node` process can talk to your Azure resources. Without it bootstrap stops with "Missing required configuration".
- **`npm test` before you push.** 289 tests, no Azure needed, about 20 seconds. `node scripts/bootstrap.js --dry-run` validates content changes the same way, and `node scripts/sample-data.js --list` shows what the generator would produce.

Running the app on your machine against the real back ends:

```powershell
.\scripts\Start-Local.ps1 -Groups all-staff,waste-crime,analysts
```

Or **F5** in VS Code. There is no Easy Auth in front of a local process, so `ALLOW_UNAUTHENTICATED=true` simulates an identity with the groups you pass. Never set it on a deployed app. Anything you publish locally is published for real.

---

## 5. How it fits together

### The two container apps

| App | Image | Serves | Why separate |
|---|---|---|---|
| `cortex-web` | `Dockerfile` | The GOV.UK front end and the BFF on port 3000 | The front door |
| `cortex-purview-mcp` | `Dockerfile.mcp` | `/mcp` and `/health` on port 3000 | A Foundry agent cannot reach the catalogue any other way. Called by agents, not browsers |

Both are declared as services in `azure.yaml`, so `azd deploy` builds and pushes both. Both run `minReplicas: 1` — an MCP client, or a CTO, gives up long before a cold container starts. `cortex-web` also runs **`maxReplicas: 1`**, deliberately: application state — requests, Ask threads, chats, automations, access requests and the record of what an agent was built from — is a set of JSON files on an **Azure Files share mounted at `/data`** (`CORTEX_STATE_DIR`), written by one replica. It survives restarts and redeploys now; the route to a real store when the numbers grow is in `HANDOVER.md`.

### The data behind a data product

```
Unified Catalog data product  ──relationship──►  Unified Catalog data asset
        (what it is)                                 (source.assetId)
                                                          │
                                                Data Map asset  adls_gen2_path
                                                (schema, classifications, from the scan)
                                                          │
                                   stcortexdata…/products/<id>/<id>.csv   ◄── indexer ──  AI Search index cortex-<id>
                                                                                              ▲
                                                                        Foundry agent ── azure_ai_search tool (project connection cortex-search, keyless)
```

Bootstrap builds the whole chain (`--only=data` then `--only=search`); `services/grounding.js` walks it at runtime. The app never holds the data: the file sits in storage, the Data Map describes it, the index is read by Foundry through a project connection. `cortexDataFolder` and `cortexSearchIndex` are written onto each data product as managed attributes so the app can find its folder and index without a second lookup. Products without an index are still usable — an agent built on them is told, in its instructions, that it can describe the product but not read its rows.

### Agents and their tools

Every Cortex-published MCP server sits behind API Management and needs `Ocp-Apim-Subscription-Key` on every call. Foundry will not carry a raw header on an MCP tool, so each server gets a **project connection** (category RemoteTool, CustomKeys) holding the key, and the tool names the connection through `project_connection_id`. One connection per server — when the connection's target and the tool's URL differ, Foundry uses the connection's, so a shared one would send every call to the same place. Connections are created when a skill is bootstrapped, when an agent is published, and again (idempotently) whenever an agent is built or rebuilt; the Cortex identity holds Foundry Project Manager on the account for this.

Every MCP tool is registered with `require_approval: 'always'`. A tool call therefore comes back to Cortex as an approval request; Cortex approves it server-side, records the server, tool and arguments, and continues the same response (up to `FOUNDRY_MAX_APPROVAL_ROUNDS`, default 6). The record is shown under the answer as **Tools this answer used**. That is the approval gate as this phase implements it: visible and attributable, not a button mid-conversation.

### Chat

`/agent/<id>/chat` is a server-rendered conversation in its own window — no client JavaScript, like every other page. Each turn is a Responses call with `previous_response_id`, so Foundry keeps the thread; Cortex keeps the transcript and provenance for the person who had it. `CORTEX_CHAT_POLICY` is `all-staff` in this phase (every signed-in person may chat with every agent); `visibility` applies the Marketplace rules instead. The check runs on every turn.

### Automations

`services/automations.js`. Two kinds — ask a named agent the same question, or re-run an approved request method through Ask inside the owner's captured permissions. A timer in the web app (`CORTEX_AUTOMATION_TICK_SECONDS`, default 60) runs whatever is due; each run is a draft in the automation's history and nothing else. Propose-only is structural: there is no field that could turn writing on.

### Identity and configuration

One user-assigned managed identity, `id-cortex`, holds every permission (table in §1). No secrets in code.

Configuration reaches the apps one of two ways, and the deploy script picks:

| `-ConfigSource` | What happens |
|---|---|
| `auto` (default) | Probes the vault. Public access disabled, or no data-plane answer → `direct`. Otherwise `keyvault` |
| `direct` | Endpoints and names go onto the container apps as environment variables; the three sensitive values (APIM key, App Insights connection string, Entra client secret) as Container Apps secrets |
| `keyvault` | The apps read `KEYVAULT_NAME` at startup |

Your sandbox vault has public network access disabled, and Azure Container Apps is not a Key Vault trusted service, so `auto` chooses **`direct`** — the vault is still *seeded* (an ARM deployment is a control-plane write) but never *read*. `Test-Cortex.ps1` prints which mode is live. Direct mode is fine for a sandbox and should not go to production; §7 has the route back to the vault.

`SECRET_CATALOGUE` in `src/bff/adapters/keyvault.js` is the contract between the two modes. Add a value there **and** in `infra/modules/containerapps.bicep`, or it works in one mode and not the other.

### Sign-in

Container Apps built-in authentication terminates Entra sign-in before a request reaches the process and injects the claims as headers. `Set-CortexAuth.ps1` configures it: the app registration, the **groups claim** (`groupMembershipClaims = SecurityGroup`), a client secret minted once, redirect for anonymous visitors. It lives outside the Bicep, so a re-provision does not touch it.

Four paths are **excluded** from sign-in because machines call them: `/api/health*` (the deploy and test scripts), `/api/index/refresh` (bootstrap) and `/shim/*` (API Management, on behalf of a published agent). Everything a person sees is behind sign-in. The shim trusts API Management's subscription key rather than checking one itself — acceptable for a proof of concept, listed in `HANDOVER.md` for the full build.

Group membership is the whole governance model. `CORTEX_GROUP_NAMES` maps ids to names; `CORTEX_DEFAULT_GROUPS` (default `all-staff`) is what every signed-in user is treated as holding. Both are Bicep parameters, so a re-provision keeps them.

### Purview

The app talks to the **Unified Catalog** at `https://api.purview-service.microsoft.com` (the `{account}.purview.azure.com` host is the legacy form) with api-version `2026-03-20-preview` — there is no GA version. Bootstrap writes the nine governance domains and fourteen data products there, and reads them back through the same API.

Data products are created **published**. If the catalogue refuses (it enforces preconditions the API does not document — an owner is required, and bootstrap now names you as one), the product is created as a **draft** instead and the Marketplace shows it with a "Draft in Purview" tag rather than hiding it. Publish those by hand in the portal when you want the tag gone.

Roles are assigned through the Unified Catalog *Policies* API by bootstrap, as you (§1). The **Data Map** plane is granted the same way by `--only=data`: Data Source Administrator, Data Curator and Data Reader on the root collection, for you and for the Cortex identity, through the collection's metadata policy. The Data Map itself is reached at `https://<account>.purview.azure.com` — sources and scans under `/scan`, assets under `/datamap/api` — and the sample-data account is registered there as `cortex-sample-data` with a system-ruleset scan that runs as the Purview account's own identity.

### The model

Pinned: `gpt-5.4-mini` version `2026-03-17`, with `versionUpgradeOption: OnceCurrentVersionExpired`. The first live deployment failed because the template named a model with **no version**, ARM resolved the account's current default, and that default had moved onto a deprecating build (`ServiceModelDeprecating`). Both are now parameters, and the script checks the account's catalogue before provisioning.

The approved model catalogue the Build page offers is the deployment(s) that exist: `FOUNDRY_MODEL`, plus any in `FOUNDRY_MODELS` (comma-separated). A model that is not deployed is not offered, because choosing it would fail at agent creation.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Help page: **Purview UNAVAILABLE — 403 Not authorized to access account** | The Cortex identity holds no Unified Catalog role | `. .\scripts\Set-CortexEnv.ps1` then `node scripts/bootstrap.js --only=roles`. Wait a minute, reload |
| Bootstrap: **403** on `businessdomains` or `policies` to *you* | Your account is not a Data Governance Administrator in Purview | Purview portal → Settings → Solution settings → Unified Catalog → Roles and permissions → add yourself. Re-run |
| Bootstrap: `No catalog-level policy (dgpolicy_datagovernanceapp_*) was returned` | Same as above, or the tenant is not on the new Purview portal | Same fix; check the portal shows "Unified Catalog" |
| Bootstrap: `created as DRAFT — publish refused` | The catalogue's publish preconditions were not met | Expected sometimes. Products still show, tagged Draft. Publish in the portal |
| Bootstrap: **Missing required configuration** listing eight values | You ran it without loading config into the session | `. .\scripts\Set-CortexEnv.ps1` — with the leading dot — then `npm run bootstrap` |
| **`Continuous access evaluation resulted in challenge … TokenCreatedWithOutdatedPolicies`** | Your Azure CLI token was issued before your directory roles changed (you just became Application Administrator, say) and Entra refuses it. On Windows a plain `az login` often returns the *same* token via the broker | `Set-CortexAuth.ps1` and `Deploy-Cortex.ps1` clear the cache, sign you in again and fall back to the device-code flow. By hand: `az account clear` → `az login --use-device-code` → `az account set --subscription <id>` |
| Set-CortexAuth: **Sign-in points at client …, which no longer exists** | The app registration Easy Auth uses was deleted; nobody can sign in | Let the script finish — it creates a new one and re-points the app |
| Health checks all **redirected to sign-in** / all `ok=false` at once | Sign-in is guarding `/api/health*`; the checks were reading the login page | `Set-CortexAuth.ps1` excludes the machine paths. Then `Test-Cortex.ps1` |
| Bootstrap: skills fail with **500 InternalServerError** on `…-mcp/tools/invoke` | The old request shape. An MCP server must be created with its tools **inline** (`type: 'mcp'` + `mcpTools`) in one PUT; the child `/tools` resource does not work and a server created without tools silently loses its type | Fixed: one PUT, verified after. A type-null leftover is deleted and recreated. Re-run `node scripts/bootstrap.js --only=apim` |
| Invitee: **AADSTS…** when accepting the invitation, or "your organisation does not allow you to access…" | Their home tenant's cross-tenant access settings block guest access to this tenant | Nothing here can change it. Use an account that lives in this tenant, or ask their tenant admin |
| Invitee: **stopped by "Require multifactor authentication"**, never offered MFA set-up. Sign-in log: *Multifactor authentication for Microsoft partners and vendors — Failure* and *Security info registration for Microsoft partners and vendors — Block — Failure* | This tenant requires MFA of guests and blocks them from registering a method here | Trust the home tenant's MFA: `Add-CortexUser.ps1 -Email <address> -TrustHomeMfa` (or the Trust settings tab of inbound cross-tenant access defaults). Sign out fully, sign in again. If their home tenant did no MFA, use a member account in this tenant |
| Invitee: signs in and lands on the **wrong account** | The browser already holds another Cortex session | Private browser window, or sign out at `/.auth/logout` first |
| Any script: **`'$select' is not recognized as an internal or external command`** | A Graph URL with `&` reached cmd.exe through `az`, which split it into two commands | Fixed (parameters go through `--uri-parameters`, never in the URL). If you see it, you have an old copy of `Add-CortexUser.ps1` or `Set-CortexAuth.ps1` — copy them again and `Unblock-File` |
| `Add-CortexUser.ps1`: **Authorization_RequestDenied** / 403 | You lack Guest Inviter / User Administrator in this tenant | Get the role, or invite from the Entra admin centre (Users → New user → Invite external user) with the Cortex URL as redirect |
| `/profile` lists **N unmapped group ids** | Entra sends group object ids; the rules read names. Nothing is broken — an id only matters once a rule refers to it | `.\scripts\Set-CortexAuth.ps1 -MapMyGroups` names every group you are in after its display name. `-GroupMap 'waste-crime=<Entra group>'` gives one a name a rule uses |
| `/profile` says **no named groups** | The token predates the groups claim, or the group ids are unmapped | Sign out and in. Map ids with `Set-CortexAuth.ps1 -GroupMap` |
| Marketplace looks almost empty; entries say "Licence does not cover you" | Strict mode with no group mapping | `Set-CortexAuth.ps1 -DefaultGroups all-staff`, or map groups |
| Page says **Sign-in is not configured** | Authentication is not on in front of the app | `.\scripts\Set-CortexAuth.ps1` |
| Ask shows **The model could not be reached** | Foundry refused or timed out; the reason is on the page | Check `/api/health/foundry`; the identity needs Foundry User on the account (Bicep grants it) |
| Agent test: **The agent could not sign in to one of its tools** — detail says `Authentication failed when connecting to the MCP server … 401 Access denied due to missing subscription key` | The MCP tool has no Foundry project connection carrying the API Management key (agents built before round 4, or bootstrap `--only=connections` never ran) | **Rebuild tools** on the agent's page, or `node scripts/bootstrap.js --only=connections` then rebuild. Needs `FOUNDRY_ACCOUNT_NAME` / `FOUNDRY_PROJECT_NAME` / `FOUNDRY_RESOURCE_GROUP` and the APIM key in the environment — `Set-CortexEnv.ps1` loads them |
| Bootstrap connections: **403 AuthorizationFailed** on `…/projects/…/connections/…` | The caller lacks `Microsoft.CognitiveServices/accounts/projects/*` on the Foundry account | For the app: re-provision (Bicep grants Foundry Project Manager to `id-cortex`). For you: Contributor on the Foundry account |
| Bootstrap data: **Storage PUT … 403** | You hold no data-plane role on the sample-data account | Re-run the deploy script (it passes your object id as `DEPLOYER_PRINCIPAL_ID`), or `az role assignment create --assignee <you> --role "Storage Blob Data Contributor" --scope <account id>` |
| Bootstrap data: **Data Map … 403** on `datasources` or `scans` | You are not a Data Source Administrator on the collection | Bootstrap tries to grant it first; if that too is refused, Purview portal → Data Map → Domains and collections → root → Role assignments → add yourself to Data source admins and Data curators |
| Scan **Failed** | Usually the Purview account identity cannot read the storage account | Confirm the account has a system-assigned identity and Storage Blob Data Reader on `stcortexdata…` (Bicep grants it); re-provision, then `--only=data` |
| Bootstrap link: **the Data Map has no asset for … yet** | The scan has not finished, or found nothing | Wait for the run to show Succeeded in the portal, then `node scripts/bootstrap.js --only=link` |
| Bootstrap search: **the Basic tier allows 15** | More than 15 indexes on the service | `azd env set SEARCH_SKU standard` and re-provision, or delete indexes you do not need |
| Entry page: **Search not configured** / no "Build the index now" | `SEARCH_ENDPOINT` is empty on the web app | Deployed with `-NoSearch`; re-run without it |
| Agent answers but never cites rows | The agent was built before the index existed | **Rebuild tools** on the agent's page. The side panel lists which products are indexed and which are described only |
| Health: **Application state — memory** on a deployed app | The Azure Files share is not mounted (`CORTEX_STATE_DIR` empty) | Deployed with `-NoData`; re-run without it. State is lost on each restart until then |
| Foundry account: **no system-assigned identity** warning from the deploy script | The account was created without one | Azure portal → the Foundry account → Identity → System assigned → On; re-run the deploy script so the Bicep grants the search roles |
| Build → create agent fails | The model chosen is not deployed | Only deployed models are offered now; check `FOUNDRY_MODEL` matches a deployment |
| An app serves the Container Apps welcome page or a 502 | Placeholder image, or ingress port ≠ 3000 | `.\scripts\Deploy-Cortex.ps1 -AppOnly`; the script also corrects the port |
| **ServiceModelDeprecating** | The pinned model version is no longer deployable | `-WhatIfResources` lists what the account accepts; pin one with `-ModelVersion` |
| **AuthorizationFailed** on a role assignment | You lack User Access Administrator | Get the role, then re-run with `-SkipProvision` |
| `A resource with this name already exists or is in a conflicting state` | Usually a soft-deleted Key Vault or Foundry account | The script prints the recover/purge command |
| `Preprovision-Check.ps1` **is not digitally signed. You cannot run this script** | The file carries the Mark of the Web (OneDrive sync, download, extracted zip) and PowerShell's policy is `RemoteSigned` | Fixed: the deploy script unblocks scripts at step 1 and the hook runs with `-ExecutionPolicy Bypass`. If you see it, you have an old `azure.yaml` — re-run the deploy script |
| `imgId: The system cannot find the file specified` on both services | Not a Docker fault. azd builds images in parallel with provisioning and **cancelled** the builds when another step failed (usually the one above) | Fix the other error and re-run |
| **Masked credential placeholders found in the source** | A file came back from a chat or transfer tool with a run of `*` where a value was | Restore the file from git. The pattern to look for is six asterisks |
| `spawn az ENOENT` / `spawn EINVAL` locally | Windows CLI spawn traps | Fixed in `token.js`; if you see it, you have an old copy |
| Docker errors mid-provision | Docker Desktop not running | Start it. The script now checks first |
| `RoleAssignmentExists` | — | Harmless |

Where to look: `/api/health`, `/api/health/purview`, `/api/health/datamap`, `/api/health/apim`, `/api/health/foundry`, `/api/health/search`, `/api/health/storage`, `/api/health/state`, `/api/health/keyvault` return JSON with the underlying error text. `Test-Cortex.ps1` reads them for you.

---

## 7. Reference

### Deploy-Cortex.ps1 switches

| Switch | Use it when |
|---|---|
| `-WhatIfResources` | You want the plan. Changes nothing |
| `-AppOnly` | Code changed, infrastructure did not. The fast loop |
| `-SkipProvision` | Provisioning already succeeded; resume from step 8 |
| `-SkipBootstrap` | Do not touch Purview content or roles this run |
| `-SkipAuth` | Do not touch sign-in this run |
| `-SkipHealthCheck` | Deploying into something not up yet |
| `-GroupMap 'alias=Group name',...` | Map Entra groups onto access-rule names (passed to `Set-CortexAuth.ps1`) |
| `-DefaultGroups 'all-staff'` | What every signed-in user is treated as. `''` for strict mode |
| `-ConfigSource auto\|keyvault\|direct` | See §5 |
| `-ModelName`, `-ModelVersion`, `-ModelDeploymentName`, `-ModelSku`, `-ModelCapacity`, `-UpgradeModel` | The model. See §5 |
| `-ForceSeedKeyVault` | The role check is wrong and you know you can write secrets |
| `-NoData` | Do not create the sample-data account or the state share (no data behind products; state in memory) |
| `-NoSearch` | Do not create the AI Search service (agents describe products but cannot read rows) |
| `-SearchSku free\|basic\|standard` | Search tier. Basic (default) holds 15 indexes |
| `-ChatPolicy all-staff\|visibility` | Who may chat with an agent. `all-staff` this phase |
| `-NoScanWait` | Start the Data Map scan and carry on; run `node scripts/bootstrap.js --only=link` when it has finished |
| `-Reset` | Delete the Cortex resource group and the local azd environment, after typing the group name |

Every resource name and group is also a parameter: `-ApimName`, `-ApimResourceGroup`, `-PurviewName`, `-PurviewResourceGroup`, `-FoundryAccountName`, `-FoundryProjectName`, `-FoundryResourceGroup`, `-KeyVaultName`, `-KeyVaultResourceGroup`, `-RegistryName`, `-RegistryResourceGroup`, `-LogAnalyticsName`, `-AppInsightsName`, `-MonitoringResourceGroup`, `-CortexResourceGroup`, `-EnvironmentName`, `-Location`.

### The other scripts

| Script | Does |
|---|---|
| `Set-CortexAuth.ps1` | Sign-in, groups claim, group mapping, default group. Idempotent. `-MapMyGroups` names every group you are in; `-GroupMap` names specific ones; `-CreateGroups` creates them; `-RotateSecret` mints a new client secret |
| `Add-CortexUser.ps1` | Give a person access: finds them or sends a B2B guest invitation with Cortex as the landing page. `-Groups` adds them to Entra groups; `-NoEmail` prints the redemption link; `-Resend` re-invites; `-TrustHomeMfa` makes this tenant accept guests' home-tenant MFA (checked on every run) |
| `Set-CortexEnv.ps1` | **Dot-source it.** Loads the deployment's configuration into the session for running bootstrap by hand. Nothing written to disk |
| `bootstrap.js` | `npm run bootstrap`. `--only=roles\|purview\|apim\|connections\|data\|link\|search`, `--no-wait`, `--principal=<oid>`, `--skip-roles`, `--dry-run`, `--no-adopt`. The data sections live in `bootstrap-data.js` |
| `sample-data.js` | The synthetic data generator. `--list` shows products and row counts; `--out <folder>` writes the CSVs and dictionaries locally to look at |
| `Test-Cortex.ps1` | Health-check a deployment. `-Local` runs the unit tests instead |
| `Start-Local.ps1` | Run on your machine against real Azure. `-Groups a,b,c` |
| `Preprovision-Check.ps1` | azd hook: guards a bare `azd up` against the model and placeholder-image traps |

### Application settings

Set on the container apps by the Bicep (direct mode) or read from Key Vault. Change a value with `azd env set NAME value` and re-provision, or `az containerapp update --set-env-vars` for an immediate, non-durable change.

| Setting | Default | Meaning |
|---|---|---|
| `PURVIEW_ENDPOINT` | `https://api.purview-service.microsoft.com` | Unified Catalog host |
| `PURVIEW_API_VERSION` | `2026-03-20-preview` | Pinned |
| `PURVIEW_TIMEOUT_MS` | `30000` | Per call |
| `APIM_API_VERSION` | `2025-09-01-preview` | MCP server management needs the preview |
| `FOUNDRY_PROJECT_ENDPOINT` | from Bicep | `https://<account>.services.ai.azure.com/api/projects/<project>` |
| `FOUNDRY_MODEL` | deployment name | The default model; the first entry of the approved catalogue |
| `FOUNDRY_MODELS` | — | Further deployed models to offer, comma-separated |
| `FOUNDRY_RESPONSE_TIMEOUT_MS` | `90000` | A model answer |
| `ASK_AGENT_NAME` | `cortex-ask` | The Foundry agent that answers the Ask page. Created on first use |
| `ASK_USE_PURVIEW_MCP` | `false` | Attach the Purview MCP server to the Ask agent as a tool, instead of grounding inline |
| `CORTEX_GROUP_NAMES` | — | `<guid>=name,...` |
| `CORTEX_DEFAULT_GROUPS` | `all-staff` | Granted to every signed-in user. Empty for strict mode |
| `INDEX_REFRESH_MINUTES` | `15` | How often the register re-reads the three back ends. `POST /api/index/refresh` forces one |
| `FOUNDRY_ACCOUNT_NAME`, `FOUNDRY_PROJECT_NAME`, `FOUNDRY_RESOURCE_GROUP` | from Bicep | Where the project lives in ARM, so the app can create project connections. Empty = no connections (agents get the old 401) |
| `FOUNDRY_SEARCH_CONNECTION` | `cortex-search` | Name of the keyless project connection to AI Search |
| `FOUNDRY_MAX_APPROVAL_ROUNDS` | `6` | MCP approval rounds Cortex answers on the user's behalf in one turn |
| `SEARCH_ENDPOINT`, `SEARCH_SERVICE_NAME` | from Bicep | Azure AI Search. Empty = data grounding off |
| `SEARCH_QUERY_TYPE` | `simple` | Keyword search needs no embedding model. `semantic` needs the ranker enabled on the service (`SEARCH_SEMANTIC=free`) |
| `SEARCH_TOP_K` | `5` | Rows returned per tool call |
| `SEARCH_INDEX_PREFIX` | `cortex-` | Index names are prefix + product folder |
| `DATA_STORAGE_ACCOUNT`, `DATA_CONTAINER`, `DATA_RESOURCE_GROUP` | from Bicep | The sample-data account. Empty = no sample data |
| `PURVIEW_ACCOUNT_NAME` | from Bicep | The Data Map account; `PURVIEW_COLLECTION` (default = account name, the root) is where sources are registered |
| `CORTEX_STATE_DIR` | `/data` when the share is mounted | Where the JSON state files live. Empty = memory |
| `CORTEX_CHAT_POLICY` | `all-staff` | `visibility` to apply Marketplace rules to chat |
| `CORTEX_CHAT_MAX_TURNS` | `40` | Turns per conversation |
| `CORTEX_AUTOMATIONS` | `true` | `false` stops the scheduler (runs by hand still work) |
| `CORTEX_AUTOMATION_TICK_SECONDS` | `60` | How often due automations are checked |
| `WEB_MAX_REPLICAS` (azd env) | `1` | Keep at 1: one writer for the state share |
| `MCP_MIN_REPLICAS` (azd env) | `1` | 0 if only testing |
| `CREATE_DATA`, `CREATE_SEARCH`, `SEARCH_SKU`, `SEARCH_SEMANTIC`, `DEPLOYER_PRINCIPAL_ID` (azd env) | `true`, `true`, `basic`, `disabled`, you | The round-4 resources. The deploy script sets them from its switches |

### Key Vault: the route back

Once a private endpoint exists, in this order:

1. VNet with a subnet delegated to `Microsoft.App/environments`.
2. **Recreate the Container Apps environment inside it.** A managed environment cannot be VNet-joined after creation, so `cae-cortex` and both apps are destroyed and rebuilt.
3. Private endpoint on the vault, plus a `privatelink.vaultcore.azure.net` private DNS zone linked to the VNet.
4. `.\scripts\Deploy-Cortex.ps1 -ConfigSource keyvault`

The vault must use RBAC (`az keyvault update -n prdcorekveus -g PRDCOREPVW001 --enable-rbac-authorization true`) or the role assignment is silently ignored. Two azd environments must not share one vault: `cortex-environment-name` records the owner and the script warns before taking it over.

### Demo day

- [ ] `.\scripts\Test-Cortex.ps1` — all green, the morning of
- [ ] Sign in, open `/profile`, confirm your groups
- [ ] Walk the golden path once end to end
- [ ] Delete the rehearsal agent so the demo creates it fresh
- [ ] Have a second account in different groups ready — the same page through different eyes is the most persuasive moment
- [ ] Do not deploy on the day. If you must, `-AppOnly` — it does not touch infrastructure

> There is no fallback if a back end is down. That is the trade for everything being real. Record a walkthrough as insurance.

### Teardown

```powershell
.\scripts\Deploy-Cortex.ps1 -Reset
```

Removes only what Cortex created: the resource group `PRDCORECORTEX001` (both apps, the environment, the identity, the search service, both storage accounts) and the local azd environment. Your APIM, Purview, Foundry, Key Vault, registry and monitoring are untouched.

Left behind on shared resources, remove by hand if you want a clean tenant: the `cortex` product in APIM and the skills' APIs, the role assignments for `id-cortex` (they dangle harmlessly once the identity is gone), the Key Vault secrets, the "Cortex" app registration, the `cortex-ask` agent and the `cx-mcp-*` / `cortex-search` **project connections** in Foundry, the governance domains, data products and data assets in the Unified Catalog, and the `cortex-sample-data` source with its scanned assets in the Data Map.
