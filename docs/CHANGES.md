# Change reports

The maintained release history is [CHANGES.md](../CHANGES.md). The current documented image is `novo-demo-20260923-r3` on all three Cortex web apps, recorded on 22 September 2026. This index does not duplicate the change log.

| Current source of truth | Scope |
|---|---|
| [README](../README.md) | Current release, capabilities and technical architecture diagram |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Service topology, data/identity flows, implementation boundaries and API versions |
| [DEPLOY.md](DEPLOY.md) | Configuration, rollout, ordered bootstrap and reviewed reset |
| [HANDOVER.md](HANDOVER.md) | Code map, invariants, release checks and outstanding engineering work |
| [DEMO.md](DEMO.md) | Presenter script, exact synthetic values and dated live evidence |
| [FIXES.md](../FIXES.md) | Failure signatures and integration lessons |

Earlier revisions introduced live catalogue adapters, Purview policy grants, APIM inline MCP tools, per-target Foundry connections, state persistence and network-perimeter support. Old instructions about seeded runtime mode, mounted Azure Files state and single-agent-only task automation are superseded.

Statements that only Microsoft was updated, that no content reset occurred, that every publication required a passing native scan, or that automation required two distinct agents are historical. Current behavior is documented above: all apps aligned, a reviewed reset with retained provider history, explicit advisory publication, and one-to-five-step sequential/parallel workflows.

Use Git history for prior incident reports. The original Novo About page is intentionally preserved marketing content; README and ARCHITECTURE are the maintained technical references. Historical approvals, old reset hashes and earlier successful tests are not authorization or evidence for another environment.
