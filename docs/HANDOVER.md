# Data Cortex - developer handover

**Current baseline:** the three-app demo release `novo-demo-20260923-r3`, rehearsed on 22 September 2026. Read [README](../README.md) for the architecture diagram, [DEPLOY](DEPLOY.md) for operations and [DEMO](DEMO.md) for presenter evidence. Earlier Microsoft-only rollout restrictions and pre-reset artefact IDs are obsolete.

## Repository map

| Path | Responsibility |
|---|---|
| `src\bff\server.js` | HTTP routing, authenticated form actions, maintenance gate and schedulers |
| `src\bff\config.js` | Environment configuration and optional Key Vault hydration |
| `src\bff\index\store.js` | Purview/APIM/Foundry catalogue merge and persisted overlays; `searchEntries()` is distinct from the Search adapter |
| `src\bff\adapters\` | Azure APIs, token acquisition, Databricks/Fabric/Studio connectors and native channel publishing |
| `src\bff\services\agents.js`, `chat.js` | Attachment validation, version creation, runtime tool requirements and owner-scoped conversations |
| `src\bff\services\artefacts.js`, `knowledge-publishing.js` | REST/GraphQL/external-agent publishing and resumable source-to-IQ flow |
| `src\bff\services\assurance.js`, `evidence.js`, `redteam.js`, `publish.js` | Configuration gates, fingerprints, native scan lifecycle and publication decisions |
| `src\bff\services\automations.js` | Validated stages, concurrent siblings, bounded handoff and durable results |
| `src\bff\services\guide.js`, `discovery.js` | Curated tool-free guidance and Ask/Search routing |
| `src\bff\state\store.js` | Blob/file/memory collections; one writer per container |
| `src\web\` | Server-rendered views, themes, safe Try examples and progressive browser enhancements |
| `bootstrap\` | Neutral data/skill definitions, synthetic operational journey and Studio source pack |
| `scripts\bootstrap*.js` | Catalogue/data/knowledge bootstrap and analyst/workflow seeding |
| `scripts\reset-content.js` | Fingerprinted, scoped, resumable content deletion |
| `infra\main.bicep`, `azure.yaml` | Active IaC and base azd service declarations |
| `test\` | Node tests, Azure HTTP stubs, route smoke tests and installed-browser coverage |

## Invariants that must survive refactoring

1. **Preserve the physical data chain.** `cortexDataFolder`, `cortexSearchIndex` and `cortexKnowledge*` managed attributes round-trip through Purview. A product with a configured IQ MCP endpoint uses that connection when attached; it must not silently fall back to the previously failing native Search path.
2. **Create versions correctly.** New agents use `POST /agents`; existing names use `POST /agents/{name}/versions`. Normalise `versions.latest` reads. Rebuild requires builder/reviewer access. External-wrapper rebuilds preserve their actual remote tools.
3. **Require real delegation.** External wrappers have `artefactId`; `runtimeToolOptions()` requests tool use, and the Foundry adapter rejects a generic answer with no successful source call. Wire the option through chat, test, published invocation and automation.
4. **Keep transport details intact.** APIM MCP needs inline `mcpTools` in the same PUT as `type: mcp`, with full operation ARM IDs. Connections are per target. A single-argument MCP projection can arrive as a raw body; use the existing canonical parser.
5. **Keep identities separate.** Viewer catalogue access does not equal a service identity's underlying access. Preserve attachment validation and explicit audience review. `all-staff` chat policy does not impersonate the caller against every tool.
6. **Do not erase evidence.** An acknowledgement is not a passing scan. Match scan evidence to agent name/version, track stale evidence, and preserve blocked/not-run outcomes. RAI mappings are configuration review; axe plus reviewer attestations are not full certification.
7. **Preserve workflow joins.** At most five total steps and three siblings per stage. All siblings settle; any failure stops downstream execution. A 24,000-character draft limit and bounded structured citations protect handoff. Flush run evidence before returning success.
8. **Keep state single-writer.** Never start a local app or seed process against a live writable container. Seed scripts require maintenance; cross-app copies merge only owned seed records. Failed initial blob reads must never overwrite remote history.
9. **No hidden side effects in examples.** Try buttons fill inputs, not submit them. Consent remains unchecked. AI suggestions do not create or execute workflows. The seeded workflow and default demo form use manual cadence.
10. **Treat deletion receipts literally.** `deleted:false` is failure even with HTTP 200. Detach approved catalogue relationships first, require exact scope/fingerprints, and verify absence or the provider's deleted state. Maintenance does not stop external jobs or source systems.

## Runtime and development

Node.js 20+ with ESM, native HTTP/fetch and locked dependencies: `graphql`, the official MCP SDK, `fflate`, GOV.UK Frontend and axe-core. `playwright-core` is development-only and uses an installed browser. Docker runs `npm ci --omit=dev --ignore-scripts` then vendors assets.

Use `esc()`/`attr()` for untrusted HTML. Retain timeouts, connector origin/path restrictions, secret references and the token helper's narrow Windows resource allowlist. Do not introduce arbitrary user-supplied credential endpoints.

Run the smallest affected tests with `node --test`, then the full suite for cross-cutting changes. The latest full run passed 418 tests, including browser coverage across three themes; this is dated evidence, not a replacement for future validation. Browser checks skip when no supported executable is available, so inspect skip counts.

The original Novo About file is deliberately preserved byte-for-byte; `test/demo-refresh.test.js` protects its approved hash. Updating its narrative requires an intentional requirement/test change, not accidental formatting. The README diagram is the maintained technical architecture, distinct from that frozen marketing page.

## Release and data migration

All three apps currently share `novo-demo-20260923-r3`; see the runbook for exact revisions. Preserve `CORTEX_CONNECTORS`, per-app `PUBLIC_BASE_URL`, auth callback URLs, secrets, theme and state container. An image-only update does not align a manual bootstrap job; inspect/update that job independently before execution.

The refreshed pack has 14 CSVs and 15,050 rows in the September reporting window. `SYN-17` is independently repeated across datasets, not a business join key. API usage now has integral request counts; old examples such as `41.90` are pre-reset and must not be reused. The present API value is `2153`.

Per-product IQ bootstrap checks exact row counts before linking knowledge metadata. Stable model-free MCP is supported in the code, but the sandbox rejected its API version. The rehearsed path explicitly configures the existing planning model and preview MCP; do not silently switch modes, enable paid tiers or add roles.

The approved reset retained 18 provider evaluation/taxonomy objects and removed 313 functional objects. Backups are outside the reset scope. Do not replay that old plan against newly seeded resources, even if names match.

## Outstanding boundaries

Native evaluation creation/submission works, but hosted ACA sessions failed with 429 before sampling. Tenant Teams/Microsoft 365 installation was not performed. Fabric's dedicated connector has model-policy restrictions; the Studio environment rejects app-only S2S. Databricks delegation, IQ data retrieval, REST/GraphQL MCP and ZIP generation were rehearsed live.

Production work remains: current directory permissions for scheduled runs, multi-writer persistence if scaling out, stronger machine-route authorization, verified per-user document ACLs, lifecycle/retention policies, complete telemetry and residency review. No documentation or previous user approval grants permission to change a future environment.
