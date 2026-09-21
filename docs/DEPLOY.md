# Cortex — Deploy, verify, iterate

**Windows 11 · VS Code · PowerShell 7.** Everything is live — there is no demo mode and no offline path.

Read it top to bottom the first time. Afterwards you will mostly need §4 (iterating) and §6 (troubleshooting).

| § | | When you need it |
|---|---|---|
| 0 | [What you are deploying](#0-what-you-are-deploying) | Once, two minutes |
| 1 | [Before you start](#1-before-you-start) | Once |
| 2 | [Deploy](#2-deploy) | First deploy, and any infrastructure change |
| 3 | [Verify](#3-verify) | After every deploy |
| 4 | [Iterate — which command for which change](#4-iterate--which-command-for-which-change) | Every day |
| 5 | [Demo set-up](#5-demo-set-up) | Before the demo |
| 6 | [Troubleshooting](#6-troubleshooting) | When it does not work |
| 7 | [Reference](#7-reference) | Switches, settings, how it fits together, teardown |

---

## 0. What you are deploying

Cortex is two container apps in front of your existing estate:

| App | Serves | Why it exists |
|---|---|---|
| `cortex-web` | The GOV.UK front end and its backend, port 3000 | The front door |
| `cortex-purview-mcp` | `/mcp` and `/health`, port 3000 | A Foundry agent cannot reach the Purview catalogue any other way. Called by agents, not browsers |

**It reuses what you already own** — API Management, Purview, Foundry, Key Vault, the container registry and monitoring — and creates its own small footprint in `PRDCORECORTEX001`: the two apps and their environment, a **bootstrap job** (`cortex-web-bootstrap`), a managed identity (`id-cortex`), an **Azure AI Search** service (Basic), two **storage accounts** (sample data; application state as blobs) and a **Network Security Perimeter** (`nsp-cortex`) around them. Together the new resources cost a few pounds a month, most of it the search service.

**One command does everything:**

```powershell
.\scripts\Deploy-Cortex.ps1
```

Its steps, numbered as they print:

| Step | What happens |
|---|---|
| 1 | Checks your tools; unblocks scripts that carry the Mark of the Web; refuses source that was damaged in transit; checks Docker is running |
| 2 | Signs you in to Azure (and re-signs you in if Entra refuses a stale token) |
| 3 | Reports what will be **reused** and what will be **created** |
| 4 | Checks the pinned model version is still deployable |
| 5–6 | Registers resource providers, installs dependencies, vendors GOV.UK Frontend |
| 7 | Provisions with `azd up` (Bicep in `infra/`) and pushes both container images |
| **7b** | **Checks both storage accounts are inside the perimeter with public access `SecuredByPerimeter`** — the state the tenant's policy leaves alone — and repairs them when the policy has been at work; keeps a policy exemption on the Cortex resource group as insurance |
| 8 | Reconciles the live apps: image, ingress port, and **that each app's newest revision is actually serving** (restarting one that has failed) |
| 9 | Puts the API Management subscription key and the App Insights connection string onto the web app — and the key onto the bootstrap job — as secrets |
| 10 | Switches on Entra sign-in **with the groups claim** (`Set-CortexAuth.ps1`); **10b** sets up the demo identities when asked |
| 11 | Bootstrap, on your machine: the Cortex identity's Purview roles, domains, data products, skills, Foundry connections per MCP server |
| **11b** | **Bootstrap's sample-data section, inside the perimeter**: starts the `cortex-web-bootstrap` job, which uploads the files, registers and runs the Data Map scan and attaches the scanned assets to the products — as the Cortex identity — then waits for it and prints its log |
| **11c** | One AI Search index per product, built on your machine through the search service, **and verified**: rows indexed, or the first error |
| 12 | Refreshes the app's register and health-checks everything |

At the end it prints **"Cortex is deployed and every check passed"** in green, or **"Cortex is deployed, but it is NOT fully working"** in red with the list of what failed. It exits non-zero in the second case. Nothing is left for the portal; every part of step 11 is a `--only=` section of bootstrap that re-runs safely on its own (§4).

**Everything is live.** Every screen reads Purview, API Management and Foundry through their real APIs. The only generated content is the synthetic sample data behind the fourteen data products — real files in a real storage account, scanned by the Data Map and indexed by AI Search, so an agent can read rows rather than descriptions.

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
| Resource group `PRDCORECORTEX001` | **Owner** (or Network Contributor + Resource Policy Contributor) | Create the **Network Security Perimeter** and its associations; create the **policy exemption** in step 7b. Without the latter the exact command is printed for whoever has it |
| Registry `prdcoreamlacr001` | **AcrPush** | Push the two images |
| Entra | **Application Administrator** | Create the "Cortex" app registration for sign-in. **Groups Administrator** as well for `-DemoIdentities` (it creates groups) |
| Purview portal | **Data Governance Administrator** | Bootstrap creates domains and grants the Cortex identity its roles *as you*. Settings → Solution settings → Unified Catalog → Roles and permissions → Data Governance Administrators |
| Purview Data Map | **Data Source Administrator**, **Data Curator** on the root collection | Registering the sample-data account and scanning it. **Bootstrap grants these to you** through the collection's metadata policy; if that is refused, add yourself: Data Map → Domains and collections → *root* → Role assignments |
| Sample-data storage account | **Storage Blob Data Contributor** | Bootstrap uploads the sample files as you. **The Bicep grants it** to whoever deploys (`DEPLOYER_PRINCIPAL_ID`, filled in by the script). An Owner without it still gets a `403` on a blob write |
| Key Vault `prdcorekveus` | Key Vault Secrets Officer | Only if the vault is used (§7). Missing it is a warning, not a failure |

A sandbox Global Administrator has the first five. The Purview ones are Purview-internal roles that Global Administrator does **not** confer automatically — if bootstrap answers `403` to *your* account, this is why (§6).

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

The Purview row is the one that matters most. Without it the app authenticates and is then refused: `403 Not authorized to access account` — shown on the Help page as **Purview UNAVAILABLE**. Bootstrap grants it.

### The sandbox's tenant policies, and the perimeter — read this once

This subscription is a managed sandbox, and its tenant applies Azure Policy to what you create. Two of those policies shape how Cortex is deployed here:

| Policy | What it does | How Cortex lives with it |
|---|---|---|
| Key Vault: public network access off | Container Apps is not a Key Vault trusted service, so the running app could never read the vault | Configuration is passed **directly** to the container apps (`CORTEX_CONFIG_SOURCE=direct`); the three sensitive values are Container Apps secrets. Fine for a sandbox, not for production — §7 has the route back |
| `MCAPSGovDeployPolicies` (management group, **Modify** effect): *"SFI – Disable public network access on Storage accounts (excluding NSP configured resources)"* and *"disable local auth"* | Rewrites every storage-account update that leaves the public endpoint open, and switches account keys off. The first live run showed both halves: bootstrap refused with `403 AuthorizationFailure`, and `cortex-web` never starting because its Azure Files share could not be mounted with a key | **The way the policy itself names.** Both accounts are inside a **Network Security Perimeter** (`nsp-cortex`) with public network access `SecuredByPerimeter`; the perimeter admits Entra-authenticated traffic from managed identities in this subscription — the web app and the bootstrap job (`id-cortex`), the AI Search indexers, the Purview scan, the Foundry search tool — and nothing else. **No account key is used anywhere**: state is blobs read with the managed identity, not a mounted share. Your laptop is outside the perimeter by design, so the one bootstrap section that touches storage runs as a **job inside Azure** (step 11b). A 90-day policy exemption on the Cortex resource group is kept as insurance |

The AI Search service is also a perimeter member, in **Learning** mode: nothing changes for the Foundry tool or the portal, and the perimeter's logs show what Enforced would have blocked. `-SearchAccessMode Enforced` when you want to commit.

Things the perimeter does **not** cover, deliberately: the Container Apps themselves (their ingress is public — that is the front door), API Management, Purview and Foundry (shared, outside the Cortex resource group), and Key Vault (§7).

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
OK      gpt-5.4-mini 2026-03-17 is deployable (GenerallyAvailable)
```

Also created, the first time: the AI Search service, the two storage accounts, the perimeter and the bootstrap job.

Anything reported `CREATE` that you expected to `REUSE` means a name or resource group is wrong. Every one is a parameter:

```powershell
.\scripts\Deploy-Cortex.ps1 -WhatIfResources -ApimName my-apim -ApimResourceGroup my-rg
```

---

## 2. Deploy

```powershell
.\scripts\Deploy-Cortex.ps1
```

About 10–15 minutes when reusing the estate (the AI Search service is the slow one the first time; the Data Map scan is the slow one every time — `-NoScanWait` skips waiting for it).

### What you will see

The steps print in the order of the table in §0. The lines worth watching:

```
[7b] Checking the storage accounts are secured by perimeter nsp-cortex
  OK      stcortexdata…  (sample data) — SecuredByPerimeter, Enforced in nsp-cortex, keyless
  OK      stcortexstate… (state blobs) — SecuredByPerimeter, Enforced in nsp-cortex, keyless
          Policy 'MCAPSGovDeployPolicies' (modify) applies to these accounts — SFI - Disable public network access on Storage accounts…
  KEEP    Exemption cortex-storage-71918bbacb already covers 'MCAPSGovDeployPolicies' (expires 2026-12-10)
```
On the very first run with the perimeter the accounts are created `Enabled`, the policy turns them `Disabled`, and 7b turns them `SecuredByPerimeter` once the association exists — then records the value so every later provision writes it directly:
```
  FAIL    stcortexdata… (sample data) — public network access is Disabled (wanted SecuredByPerimeter)
  OK      stcortexdata… — public network access is now SecuredByPerimeter
  OK      Recorded STORAGE_PUBLIC_NETWORK_ACCESS=SecuredByPerimeter for the next provision
```

```
[8] Reconciling the container apps
  OK      cortex-web runs prdcoreamlacr001.azurecr.io/cortex/web-cortex:azd-deploy-…
  OK      cortex-web revision cortex-web--xyz is serving (Running, Healthy)
```
A revision that is not serving is restarted once, and if it still will not come up you get the platform's own log lines — a failed mount, a refused image pull — on screen.

```
[11] …            (your machine: roles, domains, products, skills, connections)
  skipping: data, search
  …
[11b] Running the sample-data section inside the perimeter (job cortex-web-bootstrap)
  OK      Job runs web-cortex:azd-deploy-…
          Execution cortex-web-bootstrap-abc12 — waiting (the Data Map scan is the slow part; 3–10 minutes, waited for)
    | === Sample data → storage → Data Map → data products ===
    |   ok    container products exists in stcortexdata…
    |   ok    water-quality-archive/water-quality-archive.csv — 1200 rows uploaded (+ README.md)
    |   …
    |   ok    scan Succeeded — 28 assets discovered
  OK      Job cortex-web-bootstrap-abc12 succeeded — the sample files are in storage and the products carry their assets
[11c] Building the AI Search indexes
=== Azure AI Search — one index per data product ===
  ok    cortex-water-quality-archive — 12 columns; indexer started
  …
  ok    cortex-water-quality-archive — 1200 rows indexed
  ok    14 of 14 indexes hold rows. Agents pick indexes up on "Rebuild tools".
```

The job's log is printed indented with `|`. Its first live run is also the first proof that the perimeter admits the Cortex identity, the Purview scan and the search indexers — if any of the three is refused, the failure is named there and in the red banner.

### Re-running is the design

Run the same command as often as you like. Every step reconciles rather than recreates:

| Situation | What happens |
|---|---|
| The apps are already running your code | The live image is read back and fed into the template, so a re-provision never rolls them back to the placeholder |
| The policy has changed a storage account again | Step 7b puts it back to SecuredByPerimeter and reports which assignment did it |
| The bootstrap job runs again | Files are rewritten (fixed seed, so nothing changes), the source and scan are kept, a new scan run starts, attached assets are skipped |
| A revision failed to come up | Step 8 restarts it once and shows the platform log if it still fails |
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
| An index, data source or indexer exists | Updated in place (a PUT on a fixed name); the indexer is run again and its result checked |
| The demo groups exist | Left alone; memberships are not touched |

### If it fails

The script stops at a failing step and says what to check, or finishes with a red banner listing every problem it found. Nothing it does is destructive except `-Reset`. Fix the cause and run the same command again — or, if provisioning succeeded and a later step failed, `-SkipProvision -SkipAuth` resumes from step 7b in about five minutes. §6 has the specific failures; `.\scripts\Test-Cortex.ps1 -Diagnose` produces one paste-able block with everything a second pair of eyes needs.

---

## 3. Verify

### a. Check it

```powershell
.\scripts\Test-Cortex.ps1
```

```
Container apps in PRDCORECORTEX001
  OK    cortex-web  web-cortex:azd-deploy-…
  OK    cortex-web revision cortex-web--… is serving (Running, Healthy)
  OK    cortex-purview-mcp  purview-mcp-cortex:azd-deploy-…
  OK    cortex-purview-mcp revision … is serving (Running, Healthy)

Storage accounts (perimeter nsp-cortex)
  OK    stcortexdata… (sample data) — SecuredByPerimeter, Enforced mode, keyless
  OK    stcortexstate… (state blobs) — SecuredByPerimeter, Enforced mode, keyless
  OK    bootstrap job cortex-web-bootstrap — last run cortex-web-bootstrap-abc12 succeeded (2026-09-11T18:02:11+00:00)

Checking https://cortex-web.…
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
  OK    Application state (blobs)
        mode: blob (https://stcortexstate….blob.core.windows.net/state)
  OK    Purview MCP server (5 tools)
```

`mode: memory` on a deployed app means the web app could not read its state blobs when it started — it serves, but persists nothing until the storage account is repaired (§6) and the revision restarted.

Purview roles can take a minute to propagate after bootstrap grants them. If Purview alone is red straight after a deploy, wait a minute and run it again. The Help page (`/help`) shows the same services with the underlying error text when one is not working. `-Diagnose` adds the paste-able block (§6).

### b. Sign in

Open the web URL. You are redirected to Microsoft sign-in, then to the Marketplace. Open **`/profile`** ("What can I see?" in the header): it lists your groups and how many entries fall into each visibility state.

Every signed-in user is treated as a member of **`all-staff`** — the default group. That is what makes "Open to all staff" entries available to you on a tenant with no group mapping. The profile page marks it as coming from configuration, not Entra.

> Signed in *before* the groups claim was switched on, or before the demo groups existed? Your token predates it. Sign out and back in.

### c. Walk the golden path once

Marketplace → a data product → **The data behind it** (the scanned file, its columns, the index) → Build an agent with it → test it → **Open a chat window** → publish → it reappears in the Marketplace with a **Chat** link. Then **Ask a question** — the answer is written by the `cortex-ask` agent in Foundry from the catalogue entries you can reach, with the provenance panel underneath. Ask is live: if the model cannot be reached the page says so and falls back to the register's own summary.

Finish on **About** (top right, or `/about`). It is the page for the people who decide, not the people who use: the problem in the requester's words, seven handoffs to four, the as-is/to-be by layer, the highlighted message — "AI alone won't change your business. The system running it will." — with Microsoft's three principles set against what Cortex already does, how it is built, why it is safe, and what we are asking for. Its figures are read live from the register.

When you test an agent, the panel under the answer lists **Tools this answer used** — every MCP call, approved by Cortex on your behalf and recorded — and a failure reads as a sentence about what to do, with the raw text folded underneath.

### d. Look at what bootstrap put behind the products

Three places, all real:

| Where | What you see |
|---|---|
| Storage account `stcortexdata…` → container `products` | One folder per data product: `<id>.csv` (the data, header row first) and `README.md` (the data dictionary). All synthetic, generated by `scripts/sample-data.js` from a fixed seed — no real people, holdings or measurements |
| Purview portal → Data Map → Data sources | `cortex-sample-data` (ADLS Gen2) with scan `cortex-sample-scan`. Open a run to see the assets discovered, each CSV with its extracted schema and any classifications the system ruleset applied |
| Purview portal → Unified Catalog → a data product → **Data assets** | The scanned file attached to the product. This is the join Cortex reads: product → asset → file |
| Azure portal → `srch-cortex-…` → Indexes | `cortex-<product-id>` for each product, with the row count; Indexers shows the last run |

In Cortex, a data product's entry page has the same chain under **The data behind it**, plus **Build the index now** for a product whose index is missing (or after you replace its file). An agent built on the product gets an `azure_ai_search` tool for its index and instructions naming its columns; an agent built *before* the index existed picks it up with **Rebuild tools** on its page.

---

## 4. Iterate — which command for which change

| You changed | Run | Time |
|---|---|---|
| Application code (`src/`) | `.\scripts\Deploy-Cortex.ps1 -AppOnly` | ~2 min. Builds and pushes both images, waits for the new revisions to serve, touches nothing else |
| Content (`bootstrap/*.json`) | `. .\scripts\Set-CortexEnv.ps1` then `npm run bootstrap` | ~1 min plus the scan wait. Idempotent. `-- --no-wait` to skip the scan wait and the indexer check |
| Only Purview permissions | `. .\scripts\Set-CortexEnv.ps1` then `node scripts/bootstrap.js --only=roles` | seconds |
| Foundry connections for the MCP servers (after publishing skills, or an agent says it "could not sign in to one of its tools") | `node scripts/bootstrap.js --only=connections` | seconds |
| The sample data (`scripts/sample-data.js`) — anything that touches storage | `.\scripts\Deploy-Cortex.ps1 -AppOnly` (the job runs the web image, so new generator code has to be pushed first) then `az containerapp job start -n cortex-web-bootstrap -g PRDCORECORTEX001`, then `node scripts/bootstrap.js --only=search`. Or simply `.\scripts\Deploy-Cortex.ps1 -SkipProvision -SkipAuth`, which does all three | 5–15 min, mostly the scan |
| The scan finished after a `-NoScanWait` run | `. .\scripts\Set-CortexEnv.ps1` then `node scripts/bootstrap.js --only=link` (no storage access needed — it runs here) | seconds |
| Only the search indexes | `node scripts/bootstrap.js --only=search` | ~2 min including the check that rows arrived |
| Watch the job | `az containerapp job execution list -n cortex-web-bootstrap -g PRDCORECORTEX001 -o table` and `az containerapp job logs show -n cortex-web-bootstrap -g PRDCORECORTEX001 --container bootstrap --tail 200` | — |
| The policy changed a storage account again (bootstrap job `403 AuthorizationFailure`, state `mode: memory`) | `.\scripts\Set-CortexStorageAccess.ps1` then `.\scripts\Deploy-Cortex.ps1 -SkipProvision -SkipAuth` | ~5 min |
| Who can see what (groups) | `.\scripts\Set-CortexAuth.ps1 -GroupMap ...` | seconds |
| The demo groups or a second demo account | `.\scripts\Deploy-Cortex.ps1 -SkipProvision -SkipBootstrap -SkipHealthCheck -DemoIdentities -DemoUserEmail <address>` | ~1 min |
| Infrastructure (`infra/`) | `.\scripts\Deploy-Cortex.ps1` | ~10 min |
| A setting the Bicep reads (`azd env set X y`) | `.\scripts\Deploy-Cortex.ps1 -SkipBootstrap` | ~5 min |
| The model | `.\scripts\Deploy-Cortex.ps1 -ModelName gpt-5-mini -ModelVersion 2025-08-07 -UpgradeModel` | ~5 min |

Two rules that keep iteration safe:

- **The leading dot on `Set-CortexEnv.ps1` is load-bearing.** It loads the deployment's configuration into *your* session so a local `node` process can talk to your Azure resources. Without it bootstrap stops with "Missing required configuration".
- **`npm test` before you push.** 332 tests, no Azure needed, about 20 seconds. `node scripts/bootstrap.js --dry-run` validates content changes the same way, and `node scripts/sample-data.js --list` shows what the generator would produce.

Running the app on your machine against the real back ends:

```powershell
.\scripts\Start-Local.ps1 -Groups all-staff,waste-crime,analysts
```

Or **F5** in VS Code. There is no Easy Auth in front of a local process, so `ALLOW_UNAUTHENTICATED=true` simulates an identity with the groups you pass. Never set it on a deployed app. Anything you publish locally is published for real. Locally the state lives in a directory (`CORTEX_STATE_DIR`) or in memory — your laptop cannot reach the state blobs through the perimeter, and should not.

---

## 5. Demo set-up

### a. Two accounts, two Marketplaces — the most persuasive moment

Access rules read group **names** (`analysts`, `waste-crime`, `ne-evidence`, `ea-flood-risk`, `cortex-official-sensitive`); Entra sends group **object ids**. The demo set-up creates one Entra group per name, maps it, puts **you** in all of them, and puts each demo account in the analysts group only:

```powershell
.\scripts\Deploy-Cortex.ps1 -SkipProvision -SkipBootstrap -SkipHealthCheck -DemoIdentities -DemoUserEmail colleague@defra.gov.uk
```

(`-DemoIdentities` can equally be added to the full deployment.) What each account then sees:

| Account | Groups | Sees |
|---|---|---|
| You | all-staff + all five demo groups | Everything: the Official–Sensitive products (`rural-land-parcels`, `livestock-movements`…), the NE and EA products, every skill |
| The demo user | all-staff + `Cortex Analysts` | The "Open to all staff" entries, plus the *Catchment summariser* skill (analysts). The Official–Sensitive products show as **Not cleared**; the NE and EA products as **Request access** |

The group names and the demo user's groups are parameters: `-DemoGroupMap 'alias=Display name',…` and `-DemoUserGroups 'Display name',…`. Existing groups are reused, never recreated. Anyone who signed in before the groups existed must sign out and in again to pick them up; `/profile` shows what the token carries.

### b. Invite a colleague — or your own account from another tenant

Cortex signs people in through **this** tenant's Entra ID, and its app registration is single-tenant. Anyone whose account lives elsewhere — a Defra colleague, a partner, your own corporate account — comes in as a **guest** (Entra B2B): they keep their own password and MFA, this tenant holds only a guest object for them, and Cortex sees them exactly as it sees a member, by the groups they are in.

```powershell
.\scripts\Add-CortexUser.ps1 -Email shengzhu@microsoft.com
.\scripts\Add-CortexUser.ps1 -Email colleague@defra.gov.uk -Groups 'Cortex Analysts'
```

The script finds the person if they are already in the tenant, otherwise sends Microsoft's invitation email with Cortex as the landing page; `-Groups` adds them to Entra groups (which must also be mapped to mean anything to the rules — the demo groups already are); `-NoEmail` prints the redemption link for you to pass on; `-Resend` sends the invitation again. Idempotent.

What the invitee sees: an email from *Microsoft Invitations* → **Accept** → the Cortex sign-in → on the first visit only, a prompt to accept this organisation's terms → the Marketplace. Tell them to use a **private browser window** if the computer is already signed in to Cortex as somebody else.

**MFA for guests — do this once, before the first invitee signs in.** This tenant's baseline Conditional Access has two policies for external users: one **requires MFA**, the other **blocks security-info registration**. Together they mean a guest must do MFA but cannot set up a method here. The intended answer is to accept the MFA they already did in their home tenant:

```powershell
.\scripts\Add-CortexUser.ps1 -Email <address> -TrustHomeMfa
```

or by hand: Entra admin center → External Identities → Cross-tenant access settings → Default settings → Inbound access settings → Edit inbound defaults → **Trust settings** → tick **Trust multifactor authentication from Microsoft Entra tenants**. The invitee then signs out fully and signs in again. `Add-CortexUser.ps1` checks this setting on every run and warns while it is off. It only helps when the home tenant *did* perform MFA (a Microsoft or Defra account always does); for a tenant that did not, give the tester a **member** account in this tenant instead.

Two things this cannot do. It cannot override the invitee's **home tenant**: if that tenant blocks guest access to this one, redemption stops with an AADSTS error and the fix is on their side. And it does not make the app multi-tenant — that would put a foreign tenant's group ids in the token, which nothing here maps. Guest is the right shape.

### c. Map your own Entra groups instead

If you would rather use groups that already exist:

```powershell
.\scripts\Set-CortexAuth.ps1 -GroupMap 'waste-crime=Waste Crime Observatory','analysts=Data Analysts'
```

The mapping is written to the azd environment (so a re-provision keeps it) and to the live app (so it applies now). To name every group you are already in after its Entra display name — `/profile` then shows names instead of ids — `.\scripts\Set-CortexAuth.ps1 -MapMyGroups`. Mappings are additive across runs, and an explicit `-GroupMap` alias always wins over an automatic name. To turn the default group off and rely on Entra alone: `-DefaultGroups ''`.

The special group names the rules understand:

| Group name | Effect |
|---|---|
| `all-staff` | Covers "Internal only" licences and "Open to all staff" entries |
| `cortex-official-sensitive` | Clearance to Official–Sensitive |
| `cortex-commercial-licence` | Covers seat-limited and commercial licences |
| `cortex-team-<name>` | Display team name only; no access effect |
| anything else | Matches an entry whose allowed groups name it (e.g. `waste-crime`) |

### d. Chat and Automate a task

**Chat.** Every agent's page has **Open a chat window**: a multi-turn conversation in its own window, open to every signed-in person in this phase (`CORTEX_CHAT_POLICY=all-staff`). Switch to `visibility` to apply the Marketplace rules to chat as well.

**Automate a task** in the navigation is real. Set one up: pick an agent and the question it is asked, or an approved request method, how often, and what the drafts are for. It runs on a timer inside the web app and files a **draft** — with its sources and the tools it used — into its run history. It writes nothing anywhere else; that switch does not exist in this phase. **Run it now** on the page shows one in front of an audience without waiting; *Every 15 minutes* is there for the same reason.

### e. Demo day

- [ ] `.\scripts\Test-Cortex.ps1` — all green, the morning of
- [ ] Sign in, open `/profile`, confirm your groups; do the same with the demo account in a private window
- [ ] Walk the golden path once end to end
- [ ] Open `/about` — this is the page to leave on screen when the questions start; it prints cleanly as the leave-behind
- [ ] Delete the rehearsal agent so the demo creates it fresh
- [ ] Do not deploy on the day. If you must, `-AppOnly` — it does not touch infrastructure

> There is no fallback if a back end is down. That is the trade for everything being real. Record a walkthrough as insurance.

---

## 6. Troubleshooting

Start here when something is red: `.\scripts\Test-Cortex.ps1 -Diagnose`. It prints, between two marker lines, the revision states, the replica container states, the platform and console logs, the storage settings and the policies that touched them — nothing secret — so the whole thing can be pasted to whoever is helping.

| Symptom | Cause | Fix |
|---|---|---|
| Chat or test: **"The agent could not be reached … Authentication failed when connecting to the MCP server … 401 Access denied due to missing subscription key"** | The agent's MCP tool carries no usable project connection — built before connections existed, or its record did not survive | Since round 7 Cortex repairs this itself: on the first 401 it gives the tools their connections (a new agent version, from the definition Foundry holds) and retries the turn. Ask again if the first answer was the error. **Rebuild tools** on the agent page does the same by hand. If Foundry says the connection is *not found*, set `FOUNDRY_CONNECTION_REF=name` on the web app and try again — the two forms of the connection reference are one setting apart |
| Step 12: **cortex-web revision … http-auth is Waiting … CreateContainerConfigError**, the web container is Running | The sign-in sidecar cannot find its client secret in that revision's secrets (a provision or a secret update left it out). The previous revision keeps serving, so the site still works — with the previous settings | The deploy script re-mints the secret and waits for the new revision (step 12); `Set-CortexAuth.ps1` does the same whenever it finds the secret missing or the sidecar in that state. By hand: `.\scripts\Set-CortexAuth.ps1 -RotateSecret` |
| Step 11b: the job log shows only **"The command requires the extension containerapp. Do you want to install it now?"** | `az containerapp job logs show` lives in the CLI extension, and the prompt ate the log | Fixed in round 7: the scripts let extensions install themselves (`AZURE_EXTENSION_USE_DYNAMIC_INSTALL`, process scope). By hand once: `az extension add --name containerapp --upgrade` |
| Step 11b: **Job … finished as Failed** | Anything in the data section failed — the log printed under the step names it. Common: the perimeter refusing the Cortex identity (`403 AuthorizationFailure`), the scan failing (the Purview identity refused), `Missing required configuration` (the APIM key not on the job yet) | Read the log lines; each has its own row here. If the files were uploaded (the storage health check counts them), the indexes are built anyway in 11c. Re-run the job alone: `az containerapp job start -n cortex-web-bootstrap -g PRDCORECORTEX001` |
| **`cortex-web` answers 404 or times out on every path** ("stream timeout" in the browser), the MCP app is fine | The newest revision never came up, so the platform answers for it. In round 4 this was the Azure Files state share failing to mount (`mount error(13): Permission denied` — the policy had disabled account keys). Since round 6 there is no share; a revision still trying to mount one predates the current template | `.\scripts\Deploy-Cortex.ps1` (a provision applies the template without the volume). Step 8 shows the revision state and the platform's log lines either way |
| Bootstrap job: **Storage PUT … 403 `AuthorizationFailure`** ("This request is not authorized to perform this operation") | The **network rules**, not a role: the account is not `SecuredByPerimeter` (the policy set it to Disabled), it is not associated with the perimeter, or the perimeter has no subscription rule | `.\scripts\Set-CortexStorageAccess.ps1` — it reports which of the three — then `.\scripts\Deploy-Cortex.ps1 -SkipProvision -SkipAuth` |
| Bootstrap job: **Storage PUT … 403 `AuthorizationPermissionMismatch`** | The Cortex identity holds no data-plane role on the account | Re-provision (the Bicep grants Storage Blob Data Contributor to `id-cortex`); a new assignment takes up to five minutes |
| Bootstrap job: **Missing required configuration … apim-subscription-key** | The key is not on the job yet | Re-run the deploy script; step 9 sets it (or `az containerapp job secret set` + `--set-env-vars APIM_SUBSCRIPTION_KEY=secretref:apim-subscription-key`) |
| Bootstrap job: **scan Failed** | The Purview account identity is refused by the storage account — no Storage Blob Data Reader (Bicep grants it), or the perimeter is not admitting it | Check the account is `SecuredByPerimeter` and the subscription rule exists (`Test-Cortex.ps1 -Diagnose` lists both); re-provision to restore the role |
| Step 7b: **public network access is Disabled (wanted SecuredByPerimeter)** on every run | The policy is rewriting the value even though the perimeter exclusion should apply | Paste the policy rule to whoever is helping: `az policy assignment show --name mcapsgovdeploypolicies --scope /providers/Microsoft.Management/managementGroups/<tenant id> --query policyDefinitionId`, then `az rest --method get --url "https://management.azure.com<that id>?api-version=2023-04-01"`. The exemption (also created by 7b) covers the gap meanwhile |
| Step 7b: **not associated with nsp-cortex** | The perimeter module did not run (`-NoPerimeter`, or `CREATE_PERIMETER=false` in the azd environment) | `azd env set CREATE_PERIMETER true` then `.\scripts\Deploy-Cortex.ps1` |
| Step 7b: **Could not create the exemption … AuthorizationFailed** | You lack `Microsoft.Authorization/policyExemptions/write` on the resource group | Ask an Owner to run the printed command once. The perimeter does the real work; the exemption is insurance |
| Step 7b: **Could not create the exemption … Unable to parse … expires-on** | An old copy of `Set-CortexStorageAccess.ps1` (the timestamp was formatted in the Danish locale) | Fixed in round 6 — copy the script again |
| `/api/health/state` says **mode: memory** on a deployed app | The web app could not read its state blobs at start-up (perimeter or policy), so it serves without persisting | Repair the account (above), then `az containerapp revision restart -n cortex-web -g PRDCORECORTEX001 --revision <name>`; the log line `[state] N collection(s) loaded` confirms it |
| Bootstrap search: **`N indexer(s) were refused by stcortexdata…`** / indexes hold 0 rows | The perimeter is not admitting the search service's identity, or the account is not `SecuredByPerimeter` | Same repair; then `node scripts/bootstrap.js --only=search`. `-Diagnose` lists the perimeter's access rules |
| Provision: **`Microsoft.Network/networkSecurityPerimeters` … api-version** rejected | The region does not offer `2024-07-01` yet | It appears in four places in `infra/modules/nsp.bicep`; try `2023-08-01-preview` |
| Deploy ends **"Cortex is deployed, but it is NOT fully working"** | One or more steps reported a problem; they are listed under the banner | Fix each named cause; re-run. Every step is safe to repeat |
| Help page: **Purview UNAVAILABLE — 403 Not authorized to access account** | The Cortex identity holds no Unified Catalog role | `. .\scripts\Set-CortexEnv.ps1` then `node scripts/bootstrap.js --only=roles`. Wait a minute, reload |
| Bootstrap: **403** on `businessdomains` or `policies` to *you* | Your account is not a Data Governance Administrator in Purview | Purview portal → Settings → Solution settings → Unified Catalog → Roles and permissions → add yourself. Re-run |
| Bootstrap: `No catalog-level policy (dgpolicy_datagovernanceapp_*) was returned` | Same as above, or the tenant is not on the new Purview portal | Same fix; check the portal shows "Unified Catalog" |
| Bootstrap: `created as DRAFT — publish refused` | The catalogue's publish preconditions were not met | Expected sometimes. Products still show, tagged Draft. Publish in the portal |
| Bootstrap: **Missing required configuration** listing eight values | You ran it without loading config into the session | `. .\scripts\Set-CortexEnv.ps1` — with the leading dot — then `npm run bootstrap` |
| **`Continuous access evaluation resulted in challenge … TokenCreatedWithOutdatedPolicies`** | Your Azure CLI token was issued before your directory roles changed and Entra refuses it. On Windows a plain `az login` often returns the *same* token via the broker | `Set-CortexAuth.ps1` and `Deploy-Cortex.ps1` clear the cache, sign you in again and fall back to the device-code flow. By hand: `az account clear` → `az login --use-device-code` → `az account set --subscription <id>` |
| Set-CortexAuth: **Sign-in points at client …, which no longer exists** | The app registration Easy Auth uses was deleted; nobody can sign in | Let the script finish — it creates a new one and re-points the app |
| Health checks all **redirected to sign-in** / all `ok=false` at once | Sign-in is guarding `/api/health*`; the checks were reading the login page | `Set-CortexAuth.ps1` excludes the machine paths. Then `Test-Cortex.ps1` |
| Bootstrap: skills fail with **500 InternalServerError** on `…-mcp/tools/invoke` | The old request shape. An MCP server must be created with its tools **inline** (`type: 'mcp'` + `mcpTools`) in one PUT | Fixed: one PUT, verified after. A type-null leftover is deleted and recreated. Re-run `node scripts/bootstrap.js --only=apim` |
| Invitee: **AADSTS…** when accepting the invitation, or "your organisation does not allow you to access…" | Their home tenant's cross-tenant access settings block guest access to this tenant | Nothing here can change it. Use an account that lives in this tenant, or ask their tenant admin |
| Invitee: **stopped by "Require multifactor authentication"**, never offered MFA set-up | This tenant requires MFA of guests and blocks them from registering a method here | `Add-CortexUser.ps1 -Email <address> -TrustHomeMfa`. Sign out fully, sign in again. If their home tenant did no MFA, use a member account |
| Invitee: signs in and lands on the **wrong account** | The browser already holds another Cortex session | Private browser window, or sign out at `/.auth/logout` first |
| Any script: **`'$select' is not recognized as an internal or external command`** | A Graph URL with `&` reached cmd.exe through `az`, which split it into two commands | Fixed (parameters go through `--uri-parameters`, never in the URL). If you see it, you have an old copy of a script — copy it again and `Unblock-File` |
| `Add-CortexUser.ps1`: **Authorization_RequestDenied** / 403 | You lack Guest Inviter / User Administrator in this tenant | Get the role, or invite from the Entra admin centre with the Cortex URL as redirect |
| `-DemoIdentities`: **group could not be created** | You lack Groups Administrator | Get the role, or create the five groups by hand and re-run — existing groups are mapped, not recreated |
| `/profile` lists **N unmapped group ids** | Entra sends group object ids; the rules read names. Nothing is broken | `.\scripts\Set-CortexAuth.ps1 -MapMyGroups` names every group you are in. `-GroupMap 'waste-crime=<Entra group>'` gives one a name a rule uses |
| `/profile` says **no named groups** | The token predates the groups claim (or the demo groups), or the ids are unmapped | Sign out and in. Map ids with `Set-CortexAuth.ps1 -GroupMap` |
| Marketplace looks almost empty; entries say "Licence does not cover you" | Strict mode with no group mapping | `Set-CortexAuth.ps1 -DefaultGroups all-staff`, or map groups |
| Page says **Sign-in is not configured** | Authentication is not on in front of the app | `.\scripts\Set-CortexAuth.ps1` |
| Ask shows **The model could not be reached** | Foundry refused or timed out; the reason is on the page | Check `/api/health/foundry`; the identity needs Foundry User on the account (Bicep grants it) |
| Agent test: **The agent could not sign in to one of its tools** — `401 Access denied due to missing subscription key` | The MCP tool has no Foundry project connection carrying the API Management key | **Rebuild tools** on the agent's page, or `node scripts/bootstrap.js --only=connections` then rebuild |
| Bootstrap connections: **403 AuthorizationFailed** on `…/projects/…/connections/…` | The caller lacks `Microsoft.CognitiveServices/accounts/projects/*` on the Foundry account | For the app: re-provision (Bicep grants Foundry Project Manager to `id-cortex`). For you: Contributor on the Foundry account |
| Bootstrap data: **Data Map … 403** on `datasources` or `scans` | You are not a Data Source Administrator on the collection | Bootstrap tries to grant it first; if that is refused, Purview portal → Data Map → Domains and collections → root → Role assignments → add yourself |
| Scan **Failed** | Usually the Purview account identity cannot read the storage account | Confirm the account has a system-assigned identity and Storage Blob Data Reader on `stcortexdata…` (Bicep grants it); `Set-CortexStorageAccess.ps1`; then re-run the job |
| Bootstrap link: **the Data Map has no asset for … yet** | The scan has not finished, or found nothing | Wait for the run to show Succeeded in the portal, then `node scripts/bootstrap.js --only=link` |
| Bootstrap search: **the Basic tier allows 15** | More than 15 indexes on the service | `azd env set SEARCH_SKU standard` and re-provision, or delete indexes you do not need |
| Entry page: **Search not configured** / no "Build the index now" | `SEARCH_ENDPOINT` is empty on the web app | Deployed with `-NoSearch`; re-run without it |
| Agent answers but never cites rows | The agent was built before the index existed | **Rebuild tools** on the agent's page. The side panel lists which products are indexed |
| Health: **Application state — memory** on a deployed app, no `STATE_STORAGE_ACCOUNT` | Deployed with `-NoData` | Re-run without it |
| Foundry account: **no system-assigned identity** warning | The account was created without one | Azure portal → the Foundry account → Identity → System assigned → On; re-run the deploy script |
| Build → create agent fails | The model chosen is not deployed | Only deployed models are offered; check `FOUNDRY_MODEL` matches a deployment |
| An app serves the Container Apps welcome page or a 502 | Placeholder image, or ingress port ≠ 3000 | `.\scripts\Deploy-Cortex.ps1 -AppOnly`; the script also corrects the port |
| **ServiceModelDeprecating** | The pinned model version is no longer deployable | `-WhatIfResources` lists what the account accepts; pin one with `-ModelVersion` |
| **AuthorizationFailed** on a role assignment | You lack User Access Administrator | Get the role, then re-run with `-SkipProvision` |
| `A resource with this name already exists or is in a conflicting state` | Usually a soft-deleted Key Vault or Foundry account | The script prints the recover/purge command |
| `Preprovision-Check.ps1` **is not digitally signed** | The file carries the Mark of the Web and PowerShell's policy is `RemoteSigned` | Fixed: the deploy script unblocks scripts at step 1 and the hook runs with `-ExecutionPolicy Bypass` |
| `imgId: The system cannot find the file specified` on both services | azd cancelled the parallel image builds because another step failed | Fix the other error and re-run |
| **Masked credential placeholders found in the source** | A file came back from a chat or transfer tool with a run of `*` where a value was | Restore the file from git |
| `spawn az ENOENT` / `spawn EINVAL` locally | Windows CLI spawn traps | Fixed in `token.js`; if you see it, you have an old copy |
| Docker errors mid-provision | Docker Desktop not running | Start it. The script checks first |
| `RoleAssignmentExists` | — | Harmless |

Where to look: `/api/health`, `/api/health/purview`, `/api/health/datamap`, `/api/health/apim`, `/api/health/foundry`, `/api/health/search`, `/api/health/storage`, `/api/health/state`, `/api/health/keyvault` return JSON with the underlying error text. `Test-Cortex.ps1` reads them for you; `-Diagnose` adds the platform's side of the story.

---

## 7. Reference

### Deploy-Cortex.ps1 switches

| Switch | Use it when |
|---|---|
| `-WhatIfResources` | You want the plan. Changes nothing |
| `-AppOnly` | Code changed, infrastructure did not. The fast loop; waits for the new revisions to serve |
| `-SkipProvision` | Provisioning already succeeded; resume from step 7b |
| `-SkipBootstrap` | Do not touch Purview content or roles this run |
| `-SkipAuth` | Do not touch sign-in this run |
| `-SkipHealthCheck` | Deploying into something not up yet |
| `-DemoIdentities` | Create and map the demo groups, add you to all of them (§5a) |
| `-DemoUserEmail a@b,c@d` | Invite (or find) these accounts and put them in `-DemoUserGroups` (default `Cortex Analysts`) |
| `-DemoGroupMap 'alias=Display name',...` | The demo groups to create; defaults cover every group the bootstrap content names |
| `-NoPolicyExemption` | Step 7b repairs the storage accounts without creating the policy exemption |
| `-NoPerimeter` | No Network Security Perimeter. In this tenant the policy then closes both storage accounts — only for a tenant without it |
| `-StorageAccessMode Enforced\|Learning` | The storage accounts' association mode. Enforced (default) is what the policy exclusion needs |
| `-SearchAccessMode Learning\|Enforced` | The AI Search service's association mode. Learning (default) changes nothing and logs |
| `-GroupMap 'alias=Group name',...` | Map existing Entra groups onto access-rule names (passed to `Set-CortexAuth.ps1`) |
| `-DefaultGroups 'all-staff'` | What every signed-in user is treated as. `''` for strict mode |
| `-ConfigSource auto\|keyvault\|direct` | See *How it fits together* below |
| `-ModelName`, `-ModelVersion`, `-ModelDeploymentName`, `-ModelSku`, `-ModelCapacity`, `-UpgradeModel` | The model |
| `-ForceSeedKeyVault` | The role check is wrong and you know you can write secrets |
| `-NoData` | Do not create the storage accounts, the perimeter or the job (no data behind products; state in memory) |
| `-NoSearch` | Do not create the AI Search service (agents describe products but cannot read rows) |
| `-SearchSku free\|basic\|standard` | Search tier. Basic (default) holds 15 indexes |
| `-ChatPolicy all-staff\|visibility` | Who may chat with an agent. `all-staff` this phase |
| `-NoScanWait` | Start the Data Map scan and carry on; run `node scripts/bootstrap.js --only=link` when it has finished |
| `-Reset` | Delete the Cortex resource group and the local azd environment, after typing the group name |

Every resource name and group is also a parameter: `-ApimName`, `-ApimResourceGroup`, `-PurviewName`, `-PurviewResourceGroup`, `-FoundryAccountName`, `-FoundryProjectName`, `-FoundryResourceGroup`, `-KeyVaultName`, `-KeyVaultResourceGroup`, `-RegistryName`, `-RegistryResourceGroup`, `-LogAnalyticsName`, `-AppInsightsName`, `-MonitoringResourceGroup`, `-CortexResourceGroup`, `-EnvironmentName`, `-Location`.

### The other scripts

| Script | Does |
|---|---|
| `Set-CortexStorageAccess.ps1` | Reads both storage accounts and the perimeter's associations, names the policy assignment that applies to them, keeps the exemption, puts public network access back to `SecuredByPerimeter` and reads it back. `-Perimeter` (default from the azd environment), `-ReportOnly`, `-NoExemption`, `-ExpiresInDays` (default 90). Exit code 0 fine, 2 repaired, 1 not repaired. Run by the deploy script as step 7b |
| `Test-Cortex.ps1` | Health-check a deployment: revisions, storage accounts, the nine health endpoints, the MCP server. `-Diagnose` adds the paste-able block. `-Local` runs the unit tests instead |
| `Set-CortexAuth.ps1` | Sign-in, groups claim, group mapping, default group. Idempotent. `-MapMyGroups` names every group you are in; `-GroupMap` names specific ones; `-CreateGroups` creates them; `-RotateSecret` mints a new client secret |
| `Add-CortexUser.ps1` | Give a person access: finds them or sends a B2B guest invitation with Cortex as the landing page. `-Groups` adds them to Entra groups; `-NoEmail` prints the redemption link; `-Resend` re-invites; `-TrustHomeMfa` makes this tenant accept guests' home-tenant MFA |
| `Set-CortexEnv.ps1` | **Dot-source it.** Loads the deployment's configuration into the session for running bootstrap by hand. Nothing written to disk |
| `bootstrap.js` | `npm run bootstrap`. `--only=roles\|purview\|apim\|connections\|data\|link\|search`, `--skip=data,search`, `--no-wait` (skip the scan wait and the indexer check), `--principal=<oid>`, `--skip-roles`, `--dry-run`, `--no-adopt`. `BOOTSTRAP_ARGS` in the environment is appended — how the job receives its flags. The data sections live in `bootstrap-data.js`. The deploy script runs `--skip=data,search` here, `--only=data --skip-roles` in the job, then `--only=search` here |
| the job `cortex-web-bootstrap` | A Container Apps job on the web image, running as `id-cortex` inside the perimeter. Started by step 11b; by hand: `az containerapp job start -n cortex-web-bootstrap -g PRDCORECORTEX001`. Redirect it with `az containerapp job update … --set-env-vars BOOTSTRAP_ARGS=--only=link` |
| `sample-data.js` | The synthetic data generator. `--list` shows products and row counts; `--out <folder>` writes the CSVs and dictionaries locally to look at |
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
| `FOUNDRY_CONNECTION_REF` | `id` | How a tool names its project connection: the full connection resource id (`id`) or the bare name (`name`) |
| `FOUNDRY_MAX_APPROVAL_ROUNDS` | `6` | MCP approval rounds Cortex answers on the user's behalf in one turn |
| `SEARCH_ENDPOINT`, `SEARCH_SERVICE_NAME` | from Bicep | Azure AI Search. Empty = data grounding off |
| `SEARCH_QUERY_TYPE` | `simple` | Keyword search needs no embedding model. `semantic` needs the ranker enabled on the service (`SEARCH_SEMANTIC=free`) |
| `SEARCH_TOP_K` | `5` | Rows returned per tool call |
| `SEARCH_INDEX_PREFIX` | `cortex-` | Index names are prefix + product folder |
| `DATA_STORAGE_ACCOUNT`, `DATA_CONTAINER`, `DATA_RESOURCE_GROUP` | from Bicep | The sample-data account. Empty = no sample data |
| `PURVIEW_ACCOUNT_NAME` | from Bicep | The Data Map account; `PURVIEW_COLLECTION` (default = account name, the root) is where sources are registered |
| `STATE_STORAGE_ACCOUNT`, `STATE_CONTAINER` | from Bicep, `state` | The blob account and container holding one JSON document per collection, read with the managed identity. Empty = memory |
| `STATE_PRIME_TIMEOUT_MS` | `20000` | How long start-up waits for the state blobs before serving with memory state |
| `CORTEX_STATE_DIR` | — | A directory instead of blobs — local development only |
| `CORTEX_CHAT_POLICY` | `all-staff` | `visibility` to apply Marketplace rules to chat |
| `CORTEX_CHAT_MAX_TURNS` | `40` | Turns per conversation |
| `CORTEX_AUTOMATIONS` | `true` | `false` stops the scheduler (runs by hand still work) |
| `CORTEX_AUTOMATION_TICK_SECONDS` | `60` | How often due automations are checked |
| `WEB_MAX_REPLICAS` (azd env) | `1` | Keep at 1: one writer for the state blobs |
| `MCP_MIN_REPLICAS` (azd env) | `1` | 0 if only testing |
| `CREATE_DATA`, `CREATE_SEARCH`, `SEARCH_SKU`, `SEARCH_SEMANTIC`, `DEPLOYER_PRINCIPAL_ID` (azd env) | `true`, `true`, `basic`, `disabled`, you | The round-4 resources. The deploy script sets them from its switches |
| `CREATE_PERIMETER`, `STORAGE_ACCESS_MODE`, `SEARCH_ACCESS_MODE` (azd env) | `true`, `Enforced`, `Learning` | The perimeter. The deploy script sets them from its switches |
| `STORAGE_PUBLIC_NETWORK_ACCESS` (azd env) | `Enabled`, then `SecuredByPerimeter` | What the Bicep writes on the storage accounts. Step 7b records `SecuredByPerimeter` once the association exists; never downgraded by the script |
| `NSP_NAME`, `CORTEX_BOOTSTRAP_JOB` (azd outputs) | `nsp-cortex`, `cortex-web-bootstrap` | Read by the scripts |

### How it fits together

**The two container apps, and the job.** Both apps are declared as services in `azure.yaml`, so `azd deploy` builds and pushes both. Both run `minReplicas: 1` — an MCP client, or a CTO, gives up long before a cold container starts. `cortex-web` also runs **`maxReplicas: 1`**, deliberately: application state — requests, Ask threads, chats, automations, access requests and the record of what an agent was built from — is **one JSON blob per collection** in the `state` container on the state account, read at start-up and written on every change **with the managed identity**, by one replica (`src/bff/state/store.js`). It survives restarts and redeploys; the route to a real store when the numbers grow is in `HANDOVER.md`. One rule governs it: nothing is written unless the blobs were read first, so a start with storage unreachable serves from memory and says so rather than overwriting what is there. The **job** `cortex-web-bootstrap` runs the web image with `node scripts/bootstrap.js --only=data --skip-roles`, as `id-cortex`; azd deploys services, not jobs, so the deploy script points the job at the web app's current image before each start.

**The perimeter.**

```
                     Network Security Perimeter nsp-cortex
                     profile "cortex" — inbound: managed identities in this subscription
   ┌─────────────────────────────────────────────────────────────────────────┐
   │  stcortexdata…  (sample data, ADLS Gen2)        SecuredByPerimeter, Enforced │
   │  stcortexstate… (state blobs)                   SecuredByPerimeter, Enforced │
   │  srch-cortex-…  (AI Search)                     Learning                     │
   └─────────────────────────────────────────────────────────────────────────┘
         ▲ id-cortex (web app: state, product previews · job: uploads, scan, attach)
         ▲ AI Search identity (indexers)      ▲ Purview identity (Data Map scan)
         ▲ Foundry identity (azure_ai_search tool → the search service)
         ✕ your laptop — outside by design; the job does the storage work
```

The policy's exclusion is the whole reason for the shape: a storage account inside a perimeter with public network access `SecuredByPerimeter` is governed by the perimeter's rules, and the Modify effect leaves it alone. Everything that reaches the accounts already used Entra tokens, so nothing above the adapters changed.

**The data behind a data product.**

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

**Agents and their tools.** Every Cortex-published MCP server sits behind API Management and needs `Ocp-Apim-Subscription-Key` on every call. Foundry will not carry a raw header on an MCP tool, so each server gets a **project connection** (category RemoteTool, CustomKeys) holding the key, and the tool names the connection through `project_connection_id`. One connection per server — when the connection's target and the tool's URL differ, Foundry uses the connection's, so a shared one would send every call to the same place. Connections are created when a skill is bootstrapped, when an agent is published, and again (idempotently) whenever an agent is built or rebuilt; the Cortex identity holds Foundry Project Manager on the account for this.

An agent whose tools lack their connections — built before round 4, or in a session whose records did not survive — is repaired the first time it fails with the 401: Cortex reads the definition Foundry holds, gives every API Management tool its connection, creates a new version and retries the turn (`services/agents.js ensureToolConnections`).

Every MCP tool is registered with `require_approval: 'always'`. A tool call therefore comes back to Cortex as an approval request; Cortex approves it server-side, records the server, tool and arguments, and continues the same response (up to `FOUNDRY_MAX_APPROVAL_ROUNDS`, default 6). The record is shown under the answer as **Tools this answer used**. That is the approval gate as this phase implements it: visible and attributable, not a button mid-conversation.

**Chat.** `/agent/<id>/chat` is a server-rendered conversation in its own window — no client JavaScript, like every other page. Each turn is a Responses call with `previous_response_id`, so Foundry keeps the thread; Cortex keeps the transcript and provenance for the person who had it. `CORTEX_CHAT_POLICY` is `all-staff` in this phase; `visibility` applies the Marketplace rules instead. The check runs on every turn.

**Automations.** `services/automations.js`. Two kinds — ask a named agent the same question, or re-run an approved request method through Ask inside the owner's captured permissions. A timer in the web app (`CORTEX_AUTOMATION_TICK_SECONDS`, default 60) runs whatever is due; each run is a draft in the automation's history and nothing else. Propose-only is structural: there is no field that could turn writing on.

**Identity and configuration.** One user-assigned managed identity, `id-cortex`, holds every permission (table in §1). No secrets in code. Configuration reaches the apps one of two ways, and the deploy script picks:

| `-ConfigSource` | What happens |
|---|---|
| `auto` (default) | Probes the vault. Public access disabled, or no data-plane answer → `direct`. Otherwise `keyvault` |
| `direct` | Endpoints and names go onto the container apps as environment variables; the three sensitive values (APIM key, App Insights connection string, Entra client secret) as Container Apps secrets |
| `keyvault` | The apps read `KEYVAULT_NAME` at startup |

Your sandbox vault has public network access disabled, and Azure Container Apps is not a Key Vault trusted service, so `auto` chooses **`direct`** — the vault is still *seeded* (an ARM deployment is a control-plane write) but never *read*. `Test-Cortex.ps1` prints which mode is live. `SECRET_CATALOGUE` in `src/bff/adapters/keyvault.js` is the contract between the two modes. Add a value there **and** in `infra/modules/containerapps.bicep`, or it works in one mode and not the other.

**Sign-in.** Container Apps built-in authentication terminates Entra sign-in before a request reaches the process and injects the claims as headers. `Set-CortexAuth.ps1` configures it: the app registration, the **groups claim** (`groupMembershipClaims = SecurityGroup`), a client secret minted once, redirect for anonymous visitors. It lives outside the Bicep, so a re-provision does not touch it. Four paths are **excluded** from sign-in because machines call them: `/api/health*` (the deploy and test scripts), `/api/index/refresh` (bootstrap) and `/shim/*` (API Management, on behalf of a published agent). Everything a person sees is behind sign-in. The shim trusts API Management's subscription key rather than checking one itself — acceptable for a proof of concept, listed in `HANDOVER.md` for the full build. Group membership is the whole governance model: `CORTEX_GROUP_NAMES` maps ids to names; `CORTEX_DEFAULT_GROUPS` (default `all-staff`) is what every signed-in user is treated as holding. Both are Bicep parameters, so a re-provision keeps them.

**Purview.** The app talks to the **Unified Catalog** at `https://api.purview-service.microsoft.com` (the `{account}.purview.azure.com` host is the legacy form) with api-version `2026-03-20-preview` — there is no GA version. Bootstrap writes the nine governance domains and fourteen data products there, and reads them back through the same API. Data products are created **published**; if the catalogue refuses (an owner is required, and bootstrap names you as one), the product is created as a **draft** instead and the Marketplace shows it with a "Draft in Purview" tag rather than hiding it. Roles are assigned through the Unified Catalog *Policies* API by bootstrap, as you. The **Data Map** plane is granted the same way by `--only=data`: Data Source Administrator, Data Curator and Data Reader on the root collection, for you and for the Cortex identity, through the collection's metadata policy. The Data Map itself is reached at `https://<account>.purview.azure.com` — sources and scans under `/scan`, assets under `/datamap/api` — and the sample-data account is registered there as `cortex-sample-data` with a system-ruleset scan that runs as the Purview account's own identity.

**The model.** Pinned: `gpt-5.4-mini` version `2026-03-17`, with `versionUpgradeOption: OnceCurrentVersionExpired`. The first live deployment failed because the template named a model with **no version**, ARM resolved the account's current default, and that default had moved onto a deprecating build (`ServiceModelDeprecating`). Both are now parameters, and the script checks the account's catalogue before provisioning. The approved model catalogue the Build page offers is the deployment(s) that exist: `FOUNDRY_MODEL`, plus any in `FOUNDRY_MODELS`. A model that is not deployed is not offered, because choosing it would fail at agent creation.

### Key Vault: the route back

Once a private endpoint exists, in this order:

1. VNet with a subnet delegated to `Microsoft.App/environments`.
2. **Recreate the Container Apps environment inside it.** A managed environment cannot be VNet-joined after creation, so `cae-cortex` and both apps are destroyed and rebuilt.
3. Private endpoint on the vault, plus a `privatelink.vaultcore.azure.net` private DNS zone linked to the VNet. Key Vault also supports the perimeter — adding it to `nsp-cortex` with a subscription rule is the lighter alternative to a private endpoint for the vault alone, and the policy exemption from step 7b can go once the full build has settled its network design.
4. `.\scripts\Deploy-Cortex.ps1 -ConfigSource keyvault`

The vault must use RBAC (`az keyvault update -n prdcorekveus -g PRDCOREPVW001 --enable-rbac-authorization true`) or the role assignment is silently ignored. Two azd environments must not share one vault: `cortex-environment-name` records the owner and the script warns before taking it over.

### Teardown

```powershell
.\scripts\Deploy-Cortex.ps1 -Reset
```

Removes only what Cortex created: the resource group `PRDCORECORTEX001` (both apps, the job, the environment, the identity, the search service, both storage accounts, the perimeter, and the policy exemption scoped to the group) and the local azd environment. Your APIM, Purview, Foundry, Key Vault, registry and monitoring are untouched.

Left behind on shared resources, remove by hand if you want a clean tenant: the `cortex` product in APIM and the skills' APIs, the role assignments for `id-cortex` (they dangle harmlessly once the identity is gone), the Key Vault secrets, the "Cortex" app registration, the demo Entra groups, the `cortex-ask` agent and the `cx-mcp-*` / `cortex-search` **project connections** in Foundry, the governance domains, data products and data assets in the Unified Catalog, and the `cortex-sample-data` source with its scanned assets in the Data Map.
