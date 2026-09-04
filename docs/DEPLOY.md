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

Cortex **reuses your existing Azure estate** — API Management, Purview, Foundry, Key Vault, the container registry and monitoring — and creates only two container apps and a managed identity of its own. The script then:

1. checks your tools and that no source file has been damaged in transit;
2. signs you in to Azure;
3. reports what will be **reused** and what will be **created**;
4. checks the pinned model version is still deployable;
5. registers resource providers, installs dependencies and vendors GOV.UK Frontend;
6. provisions with `azd up` (Bicep in `infra/`) and pushes both container images;
7. reconciles the live apps (image, ingress port);
8. puts the API Management subscription key onto the web app as a secret;
9. **switches on Entra sign-in with the groups claim** (`Set-CortexAuth.ps1`);
10. **grants the Cortex identity its Purview roles** and creates the Defra content (`npm run bootstrap`);
11. refreshes the app's register and health-checks everything.

Nothing is left for the portal. Steps 9 and 10 used to be manual — they are the two things that most often made a working deployment look broken, so they are scripted now and re-run safely.

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
| Key Vault `prdcorekveus` | Key Vault Secrets Officer | Only if the vault is used (§5). Missing it is a warning, not a failure |

A sandbox Global Administrator has the first four. The Purview one is a Purview-internal role that Global Administrator does **not** confer automatically — if bootstrap answers `403` to *your* account, this is why (§6).

### Permissions the *Cortex identity* gets — all automated

`id-cortex` is a user-assigned managed identity created by the Bicep. Everything it needs is granted for it:

| Resource | Role | Granted by |
|---|---|---|
| API Management | API Management Service Contributor | Bicep (`apim-existing.bicep`) |
| Foundry account | Foundry User, Foundry Agent Consumer | Bicep (`foundry-existing.bicep`) |
| Purview account | Reader (control plane) | Bicep (`purview-existing.bicep`) |
| **Purview Unified Catalog** | **Data Governance Administrator, Global Catalog Reader** (catalog level); **Governance Domain Owner** on each Cortex domain | **bootstrap** (`scripts/purview-access.js`), through the Unified Catalog Policies API |
| Container registry | AcrPull | Bicep |
| Key Vault | Key Vault Secrets User | Bicep (only matters in Key Vault mode) |

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
OK      gpt-5.4-mini 2026-03-17 is deployable (GenerallyAvailable)
```

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
  OK    Purview MCP server (5 tools)
```

Purview roles can take a minute to propagate after bootstrap grants them. If Purview alone is red straight after a deploy, wait a minute and run it again.

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

What the invitee sees: an email from *Microsoft Invitations* → **Accept** → the Cortex sign-in → on the first visit only, a prompt to accept this organisation's terms (and possibly MFA) → the Marketplace. They are treated as `all-staff` like everyone signed in, so they see the "Open to all staff" entries; anything more comes from groups. Tell them to use a **private browser window** if the computer is already signed in to Cortex as somebody else.

Two things this cannot do. It cannot override the invitee's **home tenant**: if that tenant blocks guest access to this one, redemption stops with an AADSTS error and the fix is on their side (or use an account that lives here). And it does not make the app multi-tenant — signing your corporate account in *directly* would need its tenant to consent to a sandbox app and would put that tenant's group ids in the token, which nothing here maps. Guest is the right shape.

### e. Walk the golden path once

Marketplace → an entry → Build an agent → test it → publish → it reappears in the Marketplace. Then **Ask a question** — the answer is written by the `cortex-ask` agent in Foundry from the catalogue entries you can reach, with the provenance panel underneath. Ask is live: if the model cannot be reached the page says so and falls back to the register's own summary.

---

## 4. Iterating — which command for which change

| You changed | Run | Time |
|---|---|---|
| Application code (`src/`) | `.\scripts\Deploy-Cortex.ps1 -AppOnly` | ~2 min. Builds and pushes both images, touches nothing else |
| Content (`bootstrap/*.json`) | `. .\scripts\Set-CortexEnv.ps1` then `npm run bootstrap` | ~1 min. Idempotent |
| Only Purview permissions | `. .\scripts\Set-CortexEnv.ps1` then `node scripts/bootstrap.js --only=roles` | seconds |
| Who can see what (groups) | `.\scripts\Set-CortexAuth.ps1 -GroupMap ...` | seconds |
| Infrastructure (`infra/`) | `.\scripts\Deploy-Cortex.ps1` | ~10 min |
| A setting the Bicep reads (`azd env set X y`) | `.\scripts\Deploy-Cortex.ps1 -SkipBootstrap` | ~5 min |
| The model | `.\scripts\Deploy-Cortex.ps1 -ModelName gpt-5-mini -ModelVersion 2025-08-07 -UpgradeModel` | ~5 min |

Two rules that keep iteration safe:

