# What changed, and why

Fifteen files. Copy this folder over `agenticframework/` — the structure matches, so
everything lands where it belongs. Nothing outside these paths was touched, and no
file was deleted.

```
CHANGES.md                              (this file — delete it after reading)
azure.yaml                              MODIFIED
Dockerfile.mcp                          NEW
.dockerignore                           MODIFIED
.vscode/tasks.json                      MODIFIED
docs/DEPLOY.md                          MODIFIED
docs/HANDOVER.md                        MODIFIED
infra/main.bicep                        MODIFIED
infra/main.parameters.json              MODIFIED
infra/modules/containerapps.bicep       MODIFIED
infra/modules/foundry.bicep             MODIFIED
infra/modules/foundry-existing.bicep    MODIFIED
scripts/Deploy-Cortex.ps1               MODIFIED
scripts/Preprovision-Check.ps1          NEW
scripts/Test-Cortex.ps1                 MODIFIED
```

---

## Part 1 — the error

```
Failed: Azure AI Services Model Deployment: prdcorefdryeus001/gpt-4o-mini
ServiceModelDeprecating: The model 'Format:OpenAI,Name:gpt-4o-mini,Version:2024-07-18'
is in deprecating state and cannot be used for new deployments.
```

**Cause.** `infra/modules/foundry-existing.bicep` asked for a model by name and named
no version:

```bicep
model: {
  format: 'OpenAI'
  name: modelName      // and nothing else
}
```

With no version, ARM resolves the account's *current default*, which had moved to
`2024-07-18`. That version is Deprecated: existing deployments keep serving, new ones
are refused. The template had not changed — the default underneath it had.

`.azure/cortex/.env` shows exactly this: `CREATE_MODEL_DEPLOYMENT="true"` and
`MODEL_NAME="gpt-4o-mini"`, no version anywhere.

The second message in your terminal — *"A resource with this name already exists or is
in a conflicting state"* — is azd's generic mapping for a failed subscription
deployment. It is a red herring here. The real cause is the line above it.

**Fix, in four places.**

1. `foundry-existing.bicep` and `foundry.bicep` now take `modelVersion`,
   `modelDeploymentName`, `modelSkuName` and `modelVersionUpgradeOption`, and write
   `properties.model.version` explicitly. Default: **`gpt-5.4-mini` version
   `2026-03-17`** (GA, retires September 2027).

2. `versionUpgradeOption: 'OnceCurrentVersionExpired'`. The pinned version is held
   until Azure retires it, then moved forward automatically — instead of the
   deployment starting to fail on a re-run.

3. `Deploy-Cortex.ps1` reads `az cognitiveservices account list-models` before
   provisioning, and refuses to proceed if the pinned version is `Deprecating`,
   `Deprecated` or `Retired`. It prints the versions the account *will* accept and,
   if you have not pinned one, falls back to the newest deployable version rather
   than failing. It also checks the requested sku is offered for that version.

4. `scripts/Preprovision-Check.ps1` runs the same check as an azd `preprovision`
   hook, so a bare `azd up` is guarded too.

**To change model later:**

```powershell
.\scripts\Deploy-Cortex.ps1 -ModelName gpt-5-mini -ModelVersion 2025-08-07 -UpgradeModel
```

---

## Part 2 — surviving repeated deploys

Seven things would have bitten you on the second and later runs.

### 1. Every re-provision rolled the apps back to the placeholder image

`containerapps.bicep` hardcoded `image: 'mcr.microsoft.com/k8se/quickstart:latest'`.
`azd up` provisions *then* deploys, so run two would reset both apps to the
placeholder, then push the real image back for `web` only. A visible outage
mid-deploy, and a permanent rollback for anything azd does not deploy.

Now `webImageName` / `mcpImageName` are parameters fed from azd's own
`SERVICE_WEB_IMAGE_NAME` / `SERVICE_PURVIEW_MCP_IMAGE_NAME`. The placeholder is used
only when both are empty, which is the first run and nothing else.

Belt and braces: on a fresh clone azd has no record of the images, so the deploy
script and the pre-provision hook read the live image off each container app and feed
it back before provisioning.

Related: the readiness probe and target port are now only applied once a real image
is present. The placeholder listens on 80 and does not serve `/api/health`, so a
first provision used to hang on a probe that could never pass, then fail for a reason
unrelated to the template.

### 2. `cortex-purview-mcp` had never run your code

The Bicep created it and tagged it `azd-service-name: purview-mcp`, but `azure.yaml`
declared only `web`. azd deploys to declared services, so the MCP app served the
quickstart placeholder permanently — it existed, answered on its URL, and returned
nothing an agent could use. Glue 1 was not live.

Added: a `purview-mcp` service in `azure.yaml` and `Dockerfile.mcp` (same source
tree, entry point `src/purview-mcp/server.js`). `Test-Cortex.ps1` now checks its
`/health` and tells you to run `-AppOnly` if it 404s.

