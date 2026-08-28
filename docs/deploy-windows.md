# Cortex — Deploying to Azure from Windows

**Everything in Cortex is live. There is no demo mode, no sample data and no offline path — every screen reads Microsoft Purview, Azure API Management and Microsoft Foundry through their real APIs.**

Written for Windows 11 with Visual Studio Code and PowerShell 7.

---

## The short version

```powershell
git clone <your-repo> cortex
cd cortex
.\scripts\Deploy-Cortex.ps1
```

Or in VS Code: **Ctrl+Shift+P → Tasks: Run Task → Cortex: Deploy to Azure**.

That does everything it can. **Three steps cannot be automated** — sections 4, 5 and 6 — and the app will not work correctly until all three are done. Budget **90 minutes** for a first deployment, most of it waiting for API Management.

---

## 1. Prerequisites

| | Install |
|---|---|
| **PowerShell 7+** | `winget install Microsoft.PowerShell` |
| **Azure CLI** | `winget install Microsoft.AzureCLI` |
| **Azure Developer CLI** | `winget install Microsoft.Azd` |
| **Node.js 20+** | `winget install OpenJS.NodeJS.LTS` |
| **Docker Desktop** | `winget install Docker.DockerDesktop` |
| **Git** | `winget install Git.Git` |

Close and reopen your terminal afterwards so PATH updates.

```powershell
pwsh --version ; az version ; azd version ; node --version ; docker --version
```

### VS Code extensions

Open the folder in VS Code and accept the recommended extensions prompt, or:

```powershell
code --install-extension ms-azuretools.azure-dev
code --install-extension ms-azuretools.vscode-azurecontainerapps
code --install-extension ms-azuretools.vscode-bicep
code --install-extension ms-vscode.powershell
```

### If PowerShell blocks the scripts

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Permissions you need

| Scope | Role | For |
|---|---|---|
| Subscription | **Contributor** | Create resources |
| Subscription | **User Access Administrator** | Create role assignments |
| Key Vault | **Key Vault Secrets Officer** | Write the seeded values |
| Entra | **Application Administrator** | Create the sign-in app registration |
| Purview | **Data Governance Administrator** | Assign governance domain roles |

Without User Access Administrator, `azd up` fails partway through role assignment. Ask your subscription admin, or run `scripts/roles.ps1` afterwards with someone who has it.

---

## 2. What gets created

| Resource | SKU | Approx £/month |
|---|---|---|
| Container Apps environment | Consumption | ~0 idle |
| `cortex-web` | 0.5 vCPU / 1 GiB, min 1 replica | ~25 |
| `cortex-purview-mcp` | 0.25 vCPU / 0.5 GiB, scale to zero | ~3 |
| Container Registry | Basic | ~4 |
| Foundry account + project + model | S0, `gpt-5-mini` | pay per token |
| **API Management** | **Developer** (default) | **~40** |
| **Microsoft Purview** | Standard, 1 capacity unit | **~800** |
| Key Vault | Standard | ~0 |
| Cosmos DB | Serverless | ~2 |
| Log Analytics + App Insights | PAYG | ~5 |

> **Purview dominates the cost.** If the GIO landing zone already has Purview and APIM — your architecture deck says it does — point at those instead. It is cheaper and a more honest demo:
> ```powershell
> .\scripts\Deploy-Cortex.ps1 -UseExistingApim -ExistingApimName apim-gio-central
> ```
>
> APIM `Developer` tier has **no SLA**. Fine for a demo, not for anything else. Use `-ApimSku StandardV2` for production, at roughly £450/month.

---

## 3. Deploy

```powershell
.\scripts\Deploy-Cortex.ps1 -EnvironmentName cortex-poc -Location uksouth
```

The script checks prerequisites, signs you in, registers providers, installs dependencies, vendors the GOV.UK assets, provisions everything, onboards the APIM key, bootstraps the content and health-checks the result. It is safe to re-run.

**Common failures:**

