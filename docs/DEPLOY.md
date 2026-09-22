# Data Cortex - deployment and operations

This is the current runbook for `novo-demo-20260923-r3`, recorded **22 September 2026**. The [README](../README.md) contains the technical diagram; [ARCHITECTURE.md](ARCHITECTURE.md) explains boundaries and [DEMO.md](DEMO.md) contains the rehearsed presentation. Commands marked as mutations require operator approval for the actual environment; previous approvals are not standing authorization.

## 1. Current deployment

All apps run `prdcoreamlacr001.azurecr.io/cortex/web-cortex:novo-demo-20260923-r3` in `cae-cortex`, resource group `PRDCORECORTEX001`, with maintenance off.

| App | Theme | Ready revision | State container |
|---|---|---|---|
| `cortex-web` | Defra | `cortex-web--0000032` | `state` |
| `cortex-web-microsoft` | Microsoft | `cortex-web-microsoft--0000017` | `state-cortex-web-microsoft` |
| `cortex-web-novo` | Novo | `cortex-web-novo--0000014` | `state-cortex-web-novo` |

Use the [README application links](../README.md#current-release). The original full Novo About source is preserved with SHA-256 `43f42a42f2599de9cacb0ed8590bdeccd934e28bc0a024c5ef6f79e4b924a354`.

Shared infrastructure includes Foundry/Purview in East US; APIM, Container Apps, registry, storage and Search in North Europe. Review residency before customer reuse. Key Vault is supported, but the rehearsed apps use direct configuration and Container Apps secrets. Application Insights configuration is not proof of complete application instrumentation.

## 2. Prerequisites and access

Use Node.js 20+, npm, PowerShell 7, Azure CLI and azd. Docker is needed for local image builds; ACR remote builds are an alternative and incur usage.

```powershell
node --version
pwsh --version
az version
azd version
az login
az account set --subscription <subscription-id>
```

Check existing rights before requesting changes. Global Administrator does not imply Azure RBAC or Purview data-plane permissions.

| Plane | Required access depends on the operation |
|---|---|
| Azure management | Resource creation/update, registry build/push, identity and role assignment rights |
| Purview Unified Catalog | Catalogue/domain permissions for read, create, update and delete; not interchangeable with Azure account RBAC |
| Purview Data Map | Source/scan administration and asset curation/read roles |
| Storage | Network access plus data-plane roles; Search/Purview/workload identities need their own permissions |
| Foundry | Model/agent/connection access and native evaluation permissions |
| Foundry IQ | Project-managed-identity Search read access; Search identity model access when planning is enabled |
| External platforms | Approved Databricks endpoint entitlement, Fabric consent/policy and Studio environment capabilities |
| Teams/Microsoft 365 | App policies, channel provisioning, installation approval and relevant entitlements |

Do not use a broader role, an anonymous connector or a public-storage change as a silent fix. The native Search tool and IQ MCP use different identity contracts.

## 3. Inspect before provisioning

```powershell
npm ci
npm test
node .\scripts\bootstrap.js --dry-run
node .\scripts\bootstrap-demo.js
node .\scripts\sample-data.js --list
.\scripts\Deploy-Cortex.ps1 -WhatIfResources
```

The tests and listed dry runs do not mutate Azure. `-WhatIfResources` performs Azure discovery and local setup checks; it is not an offline command. Review create/reuse choices, subscription, regions, model/version, identities and images.

`infra\main.bicep` is the active entry point referenced by `azure.yaml`. Supply explicit parameters for a different estate; do not copy the sandbox defaults blindly. Inspect `scripts\Deploy-Cortex.ps1` parameter names and `infra\main.parameters.json`. The root `containerapps.bicep` is a legacy file, not the active azd module.

## 4. Deploy or update applications

The full `Deploy-Cortex.ps1` flow can provision resources, reconcile authentication/roles and bootstrap content. Use it only after reviewing those effects. **Never use its `-Reset` switch for demo-content cleanup**: that is a resource-group/environment deletion path.

`azure.yaml` declares `web` and `purview-mcp`. A base `azd deploy` or `-AppOnly` is not proof that both themed variants or the manual bootstrap job now use the same image.

For an already configured app, the narrow image-only operation is:

```powershell
# Cloud mutations: after approval, use a new immutable tag.
az acr build --registry <registry> --resource-group <registry-rg> `
  --image cortex/web-cortex:<release-tag> --file Dockerfile .

az containerapp update --name <app-name> --resource-group <cortex-rg> `
  --image <registry>.azurecr.io/cortex/web-cortex:<release-tag>

az containerapp show --name <app-name> --resource-group <cortex-rg> `
  --query "{latest:properties.latestRevisionName,ready:properties.latestReadyRevisionName}"
```

Repeat the approved image update for each intended app. Verify revision health, sign-in, state mode and real HTTP responses; template provisioning success alone is insufficient. Preserve per-app `PUBLIC_BASE_URL`, `CORTEX_THEME`, `STATE_CONTAINER`, all existing secret references and Entra callback URLs.

To create/reconfigure variants, review `Deploy-CortexVariants.ps1 -WhatIf` first. It requires a working direct-config source app, appends callback URLs, isolates state and refuses unrelated targets. It does not update its source app. Copying source configuration can omit later variant-specific settings, so review `CORTEX_CONNECTORS` and knowledge-model settings before using it for routine redeployment.

The manual `cortex-web-bootstrap` job is separate. Inspect its image, arguments and secrets before starting it; a web rollout does not update that job automatically. Prefer explicitly ordered bootstrap stages over an unreviewed stale job.

### Local development

Load the existing configuration without writing secrets to disk, then **replace deployed state settings before starting a local server**:

```powershell
. .\scripts\Set-CortexEnv.ps1 -WebApp cortex-web-novo -ResourceGroup PRDCORECORTEX001 -Quiet
$env:STATE_STORAGE_ACCOUNT = ''
$env:CORTEX_STATE_DIR = Join-Path $env:TEMP "cortex-local-$([guid]::NewGuid())"
$env:CORTEX_MAINTENANCE = 'false'
$env:CORTEX_AUTOMATIONS = 'false'
$env:ALLOW_UNAUTHENTICATED = 'true'
$env:LOCAL_DEV_USER = 'Local developer'
$env:LOCAL_DEV_GROUPS = 'all-staff'
npm start
```

This still calls real Azure and does not bypass storage network rules. `ALLOW_UNAUTHENTICATED` is local-only and must never be deployed. Do not add fabricated production auth headers from an untrusted client.

`Start-Local.ps1` is the older azd/Key Vault helper and requires a reachable configured vault; it is not a substitute for the direct-config setup above. Use test fixtures for offline development.

## 5. Rebuild sample content in order

Run mutations from an approved environment with the necessary network access. `Set-CortexEnv.ps1` must be dot-sourced; `--only` accepts one stage, not a comma-separated list.

| Stage | Command / purpose |
|---|---|
| Catalogue | `node .\scripts\bootstrap.js --only=purview --skip-roles` |
| Skills | `node .\scripts\bootstrap.js --only=apim --skip-roles` |
| Tool connections | `node .\scripts\bootstrap.js --only=connections --skip-roles` |
| Sample files and scan | `node .\scripts\bootstrap.js --only=data --skip-roles` from an authorised network/workload |
| Asset relationships | `node .\scripts\bootstrap.js --only=link --skip-roles` after the scan succeeds |
| Indexes | `node .\scripts\bootstrap.js --only=search --skip-roles` |
| Foundry IQ links | `node .\scripts\bootstrap.js --only=knowledge --skip-roles` |
| Demo agents/workflow | `node .\scripts\bootstrap-demo.js --apply --user-id=<approving-presenter-id>` in maintenance mode |

`--skip-roles` avoids role reconciliation; if permissions are insufficient, stop and review access rather than dropping that flag without approval. Connection bootstrap can enumerate existing MCP services; inspect its scope if the APIM instance is shared.

The fourteen-product pack includes stable legacy IDs `finance-ledger` and `endpoint-telemetry`. Upload verification and exact expected document counts prevent stale or missing rows from looking complete. Schema evolution is additive; incompatible retyping needs a reviewed migration. `--no-wait` only starts work: it does not prove scan/index success, and knowledge linking must wait.

Physical files are private. Data Map uses the storage ARM identity and `azure_datalake_gen2_path` assets; Unified Catalog relationships link the scanned assets to products. Search then reads those files and populates per-product indexes. Knowledge bootstrap writes the `cortexKnowledge*` attributes only after verification.

The seed script creates five analyst/reviewer agents, the operations GraphQL API, a draft Databricks wrapper and manual workflow `AUT-0001`. It merges those owned seed records into the three app-state containers and must not run alongside live writers. It starts no native red-team scan and schedules no recurring workflow.

The stock demo script targets the three container names shown in section 1 and the configured Databricks demo endpoint. Review that scope before reuse in another estate. Catalogue data-plane access must be available to both the operator and workload identity; if new domains require additional role assignments, request those explicitly rather than implying `--skip-roles` will supply them.

After catalogue updates, refresh each app's index from an authorised route/operator context. A process that holds stale in-memory state must be restarted before leaving maintenance after a reset.

### Foundry IQ configuration

Set both `SEARCH_KNOWLEDGE_MODEL_NAME` and `SEARCH_KNOWLEDGE_MODEL_ENDPOINT` only after approving the existing-model planning path. The planner deployment is `FOUNDRY_MODEL`; no model is created by those settings.

The recorded sandbox values are `gpt-5.4-mini` and `https://prdcorefdryeus001.openai.azure.com`. The Search identity has approved Cognitive Services OpenAI User access to the Foundry account; the project identity has Search Index Data Reader. Semantic ranking uses the free tier; Search remains Basic.

The stable minimal MCP contract (`2026-04-01`) was rejected by this sandbox endpoint. The rehearsed configuration uses `2026-08-01-preview`, an explicit existing planning model and extractive grounding output. Do not claim stable availability in another region or silently enable paid semantic/model capacity.

## 6. Source connectors and publishing

`CORTEX_CONNECTORS` is administrator-controlled metadata, not a place for secret values. Keep credentials in Container Apps secret references or supported managed identities. The browser cannot choose an arbitrary authenticated destination.

| UI category | Rehearsed path / prerequisite |
|---|---|
| Build Foundry IQ from Data Source | Configured ADLS Gen2/Blob-backed CSV product; index/base reuse and successful ingestion before catalogue publication |
| REST API to MCP | `cortex-demo-api`; selected catalogue-health GET with prefilled OpenAPI |
| GraphQL API to MCP | `cortex-demo-graphql`; fixed query `{ rows(first: 2) { id json } }` through the seeded API |
| Existing agent | Databricks `databricks-gpt-oss-20b`; draft wrapper, actual `source_agent` invocation required |
| Teams/Microsoft 365 | Download ZIP for a seeded native agent; installation is a separate tenant operation |

Metadata defaults to the selected source/signed-in team, with advanced fields available. Consent is never preselected. REST write methods require an additional explicit choice. Fixed GraphQL templates do not allow mutations/subscriptions or caller replacement of query text.

`cortex-demo-graphql` points to the seeded API `cx-art-86c659ca-57d0-4c0d-8116-05c7de96b5d7`, authenticating with the existing APIM-key reference. Never paste the key into example text. The seeded GraphQL API is bounded indexed-data access, not arbitrary database federation.

Operator scripts have distinct effects:

| Script | Effects requiring review |
|---|---|
| `Set-CortexIntegrations.ps1 -WhatIf` | Previews source configuration; applying can onboard Databricks identity, provision Fabric resources/credentials and grant scoped channel roles |
| `Enable-CortexFabricAI.ps1` | Tenant/group-scoped AI policy changes; preserve existing allowed groups and review cross-region processing |
| `Deploy-CortexStudio.ps1` | Creates/publishes the synthetic Studio source; review environment and authentication |
| `Set-CortexStudioConnector.ps1` | Configures the authenticated Studio connector and application credentials |
| `test-live-publishing.js` | Privileged container-side acceptance runner; `--apply` can create actual artefacts/assessments |

The Studio source pack excludes tenant-bound `.mcs` metadata. Fabric's operator invocation succeeded historically, but the dedicated connector remained model-policy blocked; Studio app-only S2S remained disabled. Never make a source anonymous to get a demo through.

## 7. Assurance and automation

The default existing-agent publishing form creates a usable **draft wrapper**, without a native scan. Review its current assurance before sharing.

**Test and publish** starts a billable version-pinned native assessment using `/openai/evals` and `/evaluationtaxonomies`, `2025-11-15-preview` and `Foundry-Features: Evaluations=V1Preview`. It requires durable state, activates generated scenarios and publishes only on complete non-empty passing evidence from prohibited-actions, task-adherence and sensitive-data-leakage evaluators.

**Publish with acknowledgement** is the advisory alternative for an authorised publisher. It records outstanding findings and the reviewed version without marking gates as passed. Native channel submission is separate and requires explicit consent, its assessment prerequisite, Bot Service setup and tenant approval.

Hosted evaluation runs failed with ACA-session 429 before sampling. Diagnose the recorded run; do not assume model-token quota or the web app's replica limit is responsible. No customer-managed session pool was found in the Foundry resource group. Ambiguous submissions are not automatically retried.

RAI reports map configuration to Microsoft principles/NIST AI RMF; jurisdiction-specific obligations are not assessed. Browser axe results and manual attestations are versioned evidence, not full WCAG certification. Keep sensitive reports access-controlled.

Automation allows one to five total steps, maximum three siblings in a stage. All must succeed before the next stage. Failed/empty/oversized results stop downstream work; source evidence and drafts are bounded and saved. AI proposals are editable and need approval. Use **manual** cadence for demos. Recurring schedules use captured owner context, not continuous Entra membership revalidation.

## 8. Maintenance and reviewed content reset

Reset is never part of a normal rollout. Back up source files, all affected state containers and selected resource definitions to an approved private location, then verify the backups. Old approval hashes must not be reused after reseeding.

Enable `CORTEX_MAINTENANCE=true` on all affected web apps and wait for ready revisions. The health endpoint remains available, user/shim routes return 503, and app schedulers/periodic refresh stop. Also inspect independent jobs, scans and external writers; maintenance cannot stop them.

```powershell
# Read-only cloud inventory; creates a new local plan file.
node .\scripts\reset-content.js --plan=reset-plan.json `
  --state-containers=state,state-cortex-web-microsoft,state-cortex-web-novo `
  --include-legacy
```

Review every exact ID, parent/container, fingerprint, warning and dependency. Unknown ownership is preserved, including discovered agents without Cortex builder/publication provenance. Additional exact orphan IDs can be supplied with `--include=reviewed-items.json` when creating a new plan.

```powershell
# Destructive: execute only after explicit approval of this exact plan.
node .\scripts\reset-content.js --plan=reset-plan.json --apply `
  --state-containers=state,state-cortex-web-microsoft,state-cortex-web-novo `
  --confirm=<approved-plan-hash> --writers-stopped
```

All targets/fingerprints are checked before deletion. Relationships between approved products/assets must be removed first. Progress is saved only after absence/deleted-state confirmation. HTTP 200 with `deleted:false` is an error. Stop for unsupported provider deletion or changed objects; a narrower retained-object plan needs explicit approval, not fabricated receipts.

The recorded refresh backed up 331 objects in private container `stcortexstatezha7pf/backup-cortex-20260922122439`. The user then retained 9 evaluations and 9 taxonomies after provider deletion refusal; 313 functional objects were confirmed deleted. Empty ADLS directory markers/ACLs, infrastructure, identities, external sources and unrelated `nyctaxi-v2` were preserved. This is historical evidence, not a reusable reset authorization.

Rebootstrap only after approved deletion is complete. Bring all apps online only after valid state and sample data are restored. Preserve source-system audit logs, backup retention and provider soft deletes.

## 9. Verification and troubleshooting

Use the existing `Test-Cortex.ps1` checks, then sign in and walk the [demo script](DEMO.md). Check `/profile`, `/help`, `/cortex`, `/map`, `/api/health/state`, physical-asset links and actual tool invocations. State must report blob rather than memory. A healthy BFF is not proof of Foundry tool access or tenant installation.

| Symptom | Safe interpretation / next step |
|---|---|
| Container URL looks empty / storage `AuthorizationFailure` | No public directory listing; inspect via an authorised identity/network, not a firewall bypass |
| `AuthorizationPermissionMismatch` | Check the actual caller's storage data-plane rights and propagation |
| Native Search access denied | Distinguish account/project/agent caller and connection type; do not add speculative grants. The demo uses IQ |
| IQ asks for a planning model | Check explicit planner mode, API version, existing deployment and Search-to-model access |
| Model answers without external delegation | Preserve `runtimeToolOptions()` and required tool-call validation |
| Foundry agent-name conflict | Existing agents must use `/agents/{name}/versions` |
| MCP 401 | Check per-target project connection and APIM subscription-key forwarding |
| Connection name is purge-protected | Use the existing stable replacement-name mechanism; do not purge secrets |
| Requests have no proposed holder | Verify `cortexAskable` metadata and refresh the catalogue |
| State missing / result appears before persistence | Check the selected container and write errors; avoid a second writer |
| Search bootstrap has stale counts | Review data/schema migration; knowledge linking must not publish on mismatched counts |
| Purview delete blocked by references | Detach only approved product/asset relationships before deleting endpoints |
| Native scan ACA-session 429 | Escalate hosted-runtime evidence; do not claim a passing scan or blindly upgrade capacity |
| Container exec 404 for a long command | Shorten the websocket command payload; prefer a reviewed script in the image |
| Container exec 429 | Honour the provided retry interval; do not repeatedly open sessions |

Keep credentials out of command output, logs and repository files. Azure billing can lag; record resource/model activity and monitor the approved budget rather than claiming an exact real-time cost.
