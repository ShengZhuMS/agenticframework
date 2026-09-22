# Data Cortex - deploy, verify and iterate

Use PowerShell 7 on Windows. Follow sections 1-5 for a first deployment; use section 6 for subsequent changes. Sections 7-9 cover assessments, variants and destructive content reset.

**Current sandbox status (21 September 2026):** the follow-up authorizes updates to all three web apps, necessary Azure infrastructure, dedicated channel-app submission (not tenant-wide installation), and synthetic-only source discovery. All three now receive the integration release. Original content and separate state containers are preserved. The repaired catalogue has fourteen linked sample products and fourteen populated indexes. Agent publication still fails closed on Foundry's hosted ACA-session 429. The GraphQL and API-to-MCP paths have been exercised through APIM; not every cross-platform agent path is end-to-end operational. See section 11 for the exact remaining blockers. No full reset, new paid capacity or Microsoft 365 licence purchase was performed.

## 1. Understand the deployment

Data Cortex is a customer-neutral Microsoft technology accelerator over Purview Data Map and Unified Catalog, APIM and Foundry. It is not a replacement for those services or a production AI landing zone.

The standard deployment creates a web Container App, a Purview MCP Container App, a bootstrap job, an identity, AI Search, sample-data storage, blob-state storage and optionally a Network Security Perimeter. It can reuse existing platform services.

**Existing-deployment compatibility:** `Deploy-Cortex.ps1` retains the original sandbox resource-name defaults, including `PRDCORECORTEX001`. They are not generic defaults suitable for another customer. Supply every resource-name/group parameter for a new environment and inspect `-WhatIfResources` before proceeding. Do not reuse the existing deployment's azd environment for another customer's estate.

| Resource | Ownership and protection |
|---|---|
| APIM, Purview, Foundry, registry, monitoring, vault | Shared services; do not delete or replace them to refresh a demo |
| Original web and MCP apps | Retained; application-only deployment updates their images |
| Additional themed web apps | Created only by the separate variants script; never tagged as the original azd web service |
| State | One JSON blob per collection, one writer per container; never point two apps at the same state container |
| Demo records | Synthetic, but written to real Azure services; changes can affect every app sharing the catalogue |

## 2. Prerequisites and permissions

Install Node 20 or later, PowerShell 7, Azure CLI, Azure Developer CLI (`azd`), Git and Docker Desktop. Start Docker Desktop before a deployment.

```powershell
pwsh --version
node --version
az version
azd version
docker --version
az login
az account set --subscription <subscription-id>
```

If downloaded scripts are blocked, review them before removing their Mark of the Web with `Unblock-File`. The existing deployment script also unblocks repository scripts and runs its hook under an execution-policy bypass.

**Global Administrator does not automatically grant Azure subscription RBAC or Purview data-plane roles.** Check each plane:

| Plane | Deployer permissions |
|---|---|
| Azure subscription/resources | Contributor plus User Access Administrator where role grants are required |
| Registry | AcrPush |
| Entra | Application Administrator for sign-in; Groups Administrator for demo groups; appropriate guest-invitation rights |
| Purview Unified Catalog | Data Governance Administrator |
| Purview Data Map | Collection administrator able to grant Data Source Administrator, Data Curator and Data Reader |
| Storage | Data-plane access and network reachability when running data operations locally |
| Network/perimeter/policy | Rights to create associations; separate approval for any policy exemption |

The managed identity receives APIM and Foundry roles, storage/search access, and Purview roles through Bicep and bootstrap. Foundry, Search and Purview identities also need their documented downstream data access.

Do not weaken tenant policies or guest MFA requirements just to make a demo work. `-TrustHomeMfa` changes tenant-wide inbound trust; use only with identity-administrator approval. A policy exemption also changes governance and needs explicit approval.

### Network and configuration choices

With an enforced perimeter, your laptop cannot read or write the data/state blobs. Run storage-touching jobs from an approved Azure execution environment inside that boundary. The existing `cortex-web-bootstrap` job handles sample-data bootstrap.