- **The leading dot on `Set-CortexEnv.ps1` is load-bearing.** It loads the deployment's configuration into *your* session so a local `node` process can talk to your Azure resources. Without it bootstrap stops with "Missing required configuration".
- **`npm test` before you push.** 214 tests, no Azure needed, about 15 seconds. `node scripts/bootstrap.js --dry-run` validates content changes the same way.

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

Both are declared as services in `azure.yaml`, so `azd deploy` builds and pushes both. Both run `minReplicas: 1` — an MCP client, or a CTO, gives up long before a cold container starts. `cortex-web` also runs **`maxReplicas: 1`**, deliberately: requests, Ask threads and the record of what an agent was built from live in memory, and a second replica would not share them. That is the first item of real next work in `HANDOVER.md`.

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

Roles are assigned through the Unified Catalog *Policies* API by bootstrap, as you (§1). The Data Map plane (collection roles such as Data reader) is **not** granted: it only matters once data products carry real data assets, and this proof of concept has none.

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
| Invitee: signs in and lands on the **wrong account** | The browser already holds another Cortex session | Private browser window, or sign out at `/.auth/logout` first |
| `Add-CortexUser.ps1`: **Authorization_RequestDenied** / 403 | You lack Guest Inviter / User Administrator in this tenant | Get the role, or invite from the Entra admin centre (Users → New user → Invite external user) with the Cortex URL as redirect |
| `/profile` lists **N unmapped group ids** | Entra sends group object ids; the rules read names. Nothing is broken — an id only matters once a rule refers to it | `.\scripts\Set-CortexAuth.ps1 -MapMyGroups` names every group you are in after its display name. `-GroupMap 'waste-crime=<Entra group>'` gives one a name a rule uses |
| `/profile` says **no named groups** | The token predates the groups claim, or the group ids are unmapped | Sign out and in. Map ids with `Set-CortexAuth.ps1 -GroupMap` |
| Marketplace looks almost empty; entries say "Licence does not cover you" | Strict mode with no group mapping | `Set-CortexAuth.ps1 -DefaultGroups all-staff`, or map groups |
| Page says **Sign-in is not configured** | Authentication is not on in front of the app | `.\scripts\Set-CortexAuth.ps1` |
| Ask shows **The model could not be reached** | Foundry refused or timed out; the reason is on the page | Check `/api/health/foundry`; the identity needs Foundry User on the account (Bicep grants it) |
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

Where to look: `/api/health`, `/api/health/purview`, `/api/health/apim`, `/api/health/foundry`, `/api/health/keyvault` return JSON with the underlying error text. `Test-Cortex.ps1` reads them for you.

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
| `-Reset` | Delete the Cortex resource group and the local azd environment, after typing the group name |

Every resource name and group is also a parameter: `-ApimName`, `-ApimResourceGroup`, `-PurviewName`, `-PurviewResourceGroup`, `-FoundryAccountName`, `-FoundryProjectName`, `-FoundryResourceGroup`, `-KeyVaultName`, `-KeyVaultResourceGroup`, `-RegistryName`, `-RegistryResourceGroup`, `-LogAnalyticsName`, `-AppInsightsName`, `-MonitoringResourceGroup`, `-CortexResourceGroup`, `-EnvironmentName`, `-Location`.

### The other scripts

| Script | Does |
|---|---|
| `Set-CortexAuth.ps1` | Sign-in, groups claim, group mapping, default group. Idempotent. `-MapMyGroups` names every group you are in; `-GroupMap` names specific ones; `-CreateGroups` creates them; `-RotateSecret` mints a new client secret |
| `Add-CortexUser.ps1` | Give a person access: finds them or sends a B2B guest invitation with Cortex as the landing page. `-Groups` adds them to Entra groups; `-NoEmail` prints the redemption link; `-Resend` re-invites |
| `Set-CortexEnv.ps1` | **Dot-source it.** Loads the deployment's configuration into the session for running bootstrap by hand. Nothing written to disk |
| `bootstrap.js` | `npm run bootstrap`. `--only=roles\|purview\|apim`, `--principal=<oid>`, `--skip-roles`, `--dry-run`, `--no-adopt` |
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
| `WEB_MAX_REPLICAS` (azd env) | `1` | Keep at 1 while state is in memory |
| `MCP_MIN_REPLICAS` (azd env) | `1` | 0 if only testing |

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

Removes only what Cortex created: the resource group `PRDCORECORTEX001` (both apps, the environment, the identity) and the local azd environment. Your APIM, Purview, Foundry, Key Vault, registry and monitoring are untouched.

Left behind on shared resources, remove by hand if you want a clean tenant: the `cortex` product in APIM and the skills' APIs, the role assignments for `id-cortex` (they dangle harmlessly once the identity is gone), the Key Vault secrets, the "Cortex" app registration, the `cortex-ask` agent in Foundry, and the governance domains and data products in Purview.