Its `minReplicas` went 0 → 1, as a parameter (`MCP_MIN_REPLICAS`). An MCP client
gives up long before a cold container starts, and this one is called by an agent
mid-answer.

### 3. The `azd-env-name` tag was hardcoded

```bicep
tags: { 'azd-env-name': 'cortex', ... }   // regardless of environmentName
```

azd finds its resources by that tag. You already have two environments —
`cortex` and `cortex-poc` — and both would have claimed the same resources. Now the
tag follows `environmentName`.

### 4. A changed `-Location` would wedge the deployment

A resource group's location is immutable, and `main.bicep` re-declared the group with
whatever `location` was passed. Now `Deploy-Cortex.ps1` reads the live group's
location and passes it as `cortexResourceGroupLocation`; new resources still go to
`-Location`.

### 5. Missing Key Vault permission failed the whole deployment

`seedKeyVault` was unconditionally true. Without Key Vault Secrets Officer the
deployment failed on a step that is not load-bearing — the app falls back to
environment variables and starts fine. The script now checks your role assignments on
the vault and turns seeding off with a warning instead. `-ForceSeedKeyVault`
overrides.

Also added: a `cortex-environment-name` secret recording which azd environment owns
the vault. Two environments sharing one vault silently overwrite each other's
endpoints; the script now warns before it takes the vault over.

### 6. Soft-deleted names

The literal message *"a resource with this name already exists or is in a conflicting
state"* is usually a soft-deleted Key Vault or Cognitive Services account still
holding its name. Checked before any create is attempted, with the recover/purge
command printed.

### 7. Failures were hard to resume from

- `azd env new` failed silently on an existing environment (`2>$null | Out-Null`, and
  native exit codes were never checked). The environment list is checked first now.
- After a partial provision the outputs are absent, and steps 8–10 failed with five
  confusing errors. There is now one clear message saying the deployment is
  incomplete and safe to re-run.
- `azd up` failure prints the four causes worth checking, in order.
- Docker not running is checked *before* provisioning, not after.
- Health checks retry three times with a back-off — a container app that has just
  taken a revision needs a moment.
- `Microsoft.ContainerRegistry` added to the provider registration list.
- AcrPush is checked and warned about, since a missing push right fails the deploy
  step after provisioning has already succeeded.

### New switches on `Deploy-Cortex.ps1`

| Switch | Use it when |
|---|---|
| `-AppOnly` | Code changed, infrastructure did not. Builds and pushes both images, nothing else. **This is your fast iteration loop** |
| `-UpgradeModel` | Move an existing model deployment onto the pinned model and version |
| `-Reset` | Start clean. Deletes the Cortex resource group and the local azd environment, after typing the group name to confirm |
| `-SkipHealthCheck` | Deploying into something not up yet |
| `-ForceSeedKeyVault` | The role check is wrong and you know you can write secrets |

`-WhatIfResources`, `-SkipProvision` and `-SkipBootstrap` are unchanged.

`-Reset` is deliberately narrow. It does **not** touch the Key Vault secrets, the
`cortex` product in APIM, the role assignments for the Cortex identity, or the Purview
domains and data products — those live on shared resources.

---

## What to do next

```powershell
# 1. Confirm the plan and that the model is deployable. Changes nothing.
.\scripts\Deploy-Cortex.ps1 -WhatIfResources
```

Expect a new line near the end:

```
OK      gpt-5.4-mini 2026-03-17 is deployable (GenerallyAvailable)
```

If instead it lists other versions, pin one of those with `-ModelVersion`.

```powershell
# 2. Deploy.
.\scripts\Deploy-Cortex.ps1

# 3. Confirm both apps are on real images, not the placeholder.
.\scripts\Test-Cortex.ps1
```

Then iterate with `.\scripts\Deploy-Cortex.ps1 -AppOnly` — seconds, not minutes, and
it cannot touch your infrastructure.

---

## Two things worth knowing

**`CORTEX_GROUP_NAMES` is still outside the Bicep.** Section 6d of the deployment
guide sets it with `az containerapp update`, and a later `azd provision` drops it,
because the template does not know about it. Re-run that line after any provision, or
move the mapping into `containerapps.bicep`. Flagged in `HANDOVER.md` §9.

**Container Apps authentication survives a re-provision.** The Entra sign-in
configuration from section 6 lives outside the Bicep in `Microsoft.App/containerApps
/authConfigs`, which the template does not declare, so provisioning leaves it alone.
You set it up once.

**Not verified against live Azure.** These changes were written against your error
output, your `.azure/cortex/.env`, and the current Azure model retirement schedule. I
could not run `az`, `azd` or `bicep build` here. The Bicep and PowerShell have been
structurally checked and the JSON and YAML parse, but the first run will be the real
test — start with `-WhatIfResources`, which changes nothing.
