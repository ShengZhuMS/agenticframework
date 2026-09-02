# Cortex — Deploy and Run

**Windows 11 · VS Code · PowerShell 7.** Everything is live — there is no demo mode and no offline path.

Cortex **reuses your existing Azure estate**. It creates only the container apps and its own managed identity.

---

## 1. Install the tools

```powershell
winget install Microsoft.PowerShell Microsoft.AzureCLI Microsoft.Azd OpenJS.NodeJS.LTS Docker.DockerDesktop Git.Git
```

Reopen your terminal, then check:

```powershell
pwsh --version; az version; azd version; node --version; docker --version
```

If PowerShell blocks the scripts:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

In VS Code, accept the recommended extensions prompt (Azure Dev CLI, Container Apps, Bicep, PowerShell).

### Permissions you need

| Scope | Role | Why |
|---|---|---|
| Subscription | **Contributor** | Create the container apps |
| Subscription | **User Access Administrator** | Create role assignments on your existing resources |
| Key Vault `prdcorekveus` | **Key Vault Secrets Officer** | Write the seeded values |
| Registry `prdcoreamlacr001` | **AcrPush** | Push the two container images |
| Entra | **Application Administrator** | Create the sign-in app registration |
| Purview | **Data Governance Administrator** | Assign governance domain roles (section 6) |

The deploy script checks the Key Vault and registry roles up front and tells you which one is missing, rather than failing eight minutes into a provision.

---

## 2. Check what will be reused

```powershell
git clone <your-repo> cortex
cd cortex
.\scripts\Deploy-Cortex.ps1 -WhatIfResources
```

Changes nothing. Expect:

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

Anything reported as CREATE that you expected to REUSE means the name or resource group is wrong. Override it:

```powershell
.\scripts\Deploy-Cortex.ps1 -WhatIfResources -ApimName my-apim -ApimResourceGroup my-rg
```

Every name and resource group is a parameter on both the script and the Bicep. Nothing is hardcoded.

---

## 3. Deploy

```powershell
.\scripts\Deploy-Cortex.ps1
```

Or **Ctrl+Shift+P → Tasks: Run Task → Cortex: Deploy to Azure**.

Roughly 10 minutes when reusing your estate — the long poles are creating APIM or Purview, and you are doing neither.

The script installs dependencies, vendors GOV.UK Frontend, provisions, onboards the APIM key, bootstraps the content and health-checks the result.

### Re-running it

**Designed for it.** Run the same command as many times as you like; it reconciles rather than recreates. Specifically:

| What used to break | What happens now |
|---|---|
| A second provision reset both apps to the `mcr` placeholder image mid-deploy | The running image is read off the live app and fed back into the template. Your deployed code survives a re-provision |
| An unpinned model version drifted onto a deprecated build | The model **and** version are pinned, and checked against the account's catalogue before anything is created |
| A changed `-Location` collided with the existing resource group | The group's real location is read and reused. New resources still go to `-Location` |
| Missing Key Vault Secrets Officer failed the whole deployment | Seeding is skipped with a warning; the app falls back to environment variables and still starts |
| A soft-deleted name gave "already exists or is in a conflicting state" | Checked before the create is attempted, with the recover/purge command printed |
| `azd env new` failed silently on an existing environment | The environment list is checked first |

### The switches

| Switch | Use it when |
|---|---|
| `-WhatIfResources` | You want the plan. Changes nothing |
| `-AppOnly` | Code changed, infrastructure did not. Builds and pushes both images, nothing else. This is the fast loop |
| `-UpgradeModel` | An existing model deployment should move onto the pinned model and version |
| `-SkipProvision` | Provisioning already succeeded and you are re-running the steps after it |
| `-SkipBootstrap` | You do not want to touch Purview content this run |
| `-SkipHealthCheck` | You are deploying into something that is not up yet |
| `-ForceSeedKeyVault` | The role check is wrong and you know you can write secrets |
| `-ConfigSource` | `auto` (default), `keyvault` or `direct`. See section 5 |
| `-Reset` | Start clean. Deletes the Cortex resource group and the local azd environment, after prompting |

`-Reset` is deliberately narrow. It does **not** remove the Key Vault secrets, the `cortex` product in APIM, the role assignments for the Cortex identity, or the Purview domains and data products — those live on shared resources and are removed by hand.

### When it fails

