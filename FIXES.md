# Integration lessons

These are engineering lessons, updated through the 22 September 2026 demo refresh. For the current architecture use [README](README.md#technical-solution-architecture) and [ARCHITECTURE.md](docs/ARCHITECTURE.md); for commands and permissions use [DEPLOY.md](docs/DEPLOY.md). Examples below are failure signatures, not authorization to change resources.

| Failure | Lesson |
|---|---|
| Windows `spawn ENOENT` / `EINVAL` | Azure CLI is a command script; use the existing narrowly validated Windows token helper |
| Purview metadata ignored/rejected | Managed attributes are arrays; maintain writer-reader round-trip tests |
| Duplicate products on rerun | Include drafts and pagination; never continue creation after a listing failure |
| APIM MCP creation returned 500 | Send type and inline tools together; wait for backing operations; verify readback |
| Agent tool returned 401 | Create a Foundry project connection with the gateway key and correct per-tool target |
| Missing Entra group claims | Sign-in alone is not group configuration; inspect `/profile` |
| Azure Files state failed under policy | Use keyless blob state instead of an account-key mount |
| Storage 403 misdiagnosed | Distinguish network refusal from missing data-plane RBAC |
| Deployment claimed success over unhealthy revisions | Inspect running revisions, not just app templates |
| About view became unreachable | Smoke tests must exercise routes and links, not only import views |
| Live Map was empty | Live domain metadata does not include the retired demo pack's drawing coordinates |
| Existing Foundry agent create returned conflict | Create new versions through `/agents/{name}/versions`; preserve wrapper tools and require builder/reviewer access |
| Native Search access denied despite account roles | Identify the actual caller/connection; extra agent grants did not resolve this sandbox failure. The approved IQ grounding path worked; no universal native-tool defect is claimed |
| Preview IQ requested an unconfigured planning model | Explicitly configure the existing planning deployment and its identity access; stored minimal settings alone did not make the available preview MCP path model-free |
| Stable IQ MCP API version rejected | Code/documentation support is not deployment availability. Record the unsupported version and use an explicitly approved, rehearsed mode |
| “Empty” Blob container in a browser | Private containers are not file listings. Verify authorised file reads, not public access; 14 actual CSVs and 15,050 rows were confirmed |
| Bootstrap reported partial indexing as success | Require expected per-product counts and successful ingestion before knowledge links; pending or stale counts are not completion |
| Soft-deleted Data Map asset reused | Exclude `DELETED` entities from reads so a new scan must supply an active asset |
| Product and asset each refused deletion | Their relationship must be detached before either endpoint can be removed; restrict detachments to approved object pairs |
| Evaluation DELETE returned HTTP 200 but `deleted:false` | Stop, preserve the receipt and seek an explicit retention/scope decision; never record a successful deletion |
| App identity could read but not delete Purview products | Use the operator's already-authorised access after fingerprint checks; do not grant broad app roles automatically |
| Generic wrapper answer looked like a successful connector | Require an actual successful delegated tool call and show its evidence |
| Final workflow reviewer lost source references | Carry bounded structured citation metadata alongside draft text; render-only citation markers are not durable references |
| Run redirect preceded blob persistence | Flush recorded results before returning completion; surface persistence failure |
| Requests became unassigned | Populate `cortexAskable` for holder-supported questions; preserve purpose/cadence through holder selection |
| Local app overwrote shared demo state | Never reuse a deployed writable state container in local development or another replica; use isolated file state |
| Long Container Apps exec command returned 404 | Keep websocket command payloads short or execute a reviewed script in the image; honour 429 retry instructions |
| New deployment omitted demo examples | Seed templates must reference actual accessible resources and approved connectors, with consent unchecked and no auto-submit |
| Bootstrap job silently ran older code | A web image update is not a job update; inspect job image, configuration and arguments before starting it |

Do not turn an integration workaround into a blanket claim about platform limitations. Preview interfaces change; keep pinned versions, documentation links and target-environment acceptance steps.

The native red-team ACA-session 429 remains an external capacity/service blocker. It occurred before sampling and is not evidence of agent safety. Fabric connector policy, Studio S2S and Teams/Microsoft 365 installation have their own prerequisites; neither disabling auth nor claiming a package download as installation is a remedy.