| Symptom | Cause | Fix |
|---|---|---|
| `SkuNotAvailable` on APIM | v2 tiers are not in every region | `-Location westeurope`, or `-ApimSku Developer` |
| Model deployment quota error | Sandbox quota is low | `azd env set FOUNDRY_MODEL_CAPACITY 10` and re-run |
| `AuthorizationFailed` on a role assignment | You lack User Access Administrator | Ask your admin, then re-run with `-SkipProvision` |
| `RoleAssignmentExists` | Re-run after partial success | Harmless |
| Docker errors | Docker Desktop not running | Start it and re-run |

---

## 4. Manual step one — the APIM subscription key

The deploy script tries to do this for you. If it reported a warning:

```powershell
$kv = (azd env get-values | Select-String 'KEYVAULT_NAME="?([^"]*)"?').Matches.Groups[1].Value
az keyvault secret set --vault-name $kv --name apim-subscription-key --value "<primary key>"
```

Get the key from **Portal → API Management → Subscriptions → Cortex → Show/copy primary key**.

This is the one credential Cortex genuinely holds — it is a bearer token for every published MCP server. The full list of all 17 configuration values is in **`docs/keyvault.md`**; Bicep writes 12 of them and this is the only required one you set by hand.

---

## 5. Manual step two — Entra sign-in and the GROUPS claim

**Read this section carefully. Getting it half-right is the single most likely reason a working deployment looks broken.**

Cortex has no personas and no anonymous browsing. Every visibility decision is made against your Microsoft Entra group membership. A user whose token carries no groups claim appears to be in no groups, so almost every entry correctly resolves to "not available" — and the Marketplace looks empty for reasons that are not obvious.

### a. Create the app registration

```powershell
$webUrl = (azd env get-values | Select-String 'CORTEX_WEB_URL="?([^"]*)"?').Matches.Groups[1].Value
$app = az ad app create --display-name "Cortex" `
  --web-redirect-uris "$webUrl/.auth/login/aad/callback" `
  --enable-id-token-issuance true | ConvertFrom-Json
$app.appId
```

### b. Add the groups claim — do not skip this

```powershell
az ad app update --id $app.appId --set groupMembershipClaims=SecurityGroup
```

Or in the Portal: **App registrations → Cortex → Token configuration → Add groups claim → Security groups → tick ID and Access**.

### c. Turn on authentication

```powershell
$rg = (azd env get-values | Select-String 'AZURE_RESOURCE_GROUP="?([^"]*)"?').Matches.Groups[1].Value
$secret = (az ad app credential reset --id $app.appId --append | ConvertFrom-Json).password

az containerapp auth microsoft update --name cortex-web -g $rg `
  --client-id $app.appId --client-secret $secret `
  --tenant-id (az account show --query tenantId -o tsv) --yes

az containerapp auth update --name cortex-web -g $rg `
  --unauthenticated-client-action RedirectToLoginPage
```

### d. Map group ids to names

Entra sends group **object ids**, not names. Access rules read against names, so map them:

```powershell
$groups = @{
  'all-staff'           = (az ad group show --group "All Staff" --query id -o tsv)
  'waste-crime'         = (az ad group show --group "Waste Crime" --query id -o tsv)
  'ea-waste-regulation' = (az ad group show --group "EA Waste Regulation" --query id -o tsv)
}
$mapping = ($groups.GetEnumerator() | ForEach-Object { "$($_.Value)=$($_.Key)" }) -join ','
az containerapp update --name cortex-web -g $rg --set-env-vars "CORTEX_GROUP_NAMES=$mapping"
```

### e. Check it

Sign in and open **`/profile`**. It shows your groups and how many entries each visibility state resolves to. If it warns you are in no named groups, one of steps b or d is wrong.

---

## 6. Manual step three — Purview roles, in BOTH planes

**This cannot be automated.** Purview governance roles are assigned in the Purview portal, and tenant-level role groups do not accept service principals at all.

```powershell
azd env get-values | Select-String 'CORTEX_IDENTITY_PRINCIPAL_ID'
```

1. **Microsoft Purview portal → Unified Catalog → Catalog management → Governance domains.**
   For each domain — or the parent if you nest them — open **Roles** and add the Cortex identity as:
   - **Data Product Owner**
   - **Governance Domain Reader**

2. **Data Map → Domains and collections → your collection → Role assignments.**
   Add the same identity as **Data reader**.

> **Both planes are required.** A Data Product Owner without Data Map read cannot see the underlying assets — they silently do not appear, including in search. This is the most common way this setup fails, and it fails quietly.

The domains do not exist until you bootstrap, so the order is:

```powershell
node scripts/bootstrap.js --only=purview   # creates the domains
# ... assign the roles in the portal ...
npm run bootstrap                          # creates and publishes the data products
```

---

## 7. Bootstrap the content

```powershell
npm run bootstrap
```

Creates, in your real Purview: 9 governance domains and 14 data products, published. And in API Management: a REST API and an MCP server per skill.

Idempotent — re-running updates rather than duplicates. Validate without writing anything:

```powershell
node scripts/bootstrap.js --dry-run
```

> ⚠️ **Publishing is the least certain step in the whole deployment.** The Unified Catalog API has no publish operation — publishing is a status transition on a full-replace PUT, and the portal enforces preconditions whose API behaviour Microsoft does not document. If publishing is refused, the script falls back to creating the product as `DRAFT` and tells you. Publish those by hand in the portal.

---

## 8. Verify

```powershell
.\scripts\Test-Cortex.ps1
```

Or **Ctrl+Shift+P → Tasks: Run Task → Cortex: Health check**.

```
  OK    App and register
        23 entries across 9 domains
  OK    Key Vault
  OK    Purview
  OK    API Management
  OK    Foundry
