# Integration lessons

These are reusable engineering lessons from earlier iterations. For current commands and permissions, use [DEPLOY.md](docs/DEPLOY.md).

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

Do not turn an integration workaround into a blanket claim about platform limitations. Preview interfaces change; keep pinned versions, documentation links and target-environment acceptance steps.