The app supports Key Vault configuration or direct environment variables plus Container Apps secrets. A vault with public access disabled needs a valid private/perimeter network path; managed identity permissions alone do not make it reachable. The deployment script's `auto` mode chooses direct configuration when required.

## 3. Check source and inspect the resource plan

```powershell
npm test
node .\scripts\bootstrap.js --dry-run
node .\scripts\sample-data.js --list
.\scripts\Deploy-Cortex.ps1 -WhatIfResources
```

The first three are offline. `-WhatIfResources` performs Azure discovery and local setup checks: it is not an offline command. Confirm every `REUSE` and `CREATE`, subscription, group, model deployment/version and image.

For a new estate, use a dedicated azd environment and explicit parameters:

```powershell
.\scripts\Deploy-Cortex.ps1 -WhatIfResources `
  -SubscriptionId <subscription-id> -EnvironmentName <environment> `
  -CortexResourceGroup <cortex-rg> -Location <region> `
  -ApimName <apim> -ApimResourceGroup <apim-rg> `
  -PurviewName <purview> -PurviewResourceGroup <purview-rg> `
  -FoundryAccountName <foundry> -FoundryProjectName <project> -FoundryResourceGroup <foundry-rg> `
  -KeyVaultName <vault> -KeyVaultResourceGroup <vault-rg> `
  -RegistryName <registry> -RegistryResourceGroup <registry-rg> `
  -LogAnalyticsName <workspace> -AppInsightsName <insights> -MonitoringResourceGroup <monitoring-rg>
```

A model name/version in the source is not proof it is available in your region. Check the deployment plan and set `-ModelName`, `-ModelVersion`, and `-ModelDeploymentName` as needed.

## 4. Deploy the base application - after approval

Use the same reviewed parameters without `-WhatIfResources`. The existing script:

1. Checks tools, authentication, resource reuse and pinned model support.
2. Provisions and deploys the web and MCP images.
3. Reconciles image, ingress, revision health and storage/perimeter configuration.
4. Sets secrets and Entra sign-in with group claims.
5. Grants Purview roles and writes domains, products, skills and connections.
6. Runs the sample-data job inside Azure, links scanned assets, and builds search indexes.
7. Refreshes the register and reports health; any recorded failure must be resolved.

Do not use `-Reset` during iteration. It removes the original Cortex resource group, not just demo content.

### Neutral bootstrap and migration

`bootstrap\` is the single demo pack: nine neutral domains, fourteen synthetic data products, and six read-only sample skills. `sample-data.js` derives every schema from that pack. The obsolete unused `seed\` pack was removed.

New domains have `cx-demo-*` identifiers. Two historic generic product IDs (`finance-ledger`, `endpoint-telemetry`) remain stable. Search schema updates preserve existing fields and add new ones; retyping existing fields is refused. Old rows are not silently deleted. A clean replacement of retained historical datasets needs a reviewed content-reset plan.

Bootstrap does **not** silently delete the old sector-specific catalogue. Use section 9 to plan its removal, with approval. On a Basic Search tier, keeping both packs may exceed the index limit. Review the tier/capacity or remove the old demo indexes first; do not drop unrelated indexes.

For the known legacy pack, `node .\scripts\migrate-demo-indexes.js` is a read-only plan. It checks Foundry agents and versions before proposing removal of twelve allowlisted old demo indexes and their indexers/data sources. `--apply` requires explicit approval. The approved migration was executed in this sandbox; catalogue products, files, agents and unknown indexes were preserved. External consumers cannot all be discovered automatically. Search now preflights actual capacity and waits for eventually consistent document counts instead of reporting zero-row success.

## 5. Verify in the target environment

```powershell
.\scripts\Test-Cortex.ps1
.\scripts\Test-Cortex.ps1 -Diagnose
```

Then sign in and check `/profile`, `/help`, `/marketplace` and `/marketplace/map`. The Map uses live Purview domains; SVG positions are computed by Cortex, not geographical coordinates. Zero domains produces an explicit empty state; backend failures produce a stale/incomplete notice.

Walk a synthetic product through Data Map assets, AI Search grounding, agent creation, test/chat and APIM publication. Invoke a bootstrap skill: it must read the uploaded file, not return fabricated runtime business data.

Application state should report **blob**, not memory, at `/api/health/state`. An unavailable state container at startup disables persistence to avoid overwriting existing records. Repair storage and restart the revision before using the app.

## 6. Redeploy only what changed

Load the deployment configuration before standalone bootstrap commands:

```powershell
. .\scripts\Set-CortexEnv.ps1