| Failure | Fix |
|---|---|
| `ServiceModelDeprecating` | The pinned version is no longer deployable. See section 4 |
| `AuthorizationFailed` on a role assignment | You lack User Access Administrator. Ask your admin, then re-run with `-SkipProvision` |
| Docker errors | Start Docker Desktop. The script now checks the daemon before provisioning |
| `RoleAssignmentExists` | Harmless |
| `A resource with this name already exists or is in a conflicting state` | Usually a soft-deleted resource holding the name. `-WhatIfResources` reports it and prints the recover command |

Nothing in the script is destructive except `-Reset`. Fix the cause and run the same command again.

---

## 4. The model, and why it is pinned

The first live deployment failed here, so it is worth understanding.

```
ServiceModelDeprecating: The model 'Format:OpenAI,Name:gpt-4o-mini,Version:2024-07-18'
is in deprecating state and cannot be used for new deployments.
```

The template asked for `gpt-4o-mini` and named **no version**, so ARM resolved the account's current default — which had moved to `2024-07-18`. That version is in the Deprecated lifecycle stage: existing deployments keep serving, new ones are refused. The template had not changed; the default underneath it had.

The fix is in two parts:

1. **Both the model and its version are parameters, and both are pinned.** Default: `gpt-5.4-mini` version `2026-03-17`.
2. **`versionUpgradeOption` is `OnceCurrentVersionExpired`.** The pinned version is held until Azure retires it, then moved forward automatically — rather than the deployment starting to fail on a re-run.

Before provisioning, the script reads `az cognitiveservices account list-models` and refuses to proceed if the pinned version is deprecating, listing what the account will accept instead.

To change model:

```powershell
.\scripts\Deploy-Cortex.ps1 -ModelName gpt-5-mini -ModelVersion 2025-08-07 -UpgradeModel
```

To see what the account offers:

```powershell
az cognitiveservices account list-models -g PRDCOREFDRY001 -n prdcorefdryeus001 `
  --query "[].{name:name, version:version, status:lifecycleStatus}" -o table
```

> The deployment name and the model name are separate parameters. Leave `-ModelDeploymentName` empty and the deployment is named after the model, which is the simple case. Set it when you want the application to keep asking for one name while the model underneath changes.

---

## 5. Configuration: Key Vault, or straight onto the apps

**Cortex runs either way. The deploy script picks, and tells you which.**

### The distinction that decides it

Key Vault firewall rules apply to the **data plane only**. A vault with
`publicNetworkAccess: Disabled` still accepts the secrets this template writes,
because an ARM deployment is a control-plane operation and the ARM deployment
service is a Key Vault trusted service. What it refuses is being **read** over
the public internet.

**Azure Container Apps is not on the trusted-services list**, and never will be
— that list covers services where Microsoft controls all the running code.
So in a locked-down subscription the vault seeds perfectly and is then
unreadable by the app: every lookup fails, the app falls back to environment
variables exactly as designed, and the marketplace is empty for reasons that
look like an application fault and are not.

| Operation | Plane | Blocked by a locked-down vault? |
|---|---|---|
| Bicep seeding the config values | Control | No |
| `az keyvault secret set` | Data | Yes |
| Opening the vault in the portal | Data | Yes |
| The app reading secrets at startup | Data | **Yes** |

### The two modes

| `-ConfigSource` | What happens |
|---|---|
| `auto` (default) | Probes the vault. Public access disabled, or no data-plane answer → `direct`. Otherwise `keyvault` |
| `keyvault` | Force the vault path. Use once a private endpoint is in place |
| `direct` | Skip the vault. Configuration goes onto the container apps, sensitive values as Container Apps secrets |

In `direct` mode `KEYVAULT_NAME` is deliberately **not** set on the apps. An
empty vault name makes the adapter skip cleanly rather than spend its 15-second
timeout budget failing at every start.

Confirm which mode is live:

```powershell
.\scripts\Test-Cortex.ps1
```

```
  OK    Key Vault
        Direct configuration — 14 values from the environment, no vault in use
