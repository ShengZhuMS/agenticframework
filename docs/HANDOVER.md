# Data Cortex - developer handover

Read [DEPLOY.md](DEPLOY.md) before any Azure operation. This revision was prepared from the approved cached `MainFeature` baseline, commit `1998fc9`. The user subsequently approved live repairs, both independent themed apps and removal of unreferenced legacy demo Search indexes. The original web image and shared infrastructure were preserved; no full reset was executed.

**Follow-up supersedes the original-image restriction:** the user approved deploying this integration iteration to all three web apps, necessary Azure resources, dedicated Microsoft 365 catalogue submission (not tenant-wide installation), and narrowly scoped Fabric AI policy updates. No full reset or licence purchase is approved.

## Repository map

| Path | Responsibility |
|---|---|
| `src\bff\server.js` | HTTP routes, auth context and form dispatch |
| `src\bff\index\store.js` | Live merged catalogue and persisted agent overlays |
| `src\bff\adapters\` | Purview, APIM, Foundry, red team, storage/search and token boundaries |
| `src\bff\services\` | Visibility, assurance, build/publish, chat/requests, workflows and assessments |
| `src\bff\state\store.js` | Blob/file/memory persistence; one writer |
| `src\web\` | Server-rendered views, themes and styles |
| `bootstrap\` | The single neutral demo pack |
| `scripts\sample-data.js` | Deterministic synthetic CSVs and dictionaries derived from the pack |
| `scripts\reset-content.js` | Reviewable/resumable scoped content reset |
| `scripts\Deploy-CortexVariants.ps1` | Additional themed apps without changing original app deployment tags |
| `infra\` and `azure.yaml` | Base infrastructure and azd services |
| `test\` | Node tests, Azure HTTP stubs and local HTTP smoke tests |

## Integration facts to preserve

- Foundry agent CRUD uses project `/agents?api-version=v1`; responses use `/openai/v1/responses`. Agents have names and versions.
- Native agent red teaming follows the separate Evals/taxonomy preview routes documented in DEPLOY.md. Do not substitute model-only `redTeams` scans and call them agent assurance.
- APIM MCP management uses `2025-09-01-preview`, with `type: mcp` and a non-empty inline `mcpTools` array in the same PUT. Operation IDs are full ARM IDs. Wait for imported operations.
- The MCP endpoint is gateway/path/mcp, not an MCP API's often-null `serviceUrl`.
- Foundry MCP tools need per-target project connections carrying the APIM subscription key. A raw model tool header is not the replacement.
- Purview Unified Catalog uses the configured global endpoint and preview version; Data Map uses the account endpoint. Their role models are distinct from Azure RBAC.
- Purview product PUT is a full replacement. Preserve fields and owners. Managed attributes are arrays. Query published, draft and expired products and paginate.
- Product listing failure must stop bootstrap creation: treating every product as new risks duplicates.
- Windows Azure CLI is `az.cmd`. The token helper's validated shell invocation handles Node's Windows spawn restriction. Preserve its allowlist.
- No outbound call should be unbounded. Preserve timeouts, errors, provenance and partial-service notices.

## Behavior added in this revision

Live domains no longer need obsolete seed coordinates to render. Ordered workflows contain two to five steps and stop on failed/empty/oversized handoffs, keeping step evidence. New agent records store `builtById` for assessment authorization; legacy assessment access uses `cortex-redteam`.

Native assessment records preserve evaluation/taxonomy/run IDs and the pinned agent target. **Test and publish** automatically enables generated scenarios, submits the native scan, monitors its durable queue and publishes only after complete passing evidence. Published invocation pins the tested version. Standalone assessments still offer reviewer confirmation. Ambiguous submission does not silently retry; inspect Foundry with the recorded evaluation ID. Native result counts may omit `errored`; total/sample/grader completeness still fails closed.

The legacy unused `seed\` pack was removed. Demo data is synthetic, not a runtime service fallback. Bootstrap skills now have a real bounded storage-read shim rather than a published URL with no handler.

## Conventions and limits

Use Node built-ins at runtime, existing tests and `esc()` for untrusted HTML. Preserve server-side attachment validation, identity checks, and the distinction between visibility and underlying access. All state goes through `collection()`; use one replica per container.

GraphQL and the official MCP client SDK are now locked runtime dependencies; Docker installs them with `npm ci`. Browser chat uses one small progressive-enhancement script; About remains server-rendered without client script. Source APIs use approved connector identities, never arbitrary user-provided credential endpoints. Keep the explicit opt-in for non-GET API operations.

Themes change presentation only. Variant deployment reuses source configuration and identity, isolates state and appends Entra redirects. It deliberately avoids azd service tags so the base deployment cannot accidentally target a variant. Its source must use direct configuration.

Reset is never part of normal deployment. Inspect every inventory item; use exact reviewed IDs for orphans whose ownership cannot be established. Do not delete shared platform resources, users, roles or customer content as a cleanup shortcut.

Known production gaps: live permission revalidation for scheduled runs, durable multi-writer state, stronger legacy machine-route authentication, external-tool authorization, assessment retention, and fuller operational controls. The user-facing About page states these boundaries.

## Release procedure

Run relevant Node tests and the offline bootstrap dry-run. Review PowerShell syntax and a mocked deployment run before requesting Azure approval. In Azure, verify latest-revision health, authentication, blob persistence, both themes, sample skill invocation and the complete Foundry taxonomy/run/results sequence. Stubbed tests cannot prove service availability or RBAC propagation.

### Live release status and remaining blocker

Both requested apps are deployed with unique state containers and Entra sign-in. The protected-secret connection recovered without purging; fourteen neutral Search indexes hold rows. Purview scanning completed and all fourteen sample files were registered and attached to their products. The approved twelve-index legacy migration preserved products/files/agents and unknown resources; some retained old datasets can still contain historical rows.

The deployed variants and bootstrap job use `prdcoreamlacr001.azurecr.io/cortex/web-cortex:release-20260921-r3`, digest `sha256:6fc1829b0017b9435b65b0629472357ea177475f04ce33737347261259cea51b`. Preserve a unique tag for each future release. The temporary no-tools acceptance agent, taxonomy and failed evaluation were removed after diagnosis; unrelated Foundry agents were untouched.

Native evaluation and taxonomy creation work, including activation of the 28 generated prohibited-action scenarios. Two native run submissions failed inside Foundry with an ACA-session `429 Too Many Requests` before generating results. This is the remaining end-to-end publication blocker, not evidence of a passed assessment. Do not bypass the gate. Check hosted evaluation capacity/service availability with Azure support. No customer-managed session pool was found in the Foundry resource group.

Reset still requires a fresh target-environment plan and approval. The integration follow-up updates the original web app too, as explicitly approved; all three apps and the bootstrap job receive the same release image.

### Integration follow-up

Current deployed image on all three apps and the bootstrap job: `prdcoreamlacr001.azurecr.io/cortex/web-cortex:integrations-20260921-r4`, digest `sha256:a40a32e7a62af3ae908996d4f266e46cb9e3f2d4871d33aee6699d7c6fa22229`. All app revisions are ready, Entra protection is retained and the three original blob-state containers remain distinct. GraphQL and the catalogue-health MCP tool continue working after the final rollout.

The follow-up adds artefact publishing, popup chat, per-artefact declared lineage, current official header marks and a larger landing-zone foundation diagram. `searchEntries()` fixes a pre-existing name collision with the Search adapter that broke `/api/entries`. A live MCP call also showed APIM projecting a single question into a raw request body; the protected source-agent shim handles both that form and normal JSON.

Dedicated source resources: Fabric application `0dc99e98-cb18-4427-a1ca-d2c241b51ec8`; synthetic workspace `0ca1012b-0364-4993-87bd-8a16ae842ad2`; connector policy group `71c6ac1c-bb0d-4fa8-bb25-946a4e9d9b67`; existing app identity onboarded to the sandbox Databricks workspace. Bot Service Contributor is scoped to the Foundry resource group. Secrets are in Container Apps, not source control.

Live acceptance artefacts are clearly named and intentionally retained in the Microsoft app's state: a synthetic GraphQL API, a catalogue-health MCP tool and a draft Databricks wrapper. The corrected wrapper chat returned SYNTHETIC through Foundry, APIM and Databricks, but the wrapper has not passed the native assessment gate. The authorized operator created/published synthetic Fabric agent `7e478267-9ccf-4468-b05d-ec4ba9382c8b`, and its MCP query worked with operator authentication. After a separate explicit approval, cross-region processing was added only for the dedicated Fabric connector group, preserving existing groups; its last model call still returned 403.

The resumed work created/published Copilot Studio source `cortex_SyntheticCatalogueGuide` (`a6517ae7-32ad-4d5f-8c9a-6580a86d3b13`) in the existing default environment and provisioned dedicated connector app `5fa30651-a803-452f-888b-be77641f8880`. Its approved API application permission and secret are configured, but the environment returns `App-only S2S access is not enabled for this environment`. Integrated source authentication is preserved; making it anonymous is not a fix. A fresh native red-team run also reproduced ACA-session 429. See DEPLOY.md section 11 for the current source pack, setup commands, preflight protections and remaining service-enablement boundaries.
