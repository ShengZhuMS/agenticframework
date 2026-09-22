# Data Cortex - architecture

Data Cortex is a customer-neutral PoC front end to Microsoft Purview, Azure API Management and Microsoft Foundry. It demonstrates discovery, governed composition and reuse over an AI landing zone, rather than implementing the entire landing zone.

## Components

```text
Browser (server-rendered HTML)
  -> Entra / Container Apps authentication
  -> Cortex backend-for-frontend
       -> metadata index: Purview + APIM + Foundry
       -> agents, chat, requests, ordered agent workflows
       -> Foundry Evals/taxonomy red team integration
       -> blob state: one writer per app-specific container
  -> Purview Unified Catalog: domains, products, asset relationships
  -> Purview Data Map: scanned assets, schema, classifications
  -> APIM: REST APIs, MCP projections, gateway analytics
  -> Foundry: versioned agents, responses, project connections, evaluations
  -> synthetic files -> Data Map scan -> AI Search -> agent grounding
```

The separate Purview MCP app exposes catalogue metadata, not arbitrary source rows. The publishing shim presents an agent invocation operation for APIM to expose as MCP. Neutral sample skills read bounded portions of uploaded synthetic files and require the gateway subscription key.

The artefact publisher adds approved source connectors: Databricks serving endpoints, Fabric's published MCP runtime and Copilot Studio secured Direct Line or application-authenticated Direct Engine connections. Source protocol/availability preflight runs before creating gateway resources or assessments; successful connectivity does not establish model/data permission. Direct Engine HTTP/SSE requests have explicit time and size bounds, and disabled preview capabilities fail closed. A versioned Foundry wrapper delegates to an external source and remains subject to native pre-publication assessment. Generic JSON APIs are projected as APIM MCP tools; data products can expose a bounded GraphQL query over their existing Search indexes. Source credentials stay in managed identity or Container Apps secret references. Requests cannot change the administrator-approved origin or path prefix.

After a passing assessment, Teams/Microsoft 365 publication pins the stable Foundry endpoint version, creates a dedicated Azure Bot Service and submits a tenant package through the documented publish API. The platform supplies authenticated Activity Protocol handling; a duplicate custom bot HTTP server and its separate session database are unnecessary. Catalogue submission is not tenant administrator approval, installation or entitlement.

## Metadata and Map

The Cortex Index merges live API responses, caching them to avoid page-by-page service fan-out and Purview rate limits. Backend errors are surfaced; unavailable sources may leave stale data. There is no runtime seeded fallback.

The Map lays out live domains deterministically in SVG. Domain count controls canvas height; registered entry counts control circle size. Dependencies must be recorded and resolve to real entries. Missing domains and unresolved dependencies are shown separately. Positions are not geography.

## Governance

Entra group claims are mapped to aliases for the visibility engine. `visibilityFor()` describes the viewer's route; `canReachUnderlying()` is the separate holder-access question. Agent creation validates attachments server-side.

Requests are drafted with holder permissions and require a human release. Chat follows the configured `all-staff` or `visibility` policy. Workflow drafts are owner-only; scheduled execution uses captured permissions and needs live directory revalidation before production adoption.

Assurance gates describe review requirements. **Test and publish** persists an assessment request, enables generated prohibited-action scenarios, runs native Foundry evaluation and publishes only when every sample passes all three distinct evaluators. A background worker resumes after restart. Published invocation pins the assessed agent version. Standalone reviewer-led scans remain available. Passing the configured sandbox gate is not a production safety certification.

## Persistence and isolation

Application state is JSON collections in Blob Storage with managed identity authentication. Local development can use files; missing/unreachable storage leaves explicit memory-only mode. The app never overwrites existing blob state after a failed initial read.

One replica is supported per state container. The Microsoft/Novo-inspired variants share platform services and the neutral demo pack, but use distinct state containers. Shared identities and catalogues are not a tenant/customer isolation boundary.

Chat now rejects cross-agent thread reuse, requires stable owner identity, serializes turns within a process and reports failed persistence. Published conversations pin the assessed version. This does not turn whole-collection blob persistence into a multi-writer database: keep the single-writer restriction. The existing Cosmos module is a future scale-out option, not a deployed session store. Native Bot/Foundry channels manage their own conversation state.

Reset operates on reviewed object plans, not resource groups. Fingerprints detect changes between inventory and deletion. Unknown orphan ownership, platform audit history and soft-delete retention require separate operator review.

## PoC boundaries

The system is not a production access-control gateway for arbitrary tools. Some legacy machine routes rely on the trusted gateway deployment boundary; external tools need their own authorization. Synthetic data is indexed and metadata/transcripts/reports are stored, so the claim that nothing is copied is incorrect.

Production requires threat modeling, scoped identities, stronger machine-route controls, fresh scheduled-run permissions, durable multi-writer state, managed report retention, approval policy and operational monitoring. Preview API availability must be established in the target region. No savings, compliance certification or customer outcomes are asserted.
