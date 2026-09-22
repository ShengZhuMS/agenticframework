# Data Cortex - technical architecture

This document describes the implementation and the **22 September 2026** deployment snapshot. The [README architecture diagram](../README.md#technical-solution-architecture) is the visual overview; [DEPLOY.md](DEPLOY.md) describes operations. Rehearsed capabilities and external blockers are not interchangeable.

## Technology and infrastructure

| Layer | Technology / resource | Responsibility and boundary |
|---|---|---|
| User identity | Microsoft Entra ID, Container Apps authentication | Terminates sign-in and supplies identity/group claims; does not automatically delegate user credentials to data tools |
| Application | Node.js 20+, ESM, native HTTP/fetch, server-rendered HTML | BFF keeps credentials and Azure management calls off the browser; three themes share implementation |
| Web hosting | Azure Container Apps, `cae-cortex`, North Europe | `cortex-web`, `cortex-web-microsoft`, `cortex-web-novo`; one writer per state container |
| Catalogue tools | Separate `cortex-purview-mcp` Container App | Exposes Purview metadata tools, not arbitrary source records |
| Governance | Microsoft Purview `prdcorepurvieweus`, East US | Unified Catalog domains/products/relationships and Data Map scanned assets/schema/classification |
| Models and agents | Microsoft Foundry `prdcorefdryeus001`, project `prdcorefdryproj-default`, East US | Versioned agents, Responses API, tool connections and evaluation APIs; configured deployment `gpt-5.4-mini` |
| Source data | ADLS Gen2 / Blob Storage `stcortexdatazha7pf`, container `products` | Authoritative synthetic CSV files and dictionaries; private network access |
| Retrieval | Azure AI Search `srch-cortex-zha7pf`, North Europe | Data sources, CSV indexers, indexes, semantic ranking, knowledge sources/bases; Foundry IQ uses this managed retrieval layer |
| API reuse | Azure API Management `prdcoreapimneu001`, North Europe | REST/GraphQL endpoints, MCP projections, subscription-key access and real gateway usage |
| External agents | Azure Databricks, Microsoft Fabric, Copilot Studio | Administrator-approved adapters; Databricks exercised live, Fabric/Studio subject to recorded tenant restrictions |
| State | Blob Storage `stcortexstatezha7pf`, North Europe | Separate JSON collections per app container; not Cosmos DB or mounted Azure Files |
| Secrets | Container Apps secret references; Key Vault adapter and existing `prdcorekveus` | Rehearsed apps use direct configuration/secrets; Key Vault reads depend on its network accessibility |
| Networking | Azure Network Security Perimeter `nsp-cortex` | Storage associations enforced; Search association in learning mode. No claim of a complete private-endpoint topology |
| Operations | Azure Monitor / Log Analytics; existing Application Insights configuration | Container logs and diagnostic infrastructure. An Insights connection string does not prove complete application traces |
| Build / deployment | Azure Container Registry `prdcoreamlacr001`, Azure CLI, azd, Bicep | Versioned images; `infra\main.bicep` is the active IaC entry point |
| Bootstrap | Approved operator scripts; manual `cortex-web-bootstrap` job | Creates sample content using existing access; job image/configuration must be reviewed independently |
| Optional channels | Azure Bot Service + Foundry Activity Protocol | Native tenant submission path after explicit consent; downloadable ZIP alone provisions nothing |

The deployment spans regions. Data, prompts, retrieval planning and external connectors can cross those boundaries; customer residency review is required. Shared identities and backend services are not a customer-isolation model.

## Discovery and knowledge flow

```mermaid
sequenceDiagram
  participant U as User
  participant B as Cortex BFF
  participant P as Purview
  participant S as ADLS Gen2 / Blob
  participant Q as Azure AI Search / Foundry IQ
  participant F as Foundry agent
  U->>B: Search / ask / select knowledge
  B->>P: Read catalogue metadata and asset relationships
  Note over B,P: Catalogue answers identify sources; metadata is not source data
  Note over S,Q: Bootstrap or approved publication, not every query
  Q->>S: Indexer reads CSV using Search service identity
  S-->>Q: Records become derived index documents
  B->>F: Create version with selected knowledge connections
  U->>B: Ask for a record
  B->>F: Responses request and private conversation context
  F->>Q: MCP knowledge retrieval using project connection
  Q->>F: Configured planning-model invocation
  F-->>Q: Retrieval plan
  Q-->>F: Retrieved evidence
  F-->>B: Answer, citations and tool activity
  B-->>U: Answer with provenance / explicit failure
```

The planning-model interaction represents the rehearsed preview configuration, not a recursive agent call. The stable minimal mode does not use a planning model.

### Bootstrap contract

The 14 products define deterministic CSVs, containing 15,050 rows across 1-21 September 2026. File uploads are verified; Data Map scans and registers the CSV assets; Unified Catalog relationships bind those assets to products. Search indexers read the same files. Exact expected row counts are required before knowledge metadata is published.

Purview carries `cortexDataFolder`, `cortexSearchIndex`, `cortexKnowledgeBase`, `cortexKnowledgeSource`, `cortexKnowledgeMcp`, `cortexKnowledgeConnection`, `cortexKnowledgeReasoning` and `cortexIndexedRows`. This preserves the connection across application restarts and across themes.

Foundry IQ does not create a separate copy of data in Cortex. Search indexes **are** derived copies. A product with an IQ endpoint becomes a managed-identity MCP tool when attached to an agent; a catalogue-only product must not be described as having accessible rows.

`SYN-17` repeats independently in each dataset. It is a demonstration lookup anchor, not a relational join key. The UI does not infer totals or causality from a retrieved subset.

### Retrieval modes

| Mode | Contract | Operational requirement |
|---|---|---|
| Minimal | `2026-04-01` knowledge-base/MCP path; no planner | Documented model-free path; the sandbox MCP endpoint rejected this API version during rehearsal |
| Planned, rehearsed | `2026-08-01-preview` MCP with low-effort planning and extractive output | Explicit `SEARCH_KNOWLEDGE_MODEL_NAME`, `SEARCH_KNOWLEDGE_MODEL_ENDPOINT` and existing `FOUNDRY_MODEL`; Search identity needs approved model access |
| Legacy native tool | `azure_ai_search` on a CognitiveSearch connection | Still supported in code for older products; the sandbox native tool returned access denied despite account roles, so demo grounding uses the verified IQ path |

Do not turn the native-tool failure or stable-version rejection into a universal product limitation. API support and effective caller identities must be established per deployment.

## Application surfaces

Ask/Search routing is explainable and overridable, not a billable classifier. Ask uses permitted catalogue context; the Help guide uses curated platform guidance and a tool-free model call, not live logs or other users' conversations.

Agent chat uses server-side owner checks, cross-agent thread isolation, serialized turns and saved provenance. The bottom-right dialog enhances ordinary links; without JavaScript, the full conversation page remains available. Rebuilding a native agent uses its version collection. External-wrapper rebuilds preserve their source tools.

The Map computes positions from live governance domains and resolves recorded dependencies. It is a catalogue view, not geographical topology, discovered network connectivity or verified end-to-end lineage.

Requests capture question, purpose, cadence and a holder. `cortexAskable` identifies supported holder questions; missing metadata can leave a request unassigned. Holder selection preserves input. Drafting/release requires underlying-access checks and human action, not an automatic permission grant.

## Publishing and external systems

| Path | Implementation |
|---|---|
| Configured source to IQ | Indexer lifecycle, exact data checks, real knowledge source/base, project-managed-identity connection and catalogue artefact |
| REST to MCP | Selected OpenAPI 3.0 JSON operations projected by APIM; GET default, explicit consent for non-GET methods |
| Existing GraphQL to MCP | One parsed, fixed read-only query; callers supply variables, not replacement query text; mutations/subscriptions rejected |
| Indexed-data GraphQL | Seeded bounded `rows(search, first)` query over an existing Search index; not general database federation |
| Existing agent | Foundry wrapper -> APIM -> Cortex protected shim -> approved Databricks/Fabric/Studio adapter |
| Teams/Microsoft 365 package | `fflate` ZIP with manifest, generated icons and installation instructions |
| Native channel submission | Separate consented path: passing native assessment, Bot Service/channel configuration, fixed-version endpoint, tenant submission |

External wrappers request `tool_choice: required`; the adapter refuses to present a generic model response as a delegated answer. Source configuration can change independently of a wrapper version, so its provenance and assessment need review.

Connectors allow only configured destinations and secret references. APIM subscription-key protection does not establish per-user authorization for arbitrary source tools. Fabric's dedicated connector remained model-policy blocked; Studio's environment rejected app-only S2S. Do not remove authentication to hide those failures.

## Assurance and orchestration

The Responsible AI report automatically maps configuration to Microsoft's six principles and NIST AI RMF. It identifies needed review; it is not a behavioural evaluation or legal certification. Red-team status comes from complete, version-matched evidence. Failed, stale, missing or blocked evidence never becomes a pass.

**Test and publish** uses a durable native evaluation lifecycle and publishes only after all configured evaluators pass complete non-empty output. **Publish with acknowledgement** is the explicit advisory alternative, recording outstanding findings and the accepted version without clearing gates. Native tenant submission remains a separate path.

Browser axe-core checks cover selected WCAG A/AA rules. Interface/agent fingerprints prevent stale evidence reuse; manual keyboard, screen-reader, zoom, contrast and authentication review remain necessary.

Workflows form ordered stages: one to five total steps, maximum three concurrent siblings, then an all-success join. Siblings settle before downstream work; failed/empty/oversized output stops the chain. Draft handoff is bounded to 24,000 characters, with separately bounded structured citations and explicit omission counts. Evidence is flushed before completion is returned. Manual cadence schedules nothing; recurring schedules use captured owner context and require stronger directory revalidation for production.

## State, recovery and infrastructure boundaries

`state`, `state-cortex-web-microsoft` and `state-cortex-web-novo` store separate application collections. Catalogue/backend changes are shared. Each container supports one writer; multiple replicas or a local process pointed at the same state are unsafe. File state is for isolated local development. Failed initial reads disable writes rather than replacing remote history with empty collections.

`CORTEX_MAINTENANCE=true` blocks application and shim routes, retaining the health endpoint and disabling application schedulers/periodic index refresh. It does not stop external jobs, scans or clients of shared services. Reset additionally requires reviewed backups, exact object scope, fingerprints, quiesced writers and verified deletion. Provider audit/soft-delete retention is outside a content reset.

Active IaC is `infra\main.bicep`, which composes create-or-reuse modules. `azure.yaml` declares base web and Purview MCP apps. Variants and the bootstrap job require explicit rollout handling; the root `containerapps.bicep` and optional Cosmos module are not the current runtime architecture.

## API/version reference

| Integration | Contract used by this repository |
|---|---|
| Foundry | Project agents `api-version=v1`; versions at `/agents/{name}/versions`; Responses at `/openai/v1/responses` without that query parameter |
| Native evaluations | `/openai/evals`, `/evaluationtaxonomies`, runs and output items; `2025-11-15-preview`, `Evaluations=V1Preview` header |
| Foundry IQ connection | ARM RemoteTool, `ProjectManagedIdentity`, Search audience, `2025-10-01-preview` |
| APIM MCP | `2025-09-01-preview`; inline tools and full backing-operation ARM IDs |
| Purview Unified Catalog | `2026-03-20-preview`; array-form managed attributes, full-replace PUT and relationships |
| Purview Data Map | `2023-09-01`; ADLS scan and Atlas asset APIs |
| Search indexing | `2024-07-01`; CSV indexers and Entra authentication |
| Knowledge resources | Stable source definition and explicit minimal/planned base mode; see retrieval table above |
| Bot Service | `2022-09-15` ARM API; Foundry Activity Protocol endpoint in the channel adapter |

Preview contracts must be tested in the target region. Existing-role assignments, model deployments, source health and tenant entitlements are not inferred from a successful build.