```

`0 from Key Vault, 14 from environment` **with** a vault configured means the
app is still pointed at a vault it cannot reach. Re-run the deploy script.

### The security trade in direct mode

A Container Apps secret is encrypted at rest and stays out of the deployment
history, but it is readable by anyone with Contributor on the app:

```powershell
az containerapp secret list -n cortex-web -g PRDCORECORTEX001 --show-values
```

Key Vault behind a private endpoint is stronger — separate RBAC plane, access
logging, rotation. Direct mode is a reasonable trade for a sandbox and should
not go to production. See §5c for the way back.

### 5b. Key Vault secrets


**17 values. Bicep writes 12. You set one.**

### What you set by hand

| Secret | Required | Really secret | Where from |
|---|---|---|---|
| `apim-subscription-key` | **Yes** | **Yes** | Portal → APIM → Subscriptions → Cortex → primary key. The deploy script usually does this for you. |
| `entra-client-secret` | No | **Yes** | Sign-in app registration. Skip it if you use a federated credential. |
| `entra-client-id` | No | No | Only for real sign-in |
| `foundry-mcp-connection` | No | No | See below |
| `purview-datamap-endpoint` | No | No | Only if the default does not match yours |

```powershell
$kv = 'prdcorekveus'
az keyvault secret set --vault-name $kv --name apim-subscription-key --value "<primary key>"
```

### What Bicep writes

`azure-subscription-id`, `azure-resource-group`, `apim-service-name`, `apim-gateway-url`, `foundry-project-endpoint`, `foundry-model`, `purview-endpoint`, `purview-mcp-url`, `public-base-url`, `appinsights-connection-string`, `entra-tenant-id`, `cortex-environment-name`.

> **Only 3 of the 17 are genuinely secret** — the APIM key, the Entra client secret, and the App Insights connection string (which embeds an instrumentation key). The rest are endpoints and names that are already in the portal. Keeping them in the vault buys one real thing: a single place to change configuration per environment. It is not a security control, and it is worth not mistaking it for one.

### One vault, one environment

`cortex-environment-name` records which azd environment last seeded the vault. Two environments pointing at the same vault will overwrite each other's endpoints, and the symptom — an app talking to the wrong container — is not obvious. The deploy script reads this marker and warns before it takes the vault over. If you genuinely need two environments, give the second one its own vault with `-KeyVaultName`.

### Foundry → APIM connection

So an agent can call an APIM MCP server:

```powershell
azd ai connection create cortex-apim --kind remote-tool `
  --target "$(az keyvault secret show --vault-name $kv --name purview-mcp-url --query value -o tsv)" `
  --auth-type custom-keys `
  --custom-key "Ocp-Apim-Subscription-Key=<the APIM key>"

az keyvault secret set --vault-name $kv --name foundry-mcp-connection --value "<connection id>"
```

### 5c. The route back to Key Vault

Once a private endpoint exists, in this order:

1. VNet with a subnet delegated to `Microsoft.App/environments`.
2. **Recreate the Container Apps environment inside it.** A managed environment
   cannot be VNet-joined after creation, so `cae-cortex` and both apps must be
   destroyed and rebuilt. This is the expensive step — plan it.
3. Private endpoint on the vault, plus a `privatelink.vaultcore.azure.net`
   private DNS zone linked to the VNet.
4. `.\scripts\Deploy-Cortex.ps1 -ConfigSource keyvault`

This does not restore *your own* access — you are still outside the VNet, so
`az keyvault secret set` and the portal stay blocked without a jumpbox, Bastion
or VPN. The deploy script works around that by reading the APIM key from ARM
rather than expecting you to paste it.

If the vault sits behind a **Network Security Perimeter** rather than a plain
firewall, the trusted-services bypass is overridden and even ARM is blocked —
you need an explicit inbound access rule on the perimeter.

### If the vault uses access policies

`prdcorekveus` must have RBAC enabled or the role assignment is silently ignored. The deploy script warns. To fix:

```powershell
az keyvault update -n prdcorekveus -g PRDCOREPVW001 --enable-rbac-authorization true
```

### Behaviour when the vault misbehaves

| Situation | What happens |
|---|---|
| Unreachable | Falls back to environment variables, logs what is missing, **starts anyway** (~570ms) |
| Accepts then never replies | Bounded at 5s per secret, 15s total, then falls back |
| Secret missing | Falls back to environment. A 404 is normal, not a fault |
| 403 | Falls back, and the error names the fix: **Key Vault Secrets User** |

Secrets cache for 10 minutes, so a rotated key is picked up without a restart.

---

## 6. Entra sign-in — and the GROUPS claim

**Read this twice. Getting it half-right is the most likely reason a working deployment looks broken.**