# Existing deployment without a local azd environment:
. .\scripts\Set-CortexEnv.ps1 -WebApp cortex-web -ResourceGroup PRDCORECORTEX001
```

The leading dot is required. Commands below write to Azure unless stated otherwise.

| Change | Command |
|---|---|
| Web/MCP source | `.\scripts\Deploy-Cortex.ps1 -AppOnly` |
| Domains/products only | `node .\scripts\bootstrap.js --only=purview` |
| Skills/API/MCP only | `node .\scripts\bootstrap.js --only=apim` |
| Purview roles only | `node .\scripts\bootstrap.js --only=roles` |
| Foundry MCP connections | `node .\scripts\bootstrap.js --only=connections` |
| Link completed scan results | `node .\scripts\bootstrap.js --only=link` |
| Search indexes | `node .\scripts\bootstrap.js --only=search` |
| Data generator | Deploy the image, update the bootstrap job to that image, then run its data section inside Azure |
| Resume after provisioning | `.\scripts\Deploy-Cortex.ps1 -SkipProvision -SkipAuth` |
| Auth/group mapping | `.\scripts\Set-CortexAuth.ps1 -GroupMap 'operations=Cortex Operations'` |
| Infrastructure | Full deployment with the reviewed original environment parameters |
| Additional themed app | Section 8, with `-Only microsoft` or `-Only novo` |

`-AppOnly` does not bootstrap content. An `azd deploy` does not update a Container Apps **job**: the main script updates the job image before starting it. After a generator change, prefer the main resume path with the correct current image rather than running a stale job.

`--only` accepts one section, not a comma-separated list. Run connections and search as separate commands. `--skip=data,search` runs catalogue/skills/connections without laptop storage access. `--no-wait` starts scans/indexers but is not proof they completed. `--only=link` and `--only=search` finish those stages later.

Data Map registration includes the storage account ARM `resourceId`. Scans use `POST .../scans/{name}:run`; files use Atlas type `azure_datalake_gen2_path`. Unified Catalog registration supplies the scanned file's name, source identity and ADLS type properties before attaching it to a product. Re-running link does not start another scan.

### Local development

```powershell
.\scripts\Start-Local.ps1 -Groups all-staff,analysts,operations
```

Local app execution still calls real Azure. Never deploy `ALLOW_UNAUTHENTICATED=true`. Use a local state directory instead of inaccessible perimeter blobs. Test fixtures stub Azure calls; they are separate from runtime behavior.

## 7. Native Foundry red teaming and multi-agent tasks

### Red teaming

Open an agent and choose **Test and publish**. Newly created agents store the builder's Entra object ID; legacy agents require an authorized `cortex-redteam` reviewer. Only the initiator can read or operate their stored assessment.

1. Cortex persists a publication request and pins the current Foundry agent version.
2. It creates native evaluators and a generated prohibited-actions taxonomy, then enables every generated scenario under the documented sandbox policy. Taxonomy activation uses PATCH with the returned resource identity; a file reference alone is insufficient.
3. A background worker submits and monitors the scan automatically, including after application restart. No portal scan setup or manual polling is required.
4. Publication requires a non-empty, complete report: every sample passes each of the three distinct evaluators, with no failed/error results.
5. Only then are APIM REST/MCP endpoints published. Invocation pins the assessed version; rebuilding requires a new assessment before republishing.

Standalone reviewer-led assessments remain available. Their confirmation enables every generated scenario too. Neither workflow certifies that an agent is safe for production.

The integration follows the [Foundry cloud red teaming REST examples](https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/run-ai-red-teaming-cloud): `/openai/evals`, `/evaluationtaxonomies`, and evaluation runs, with `api-version=2025-11-15-preview` and `Foundry-Features: Evaluations=V1Preview`. This tests a **named, versioned agent**, not just its base model. Persistent state is mandatory before creating billable assessment resources.

The configured `FOUNDRY_MODEL` is the evaluator deployment for task adherence. Strategies are Flip, Base64 and IndirectJailbreak, with five turns per scenario; usage increases with generated scenario count. Confirm model/region availability and Foundry User permissions. The sandbox accepted native eval/taxonomy creation and enabled 28 generated scenarios, but two submitted runs failed with `SystemError: The ACA session initiation failed ... 429 (Too Many Requests)`. This is not an APIM or taxonomy-validation error. No customer-visible session pool was found in the Foundry resource group; investigate Foundry hosted evaluation capacity with Azure support rather than weakening the gate or silently retrying billable scans.

No generated jailbreak text is hardcoded in Cortex. Reports may contain sensitive test output; restrict access and retention. Use synthetic data and read-only tools: cloud assessment can exercise real agent tools. A completed scan is **not** automatic assurance approval.

After an ambiguous submission timeout, status is `submission-unknown`. Inspect the recorded evaluation in Foundry before starting another assessment; automatic POST retries could duplicate billable scans.

### Ordered agent workflows

**Automate a task** lets you choose two to five agent steps, with at least two distinct agents. Every step has its own instruction. The next agent receives the previous draft as untrusted data alongside the task; histories retain step outputs, sources and tools.

The first failed/empty/oversized result stops the chain. Handoffs are limited to 24,000 characters. Only the accountable owner sees and controls the workflow. Existing single-agent/method schedules are preserved.

Scheduled runs use captured owner permissions, not live directory membership resolution. Manual runs use the signed-in owner's current context. Access follows `CORTEX_CHAT_POLICY`; `visibility` is recommended for stricter demos. These are draft workflows, not a sandbox for arbitrary tools: connect only read-only agents/tools.

## 8. Two additional themed web apps

The existing app defaults to `CORTEX_THEME=defra`. `microsoft` and `novo` are original inspired presentations with neutral content, not copied websites, logos, or claims of customer endorsement.

Build and push an image first. `-Image` lets the variants use new code without updating the original app. Omit it only when intentionally reusing the original image. The variants script does not invoke azd.

```powershell
npm run build:assets
az acr login --name <registry>
docker build -t <registry>.azurecr.io/cortex/web-cortex:<unique-release-tag> .
docker push <registry>.azurecr.io/cortex/web-cortex:<unique-release-tag>

