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
| Entra | **Application Administrator** | Create the sign-in app registration |
| Purview | **Data Governance Administrator** | Assign governance domain roles (section 6) |

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

The script installs dependencies, vendors GOV.UK Frontend, provisions, onboards the APIM key, bootstraps the content and health-checks the result. Safe to re-run.

| Failure | Fix |
|---|---|
| `AuthorizationFailed` on a role assignment | You lack User Access Administrator. Ask your admin, then re-run with `-SkipProvision` |
| Docker errors | Start Docker Desktop |
| `RoleAssignmentExists` | Harmless |
| Model not found | The script deploys `gpt-4o-mini` if absent. Override with `-ModelName` |

---

## 4. Key Vault secrets

**17 values. Bicep writes 11. You set one.**

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

`azure-subscription-id`, `azure-resource-group`, `apim-service-name`, `apim-gateway-url`, `foundry-project-endpoint`, `foundry-model`, `purview-endpoint`, `purview-mcp-url`, `public-base-url`, `appinsights-connection-string`, `entra-tenant-id`.

> **Only 3 of the 17 are genuinely secret** — the APIM key, the Entra client secret, and the App Insights connection string (which embeds an instrumentation key). The rest are endpoints and names that are already in the portal. Keeping them in the vault buys one real thing: a single place to change configuration per environment. It is not a security control, and it is worth not mistaking it for one.

### Foundry → APIM connection

So an agent can call an APIM MCP server:

```powershell
azd ai connection create cortex-apim --kind remote-tool `
  --target "$(az keyvault secret show --vault-name $kv --name purview-mcp-url --query value -o tsv)" `
  --auth-type custom-keys `
  --custom-key "Ocp-Apim-Subscription-Key=<the APIM key>"

az keyvault secret set --vault-name $kv --name foundry-mcp-connection --value "<connection id>"
```

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

## 5. Entra sign-in — and the GROUPS claim

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

### d. Map group ids to names

Entra sends group **object ids**; access rules read against names.

```powershell
$map = @(
  "$(az ad group show --group 'All Staff' --query id -o tsv)=all-staff",
  "$(az ad group show --group 'Waste Crime' --query id -o tsv)=waste-crime"
) -join ','
az containerapp update --name cortex-web -g $v.AZURE_RESOURCE_GROUP --set-env-vars "CORTEX_GROUP_NAMES=$map"
```

### e. Check

Sign in and open **`/profile`**. It lists your groups and how many entries fall into each state. If it warns you are in no named groups, step b or d is wrong.

---

## 6. Purview roles — BOTH planes

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
node scripts/bootstrap.js --only=purview   # creates the domains
# ... assign roles in the portal ...
npm run bootstrap                          # creates and publishes the data products
```

---

## 7. Bootstrap the content

```powershell
npm run bootstrap
```

Creates 9 governance domains and 14 data products in your real Purview, and a REST API plus MCP server per skill in your APIM. Idempotent.

```powershell
node scripts/bootstrap.js --dry-run   # validate payloads, no Azure needed
```

> ⚠️ **Publishing is the least certain step in the deployment.** The Unified Catalog API has no publish operation — it is a status transition on a full-replace PUT, and the portal enforces preconditions Microsoft does not document. If publishing is refused the script creates the product as `DRAFT` and tells you; publish those by hand.

---

## 8. Verify

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
```

All five green means the golden path will run. **Run this the morning of a demo.**

`entries: 0` means bootstrap has not run, or the Purview roles in section 6 are missing.

---

## 9. Run locally

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

## 10. Demo day

- [ ] `.\scripts\Test-Cortex.ps1` — five green
- [ ] Sign in, open `/profile`, confirm your groups
- [ ] Walk the golden path once end to end
- [ ] Delete the rehearsal agent so the demo creates it fresh
- [ ] Have a second account in different groups ready — the same page through different eyes is the most persuasive moment
- [ ] `cortex-web` has `minReplicas: 1`, so nobody waits on a cold start

> **There is no fallback if a back end is down.** That is the trade for everything being real. Record a walkthrough as insurance.

---

## 11. Teardown

```powershell
az group delete --name PRDCORECORTEX001 --yes
```

Removes only what Cortex created. Your APIM, Purview, Foundry, Key Vault, registry and monitoring are untouched.

To also remove what Cortex added to your existing resources: the `cortex` product in APIM, the role assignments for `id-cortex`, the Key Vault secrets, and the governance domains and data products created by bootstrap.