Cortex has no personas and no anonymous browsing. Every visibility decision is made against Entra group membership. A token with no groups claim means the user appears to be in no groups, almost every entry correctly resolves to "not available", and the Marketplace looks empty for reasons that are not obvious.

```powershell
$v = @{}; azd env get-values | % { if ($_ -match '^(\w+)="?([^"]*)"?$') { $v[$Matches[1]] = $Matches[2] } }

# a. App registration
$app = az ad app create --display-name "Cortex" `
  --web-redirect-uris "$($v.CORTEX_WEB_URL)/.auth/login/aad/callback" `
  --enable-id-token-issuance true | ConvertFrom-Json

# b. THE GROUPS CLAIM — do not skip
az ad app update --id $app.appId --set groupMembershipClaims=SecurityGroup

# c. Turn on authentication
$secret = (az ad app credential reset --id $app.appId --append | ConvertFrom-Json).password
az containerapp auth microsoft update --name cortex-web -g $v.AZURE_RESOURCE_GROUP `
  --client-id $app.appId --client-secret $secret `
  --tenant-id (az account show --query tenantId -o tsv) --yes
az containerapp auth update --name cortex-web -g $v.AZURE_RESOURCE_GROUP `
  --unauthenticated-client-action RedirectToLoginPage
```

Container Apps authentication settings live outside the Bicep, so they survive a re-provision. You do this once.

### d. Map group ids to names

Entra sends group **object ids**; access rules read against names.

```powershell
$map = @(
  "$(az ad group show --group 'All Staff' --query id -o tsv)=all-staff",
  "$(az ad group show --group 'Waste Crime' --query id -o tsv)=waste-crime"
) -join ','
az containerapp update --name cortex-web -g $v.AZURE_RESOURCE_GROUP --set-env-vars "CORTEX_GROUP_NAMES=$map"
```

> `az containerapp update --set-env-vars` is additive on the live app, but the Bicep does not know about `CORTEX_GROUP_NAMES`, so a later `azd provision` drops it. Re-run this line after any provision, or move the mapping into `infra/modules/containerapps.bicep` once it settles.

### e. Check

Sign in and open **`/profile`**. It lists your groups and how many entries fall into each state. If it warns you are in no named groups, step b or d is wrong.

---

## 7. Purview roles — BOTH planes

**Cannot be automated.** These are data-plane roles assigned in the Purview portal, and tenant-level role groups do not accept service principals at all.

```powershell
azd env get-values | Select-String CORTEX_IDENTITY_PRINCIPAL_ID
```

1. **Purview portal → Unified Catalog → Catalog management → Governance domains → [domain] → Roles**
   Add the Cortex identity as **Data Product Owner** and **Governance Domain Reader**.

2. **Data Map → Domains and collections → [collection] → Role assignments**
   Add the same identity as **Data reader**.

> 🔴 **Both are required.** A Data Product Owner without Data Map read cannot see the underlying assets — they silently do not appear, including in search. This is the most common failure and it fails quietly.

Domains do not exist until you bootstrap, so:

```powershell
. .\scripts\Set-CortexEnv.ps1             # load config into this session — see section 8
node scripts/bootstrap.js --only=purview   # creates the domains
# ... assign roles in the portal ...
npm run bootstrap                          # creates and publishes the data products
```

> **The leading dot on the first line is load-bearing.** Without it bootstrap
> has no configuration and stops before it reaches Purview. See section 8.

The Cortex identity is stable across re-deployments — it is created once and reused — so you assign these roles once, not on every deploy. `-Reset` destroys it, and you will need to assign them again.

---

## 8. Bootstrap the content

```powershell
. .\scripts\Set-CortexEnv.ps1
npm run bootstrap
```

Creates 9 governance domains and 14 data products in your real Purview, and a REST API plus MCP server per skill in your APIM. Idempotent.

### Why the first line is needed

`bootstrap.js` reads configuration the same way the app does — Key Vault first, environment variables second. **But bootstrap runs on your machine, not in the container.** The deployed apps get their configuration from provisioning; this local Node process has neither that nor a readable vault, because public network access is disabled and a secret read is a data-plane operation.

Without it you get:

```
Missing required configuration:
  - azure-subscription-id
  - azure-resource-group
  - apim-service-name
  - apim-gateway-url
  - apim-subscription-key
  - foundry-project-endpoint
  - purview-mcp-url
  - public-base-url