.\scripts\Deploy-CortexVariants.ps1 `
  -SubscriptionId <subscription-id> -ResourceGroup <cortex-rg> `
  -SourceApp <existing-web-app> `
  -Image <registry>.azurecr.io/cortex/web-cortex:<unique-release-tag> `
  -MicrosoftApp cortex-web-microsoft -NovoApp cortex-web-novo -WhatIf
```

Review, then run without `-WhatIf` and answer the confirmation. Use `-Only microsoft` or `-Only novo` to redeploy one.

The script requires a direct-config source with working Entra auth, a user-assigned identity and blob state. It copies configuration/secrets without printing values, creates `state-<app-name>` containers, and adds each callback URL to the source Entra registration **without removing existing redirects**. Initial ingress stays internal until authentication is configured. It refuses an unrelated existing target app.

The variants script never updates the source app. For this follow-up, the user separately approved deploying the new source image to `cortex-web` too. The Entra registration receives additional redirect URLs; the identity, APIM, Purview and Foundry backends remain shared. This is presentation/state isolation, **not customer data isolation**. Use separate platform resources and identities for real customer boundaries.

The script uses control-plane storage container creation, so a laptop need not cross the storage perimeter. It reads and writes one pinned ARM schema to avoid copying newer, unsupported CLI properties. Each target needs runtime storage access through the reused identity.

Deployed sandbox apps (same `cae-cortex` environment):

| App | URL | State container |
|---|---|---|
| Microsoft | https://cortex-web-microsoft.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io | `state-cortex-web-microsoft` |
| Novo | https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io | `state-cortex-web-novo` |

Both report healthy blob persistence and retain Entra authentication. Shared backend catalogue changes appear across all three apps; historical catalogue products were deliberately not removed. For job code changes, update `cortex-web-bootstrap` to the same image before starting it; do not run another scan just to redeploy web presentation.

## 9. Reset content without deleting infrastructure

**Destructive, opt-in and separate from deployment.** `reset-content.js` replaces the old reset script that only printed names. It inventories selected demo content and the selected app's complete state container. It never deletes Azure accounts, resource groups, Entra groups, app registrations, RBAC grants or shared platform services.

Run from an approved environment that can reach both data and state storage (inside the perimeter when enforced). Load the full deployment configuration first.

```powershell
# Read-only Azure inventory, writing a new local plan file:
node .\scripts\reset-content.js --plan=reset-plan.json

