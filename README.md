# Data Cortex

**Turn existing data, APIs and agents into reusable, governed AI capabilities.** Cortex connects Microsoft Purview, Azure AI Search / Foundry IQ, Microsoft Foundry and Azure API Management through one application.

Ask a question or search the catalogue, build a data-backed agent, share an artefact, request an answer from a data holder, or compose a reviewed multi-agent workflow. Microsoft, Novo and Defra presentations share the same implementation, with separate application state.

> **Prototype, not a production certification.** Demo records are synthetic; connected Azure services and model usage are real. Catalogue visibility, workload permissions and tenant installation are different controls. A successful demo does not establish production security, regulatory compliance or full WCAG conformance.

## Current release

Last recorded deployment and rehearsal: **22 September 2026**, for the 23 September Novo demonstration. All three apps use `prdcoreamlacr001.azurecr.io/cortex/web-cortex:novo-demo-20260923-r3`. These are dated observations, not a continuous availability guarantee.

| Presentation | Application | Ready revision | State container |
|---|---|---|---|
| [Novo demo](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io) | `cortex-web-novo` | `0000014` | `state-cortex-web-novo` |
| [Microsoft](https://cortex-web-microsoft.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io) | `cortex-web-microsoft` | `0000017` | `state-cortex-web-microsoft` |
| [Defra](https://cortex-web.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io) | `cortex-web` | `0000032` | `state` |

The full original Novo About content is preserved. Theme changes do not create separate tenants or isolated backend estates.

## Technical solution architecture

![Simplified Cortex architecture: Azure Storage data flows through Azure AI Search and Foundry IQ to Microsoft Foundry agents, then to people through Cortex on Azure Container Apps. Microsoft Purview provides governance; API Management connects existing APIs and agents.](docs/images/cortex-architecture.svg)

**The main flow:** store data -> retrieve facts -> use evidence -> answer people.

Purview provides catalogue/governance context; API Management supplies reusable tools. [View full-size diagram](docs/images/cortex-architecture.svg). Icons are illustrative, not official product logos.

<details>
<summary>Text alternative and implementation boundaries</summary>

Azure Storage holds the source files. Azure AI Search indexes those files, and Foundry IQ retrieves relevant records. Microsoft Foundry agents use that evidence to answer questions through Cortex, hosted on Azure Container Apps. Microsoft Purview links catalogue items to physical assets and their ownership. Existing REST/GraphQL APIs and agents supply additional capabilities through API Management and approved connectors.

The foundation uses Entra ID and managed identities, Key Vault or application secrets, Azure Monitor/Log Analytics, private Blob state, Container Registry and Bicep. Resource-specific network controls include Azure Network Security Perimeter. Search indexes contain derived copies; catalogue metadata is not the source dataset.

Fabric and Copilot Studio have separate prerequisites. Teams/Microsoft 365 package generation does not imply tenant installation. Key Vault and monitoring availability depend on configuration. The sandbox spans East US and North Europe, so residency must be reviewed for customer use.

</details>

For service identities, API contracts, infrastructure details and known blockers, see the [technical architecture guide](docs/ARCHITECTURE.md).

## What works, and what remains conditional

| Capability | Current implementation and evidence |
|---|---|
| Discovery | One Ask/Search entry with an override; live catalogue filters, Map and declared lineage; old `/marketplace` URLs remain compatible |
| Data-backed agents | Five analyst/reviewer blueprints; real indexed SYN-17 values retrieved through Foundry IQ; private owner-scoped chat with an accessible bottom-right dialog |
| Publishing | Configured CSV sources to Foundry IQ; selected REST and fixed GraphQL queries to MCP; actual Databricks delegation; Teams/Microsoft 365 ZIP generation |
| Automation | Editable AI proposals; one to five steps, at most three in parallel; all-success joins; structured evidence handoff; manual demo runs |
| Requests and Help | Holder-supported requests with preserved input; documentation-grounded, tool-free guide assistant; no automatic access grant |
| Assurance | Microsoft Responsible AI / NIST mappings, current-version scan evidence, browser axe checks and manual review records; advisory publishing requires explicit acknowledgement |
| External prerequisites | Native red-team runs blocked before sampling by hosted ACA-session 429; Fabric connector model-policy and Studio S2S restrictions remain; tenant channel installation and manual WCAG sign-off are not completed claims |

The live Novo workflow completed all five steps in approximately 37 and 53 seconds. Those are rehearsal timings, not latency guarantees. See [the presenter script](docs/DEMO.md) for exact prompts, expected values and fallback wording.

## Developer start

Requires Node.js 20+, npm and PowerShell 7 for the Windows operator scripts. Azure CLI/azd and resource access are needed only for live operations.

```powershell
npm ci
npm test
node .\scripts\bootstrap.js --dry-run
node .\scripts\bootstrap-demo.js
node .\scripts\sample-data.js --list
```

Tests stub Azure; the bootstrap dry runs do not mutate cloud resources. Browser tests use `playwright-core` with an installed Edge/Chromium executable (`CORTEX_BROWSER_EXECUTABLE` overrides the Windows default). The application itself has **no offline demo mode**.

For live local development, follow [the isolated local-state instructions](docs/DEPLOY.md#local-development). Do not copy a deployed state-container setting into a second writable app instance.

## Deployment and reproducible demo data

`azure.yaml` deploys the base `web` and `purview-mcp` services; it does not automatically align both themed variants or the manual bootstrap job. `infra\main.bicep` is the active infrastructure entry point. The root `containerapps.bicep` is a legacy template, not the azd entry point.

Bootstrap stages are **catalogue -> sample files/scan -> asset links -> indexes -> knowledge connections -> demo agents/workflow**, with APIM skills/connections alongside them. Source and knowledge setup must be verified before agent creation. Use [DEPLOY.md](docs/DEPLOY.md), not an unreviewed full deployment, for an existing estate.

**Reset is a separate destructive operation.** Maintenance, verified backups, explicit object review and confirmation hashes are mandatory. The latest approved refresh deleted 313 objects and retained 18 provider-side evaluation/taxonomy records; no historical approval authorizes another reset. Do not use the infrastructure-level `Deploy-Cortex.ps1 -Reset` for content cleanup.

## Documentation map

| Document | Audience and purpose |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | Technology, infrastructure, trust boundaries, data flows and API contracts |
| [Deployment runbook](docs/DEPLOY.md) | Configuration, safe rollout, bootstrap, maintenance, reset and troubleshooting |
| [Developer handover](docs/HANDOVER.md) | Code ownership, implementation invariants and next-engineer guidance |
| [Demo script](docs/DEMO.md) | Presenter walkthrough and dated live rehearsal evidence |
| [Change report](CHANGES.md) | Current release and explicitly historical changes |
| [Integration lessons](FIXES.md) | Failure signatures, root causes and safe remedies |
| [Historical documentation index](docs/CHANGES.md) | Superseded notes and the current sources of truth |