```

That is not a Purview problem, a roles problem or a network problem. It is the eight entries marked `required` in `SECRET_CATALOGUE` resolving to nothing, and bootstrap stopping before it makes a single call.

`Set-CortexEnv.ps1` reads what provisioning published into the azd environment, fetches the APIM subscription key from API Management's ARM endpoint — a control-plane call, so the Key Vault firewall does not apply — and sets both for the session. **Nothing is written to disk**; the key lives in that window's memory and goes when you close it.

**It must be dot-sourced.** `.\scripts\Set-CortexEnv.ps1` runs in a child scope and its variables are discarded on exit. The script detects this and refuses rather than appearing to work.

`Deploy-Cortex.ps1` does the same thing in-process, so bootstrap during a full deployment needs no preparation. This is only for running bootstrap by hand.

```powershell
node scripts/bootstrap.js --dry-run   # validate payloads, no Azure and no config needed
```

> ⚠️ **Publishing is the least certain step in the deployment.** The Unified Catalog API has no publish operation — it is a status transition on a full-replace PUT, and the portal enforces preconditions Microsoft does not document. If publishing is refused the script creates the product as `DRAFT` and tells you; publish those by hand.

---

## 9. Verify

```powershell
.\scripts\Test-Cortex.ps1
```

```
  OK    App and register
        23 entries across 9 domains
  OK    Key Vault
  OK    Purview
  OK    API Management
  OK    Foundry
  OK    Purview MCP server (4 tools)
```

All six green means the golden path will run. **Run this the morning of a demo.**

`entries: 0` means bootstrap has not run, or the Purview roles in section 7 are missing.

A 404 from the MCP server means that app is still on the placeholder image — run `.\scripts\Deploy-Cortex.ps1 -AppOnly`.

---

## 10. The two container apps

Cortex deploys two images from one source tree:

| App | Image | Serves | Why separate |
|---|---|---|---|
| `cortex-web` | `Dockerfile` | The GOV.UK front end and the BFF, port 3000 | The front door |
| `cortex-purview-mcp` | `Dockerfile.mcp` | `/mcp` and `/health`, port 3000 | A Foundry agent cannot reach the catalogue any other way. It is called by the agent, not by a browser |

Both are declared as services in `azure.yaml`, so `azd deploy` builds and pushes both. Before that they shared one declaration, and the MCP app ran the placeholder image permanently — the app existed, answered on its URL, and returned nothing an agent could use.

The MCP app runs `minReplicas: 1` for the same reason the web app does: an MCP client gives up long before a cold container finishes starting, and it is called mid-answer. Set `MCP_MIN_REPLICAS=0` in the azd environment if you are only testing.

---

## 11. Run locally

Local means *your machine, real Azure*. There is no offline mode.

```powershell
.\scripts\Start-Local.ps1 -Groups all-staff,waste-crime,analysts
```

Or **F5** in VS Code to attach the debugger.

Nothing terminates sign-in in front of a local process, so `ALLOW_UNAUTHENTICATED=true` simulates an identity with the groups you pass. The app logs a loud warning when it is set. **Never set it on a deployed environment.**

```powershell
npm test                              # 127 tests, no Azure needed
node scripts/bootstrap.js --dry-run   # validate content, no Azure needed
```

> Anything you publish locally is published for real. There is no sandbox.

---

## 12. Demo day

- [ ] `.\scripts\Test-Cortex.ps1` — six green
- [ ] Sign in, open `/profile`, confirm your groups
- [ ] Walk the golden path once end to end
- [ ] Delete the rehearsal agent so the demo creates it fresh
- [ ] Have a second account in different groups ready — the same page through different eyes is the most persuasive moment
- [ ] `cortex-web` has `minReplicas: 1`, so nobody waits on a cold start
- [ ] Do not deploy on the day. If you must, use `-AppOnly` — it does not touch infrastructure

> **There is no fallback if a back end is down.** That is the trade for everything being real. Record a walkthrough as insurance.

---

## 13. Teardown

```powershell
.\scripts\Deploy-Cortex.ps1 -Reset
```

Or by hand:

```powershell
az group delete --name PRDCORECORTEX001 --yes
```

Removes only what Cortex created. Your APIM, Purview, Foundry, Key Vault, registry and monitoring are untouched.

To also remove what Cortex added to your existing resources: the `cortex` product in APIM, the role assignments for `id-cortex`, the Key Vault secrets, and the governance domains and data products created by bootstrap.