# Migration: also consider the historical sector-specific demo pack:
node .\scripts\reset-content.js --plan=legacy-reset-plan.json --include-legacy
```

Review **every item and warning**. Plans include exact endpoints, object IDs and content fingerprints, not a wildcard delete. The script discovers domain products, recorded agents/published APIs/connections, current skills, search resources, verified sample assets, scan/source, sample files, assessment resources and state blobs.

Unidentified orphan records are preserved, never guessed from an agent name. Lost state, externally created content, unlinked scan artifacts or assets with no verified sample-storage URL may require explicit IDs. Supply a JSON array of reviewed `{ "kind": "agent", "id": "exact-name" }` items using `--include=reviewed-items.json` **when creating a new plan**. Supported kinds are listed in `resourceUrl()`; there is no arbitrary-URL deletion.

Before planning/applying: stop all affected apps, automation schedulers, jobs and scans; snapshot state if retention is required; ensure no unrelated workload uses the selected content. Active or unknown-status scan runs block reset. If writers changed objects after the inventory, create a new plan. Shared backend deletion affects the original app and both variants. Each distinct state container needs its own reviewed plan.

```powershell
node .\scripts\reset-content.js --plan=reset-plan.json --apply `
  --confirm=<exact-hash-printed-during-planning> --writers-stopped
```

The apply phase checks target configuration and all fingerprints before deletion, stops on errors and records progress after each confirmed deletion. Re-running the same reviewed plan resumes completed items. A changed resource requires a new plan; do not forge its fingerprint. Keep the same confirmation hash when resuming.

After completing all plan items and resolving warnings, re-run bootstrap sections in order: Purview, APIM, connections, data inside Azure, link, search. Restart apps and confirm state persistence. Historical audit logs, backups and provider soft-delete retention are not erased by this script.

`Deploy-Cortex.ps1 -Reset` is different: it deletes the Cortex resource group and local azd environment. It also removes any additional apps placed in that group. It is not a demo-content reset.

## 10. Troubleshooting and settings

| Symptom | Check |
|---|---|
| Map blank in old deployment | Deploy the new view; live domains never contained SVG coordinates |
| No domains/partial map | `/help`, Purview roles, catalogue content, refresh errors |
| MCP missing subscription key | Rebuild tools; bootstrap connections; Foundry connection identity and target |
| New sample skill fails | Latest web image contains the shim; sample files uploaded; APIM forwards `Ocp-Apim-Subscription-Key` |
| Storage `AuthorizationFailure` | Network/perimeter access, not automatically an RBAC failure |
| Storage `AuthorizationPermissionMismatch` | Data-plane role assignment and propagation |
| State reports memory | Correct account/container, reachable storage at startup, then restart |
| Red team 400/404/403 | Preview API availability, supported evaluator deployment, pinned version, identity roles |
| Variant refuses Key Vault mode | Use a direct-config source; shared vault values could overwrite per-app URLs |
| Bootstrap query fails | Repair access first; product creation now stops rather than risking duplicates |
| New index schema rejected | Old product schema still exists; review and reset only the affected demo resources |
| Foundry secret deleted with purge protection | Connection bootstrap tries stable replacement names; never purge protected secrets |
| Native red-team ACA-session 429 | Foundry hosted evaluation capacity; publication fails closed and reports the service error |
| Scan 405 / unknown Atlas type / missing UC fields | Use this revision's bootstrap job image, then rerun the affected data/link section |
| Authentication sidecar fails | Check secret names and registration; original auth script can rotate a missing secret |
| Stale Entra token after role change | Sign in again; use device-code flow when the Windows broker reuses stale claims |