```

All five green means the golden path will run. **Run this the morning of a demo**, not the night before.

If entries is 0, the register is empty — bootstrap has not run, or the Purview roles in section 6 are missing.

---

## 9. Running locally

There is no offline mode. Local means *your machine, real Azure*.

```powershell
.\scripts\Start-Local.ps1 -Groups all-staff,waste-crime,analysts
```

Or **F5** in VS Code (`Cortex: Debug locally`), which attaches the debugger.

Because nothing terminates sign-in in front of a local process, `ALLOW_UNAUTHENTICATED=true` simulates an identity with the groups you pass. The app logs a loud warning when it is set, and it must never be set on a deployed environment.

> Anything you publish locally is published for real. There is no sandbox.

---

## 10. Demo day

- [ ] `.\scripts\Test-Cortex.ps1` — all five green
- [ ] Sign in and open `/profile` — confirm your groups are as expected
- [ ] Walk the golden path once: Marketplace → entry → Build → test → publish → back to Marketplace
- [ ] Delete the agent you created in rehearsal, so the demo creates it fresh
- [ ] Confirm `cortex-web` has `minReplicas: 1` so nobody waits on a cold start
- [ ] Have a second signed-in account ready, in different groups, to show the same page through different eyes

> **There is no `DEMO_MODE` fallback any more.** You asked for everything real, and that is a genuine trade: if Purview is unreachable on the day, the Marketplace shows what it can and says what failed, rather than quietly substituting something that looks fine. Consider recording a walkthrough as insurance.

---

## 11. Teardown

```powershell
azd down --purge
```

`--purge` matters — without it Purview, Key Vault and the Foundry resource stay soft-deleted and their names stay reserved.

> APIM can take 45 minutes to delete. Key Vault and Purview keep a soft-deleted record for 7 and 14 days unless purged.

---

## 12. Known deviations from production

State these openly if asked. Having thought about them is worth more than hiding them.

| Deviation | Production route |
|---|---|
| **Public endpoints throughout.** Foundry reaches the APIM MCP server over the internet. | Private endpoints, a dedicated MCP subnet delegated to `Microsoft.App/environments`, internal-ingress container apps. |
| **APIM Developer tier** has no SLA. | Standard v2 or Premium, zone-redundant. |
| **Cortex owns the access-request workflow** rather than Purview. | Unchanged — Purview has no access-request API of any kind. A platform gap, not a shortcut. |
| **Requests, methods and threads are in memory.** They do not survive a restart. | Cosmos DB is provisioned and wired for the register; extend it to these. |
| **The Unified Catalog API is preview**, with no GA version. | Accept and monitor. Isolated behind one adapter. |
| Single region, no redundancy. | Paired region behind Front Door. |