Key settings: `FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_MODEL`, Foundry ARM names; `PURVIEW_ENDPOINT`, `PURVIEW_ACCOUNT_NAME`; APIM subscription/group/service/key; `SEARCH_ENDPOINT`; `DATA_STORAGE_ACCOUNT`, `DATA_CONTAINER`; `STATE_STORAGE_ACCOUNT`, `STATE_CONTAINER`; `PUBLIC_BASE_URL`; `CORTEX_THEME`; `CORTEX_GROUP_NAMES`; `CORTEX_CHAT_POLICY`; `CORTEX_AUTOMATIONS`.

Keep one replica per state container. Keep infrastructure settings in the deployment parameters, not just one-off portal edits. Read [HANDOVER.md](HANDOVER.md) for implementation boundaries and [ARCHITECTURE.md](ARCHITECTURE.md) for the data flow.

## 11. Share your artefact and cross-platform integrations

### Publishing paths and metadata

Open **Share your artefact** and choose a publication type. Every path requires a name, description, purpose, accountable owner, contact, governance domain, semantic version, classification, licence, limitations and explicit source-authority confirmation. Optional registered dependencies feed the lineage view. Credentials are referenced by administrator-configured connectors, never submitted in the publishing form.

| Path | Implementation and boundary |
|---|---|
| Databricks/Fabric/Microsoft 365 source agent | A Foundry wrapper calls the source through an authenticated APIM tool. The wrapper is natively assessed before marketplace publication. The original agent remains in its platform. Remote source configuration is not made immutable by a wrapper version; source changes require reassessment. |
| Data product to GraphQL | Read-only GraphQL over the product's existing Search index. `rows(search, first)` returns `id` and JSON-encoded row content. Maximum 50 rows per resolver, 40 query fields and 8,000 query characters. This is not arbitrary database federation. |
| API to MCP | Import selected OpenAPI 3.0 JSON operations, then create a real APIM MCP projection. GET is the default. Other supported JSON methods require explicit confirmation. External `$ref` and `servers` are rejected; the connector fixes the destination and credentials. |
| Non-Copilot agent to Teams/Microsoft 365 | Assess a Foundry agent/wrapper, pin its endpoint version, provision a dedicated Azure Bot Service, and submit through `POST /agents/{name}/microsoft365/publish?api-version=v1`. This presents a custom-engine agent; it does not convert its implementation into a Copilot Studio agent. Tenant submission remains subject to administrator approval and licensing. |

Use synthetic data and read-only agents. A registered API's permitted write operations can change its source when called; enabling them is not a general-purpose sandbox. Gateway subscription keys and source permissions remain required.

### Configure source identities once

```powershell
.\scripts\Set-CortexIntegrations.ps1 `
  -ResourceGroup PRDCORECORTEX001 `
  -DatabricksHost adb-7405608443657059.19.azuredatabricks.net `
  -FabricCapacityId 11bb386e-6eba-41c5-9377-d5e7d7d7846c -WhatIf
```

After approval, run without `-WhatIf`. This script onboards the existing app identity into Databricks, creates/reuses a dedicated Fabric service principal and synthetic workspace, stores its secret in Container Apps, configures the three apps and grants the narrow Bot Service Contributor role in the Foundry resource group. It does not enable tenant AI settings automatically or add a Microsoft 365 source credential.

`CORTEX_CONNECTORS` is a JSON array of administrator-approved metadata. Source-specific fields:

- Databricks: `id`, `provider: "databricks"`, `baseUrl`, `scope: "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default"`. The source ID is a serving endpoint name.
- Fabric: `provider: "fabric"`, `baseUrl: "https://api.fabric.microsoft.com"`, Fabric `.default` scope, `workspaceId`, `clientId`, `tenantId`, `secretEnv: "CORTEX_FABRIC_SECRET"`. The source ID is `workspace-id/data-agent-id`. Use a service principal, not managed identity; runtime uses the published MCP endpoint, not the retired Assistants API.
- Copilot Studio/Microsoft 365 source: either a secured Direct Line connector (`baseUrl: "https://directline.botframework.com"`, `auth: "bearer-secret"`, `secretEnv`, matching `agentId`) or application-authenticated Direct Engine (`protocol: "direct-engine"`, environment API `baseUrl`, `scope: "https://api.powerplatform.com/.default"`, `clientId`, `tenantId`, `secretEnv`, and the published schema as `agentId`). Direct Engine requires the environment's app-only S2S preview to be enabled. No existing agent or channel is reconfigured automatically.
- Generic API: `provider: "openapi"`, approved `baseUrl`, and either `auth: "anonymous"`, configured OAuth `scope`, or `auth: "header"` with `header` and `secretEnv`. Service-principal OAuth also accepts `clientId`/`tenantId`.

The Bicep parameters `connectorConfiguration` and secure `fabricConnectorSecret`/`studioConnectorSecret` keep configuration reproducible. Before full infrastructure reprovisioning, load the current app settings or explicitly supply those values; empty defaults intentionally disable connectors. App-only image deployment preserves them. The base connector setup preserves separately configured Studio connectors. Never commit credentials or persist them in a PR body.

### Scoped Fabric AI policy

The operator explicitly approved a dedicated connector security group, not tenant-wide AI enablement. The initial OpenAI-subprocessor toggle was insufficient: Fabric uses the distinct `EnableAOAI` Azure OpenAI policy. The approved correction adds the connector group while preserving the existing administrator group, and reverts the unused subprocessor toggle:

```powershell
.\scripts\Enable-CortexFabricAI.ps1 -ApplicationId 0dc99e98-cb18-4427-a1ca-d2c241b51ec8 -WhatIf
```

Cross-region processing remains opt-in. During the resumed session the operator explicitly approved adding only the dedicated connector group to the existing `AllowSendAOAIDataToOtherRegions` policy, because Fabric documents this prerequisite:

```powershell
.\scripts\Enable-CortexFabricAI.ps1 -ApplicationId 0dc99e98-cb18-4427-a1ca-d2c241b51ec8 `
  -AllowCrossRegionProcessing -WhatIf
```

The approved change was applied while preserving the existing administrator group. Synthetic prompts/responses can therefore be processed outside the capacity's region for this connector. No other group was added and the OpenAI-subprocessor policy remains disabled. The last model invocation still returned 403 even after this change; protocol handshake success is not proof of model permission. Do not enable AI tenant-wide as a workaround.

`node .\scripts\provision-fabric-demo.js` previews a synthetic, instruction-only catalogue guide. `--apply` creates/publishes it through public Fabric APIs and invokes its MCP endpoint. It attaches no business data. `--operator` uses the already-authorized Azure CLI operator for management, while the runtime probe still uses the configured connector identity. That path created and published agent `7e478267-9ccf-4468-b05d-ec4ba9382c8b` in the dedicated workspace. An operator-authenticated MCP query returned its accurate synthetic catalogue explanation; the app's service-principal query still fails with HTTP 403, `OpenAI usage disallowed: Disallowed`. The source exists, but its unattended app integration is not yet operational.

### Live acceptance and current limits

The privileged runner executes **inside the app container**, so requests use the existing trusted ingress-header contract without exposing a public authentication bypass. Supply the approving operator object ID:

```powershell
az containerapp exec -g PRDCORECORTEX001 -n cortex-web-microsoft `
  --command "node scripts/test-live-publishing.js --graphql --user-id=<operator-object-id>"
```

Use `--apply` only to create the clearly named synthetic acceptance artefact. Omit `--graphql` for API-to-MCP, or use `--agent` for Databricks wrapper onboarding. These operations can incur Azure usage. APIM gateway propagation can lag successful control-plane creation; rerun the read-only acceptance command rather than creating another artefact.

Confirmed: ordinary Foundry chat preserved a synthetic word across two turns; dedicated Fabric credentials can access the new workspace; the synthetic Fabric agent answered through MCP with operator authentication; a synthetic Databricks request succeeded; GraphQL returned real indexed synthetic rows through APIM; the published MCP health tool was listed and invoked. A live wrapper test exposed APIM's single-argument raw-body mapping, now normalized only on the gateway-protected agent shim. After repair, popup chat returned SYNTHETIC through Foundry, APIM and the Databricks source.

Remaining blockers: native Foundry red-team runtime still returns ACA-session 429 on a fresh deployed-app retry; Fabric rejects the connector service principal's model invocation with 403 although operator access works; Copilot Studio rejects the dedicated app with HTTP 405 and the explicit message `App-only S2S access is not enabled for this environment`; and outgoing tenant channel publication still awaits a passing native assessment. These are not successful live publishing paths.

### Synthetic Copilot Studio source and authenticated connector

The reusable source is in `bootstrap\copilot-studio`. It was scaffolded and published with Microsoft Power Platform CLI 2.12.2 in the existing Dataverse environment. Agent schema: `cortex_SyntheticCatalogueGuide`; agent ID: `a6517ae7-32ad-4d5f-8c9a-6580a86d3b13`. It has no business data or external tools; web browsing and file analysis are disabled. Generated `.mcs` deployment metadata is excluded from Git and Docker.

Use PAC with an explicitly authenticated profile for the reviewed environment. The script preserves that profile rather than changing the user's global sign-in:

```powershell
.\scripts\Deploy-CortexStudio.ps1 `
  -EnvironmentUrl https://orge2c8e454.crm.dynamics.com -WhatIf

.\scripts\Set-CortexStudioConnector.ps1 -ResourceGroup PRDCORECORTEX001 `
  -EnvironmentId Default-f92adce5-4bb9-4361-a380-9deaeee24c67 -WhatIf
```

The operator separately approved the dedicated application's `CopilotStudio.Copilots.Invoke` application permission. App `5fa30651-a803-452f-888b-be77641f8880` is configured in all three apps; its secret is stored as a Container Apps secret, not in the source pack. No tenant-wide installation was performed.

The supported Direct Engine protocol uses bounded authenticated HTTP/SSE requests, rejects incomplete streams and interactive OAuth-card responses, and does not retry conversation POSTs. A known disabled-S2S response fails preflight before any new APIM resource or Foundry assessment is created. The source retains integrated user authentication: the proposed app-only sign-in change was not applied because a disabled environment feature cannot be fixed by making the agent anonymous.

Microsoft's [client documentation](https://github.com/microsoft/Agents-for-js/tree/main/packages/agents-copilotstudio-client) describes app-only access as a preview requiring environment enablement. The deployed environment must be enabled by the service owner/Microsoft before this unattended connection can work. Existing reset tooling does not delete Fabric/Studio source solutions or their Entra registrations; source-platform teardown needs a separately reviewed operation.

### Branding and presentation

Header marks were taken from the official homepages on 21 September 2026, not redrawn: Microsoft's `https://uhf.microsoft.com/images/microsoft/RE1Mu3b.png`, and Novo Nordisk's current `icon-logo-white-v2` glyph from its `clientlib-site/resources/fonts/icomoon.woff` asset. Local copies avoid third-party requests from the demo pages. Preserve company trademark rights and do not imply endorsement; obtain brand approval before external marketing use.

The About diagram expands the target landing zone into identity, networking, data/session services, security/governance, operations/FinOps and platform engineering. Its labels distinguish target design from deployed controls. Lineage shows declared registered relationships, not inferred runtime tracing.
