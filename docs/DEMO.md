# Your Novo Cortex demo script
## 23 September 2026 · approximately 18–20 minutes

**Demo app:** https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io

**Opening line:** “Cortex connects the Microsoft platforms we already have, so people can discover governed data, turn it into useful agents and reuse those capabilities without rebuilding every integration.”

Everything below uses synthetic, non-clinical data. The services and responses are real; these are not Novo company records. The examples were rehearsed on 22 September. Cloud availability can change, so do the quick check below before the audience arrives.

**Release:** `novo-demo-20260923-r3`, shared by all three apps. For the maintained technical solution diagram, use [README](../README.md#technical-solution-architecture); the restored About page is the original marketing narrative. [Architecture](ARCHITECTURE.md) explains service identities and data flows, and [Deployment](DEPLOY.md) covers operator procedures.

**What “works” means here:** the listed supported paths were exercised live. This does not promise identical AI wording, uninterrupted cloud availability, tenant installation or an unblocked native red-team service. The infrastructure and data reset are already complete; none of the presentation steps authorizes another reset.

## Before the audience arrives

1. Sign in with your presenter account. Automation histories and requests belong to that account.
2. Open [the Usage analyst](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/agent/demo-usage-analyst) and ask for **SYN-17**. Expect **request_count 2153**, observed **2026-09-17**.
3. Open [the prepared workflow](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/automate/AUT-0001). Its latest rehearsal should show five successful steps. It is configured for **manual runs**, not an overnight schedule.
4. Keep the Share tabs below ready. Do not run bootstrap or reset again before the presentation.
5. If Azure is temporarily unavailable, identify the problem honestly. You can show the dated rehearsal record, but do not describe it as a newly completed live run.

## 1. About: explain the value — 1 minute

Open [About](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/about).

**Do:** Show the opening business story and architecture. The full original Novo About content has been restored; you do not need to scroll through every section.

**Say:** “This is one front door over Purview, Foundry, Search and API Management, with connections to existing systems. The objective is reuse and faster time to value, not another isolated chatbot.”

## 2. Start and Ask: find the right sources — 2 minutes

Open [Start](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/).

**Try:**

> Which inventory, delivery, quality, service performance and API usage sources can support a synthetic Novo operations briefing?

**Do:** Show Auto / Ask / Search. Submit the question, then point to the catalogue sources and any access limitations. Return to Start and search **inventory** to show the Cortex catalogue and filters.

**Say:** “A question and a catalogue search share the same starting point. Ask helps identify sources; it does not pretend catalogue descriptions contain all the underlying records.”

## 3. Prove there is real data behind the catalogue — 2 minutes

Open the **Demo - Inventory levels** catalogue entry. Show **The data behind it**, the scanned asset, its schema and the indexed row count.

**Facts:** Fourteen CSV datasets were uploaded and verified, fourteen physical CSV assets were linked to their catalogue products, and **15,050 rows** were indexed. Each product has a Foundry IQ connection.

Open [the Usage analyst](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/agent/demo-usage-analyst), then **Chat with this agent**.

**Try:**

> Find record SYN-17. Return its recorded request_count and reporting date, and name the source.

**Expect:** `2153`, `2026-09-17`, and `cx-demo-api-usage.csv`. Show **Tools this answer used**, then expand and close the bottom-right chat panel.

**Say:** “The agent retrieved an indexed record from the associated data asset, not a number invented from the catalogue description.”

**Important:** The Blob container is private. A browser container URL is not a file listing and may be blocked by network rules. Do not use that URL as the demonstration of file existence, and do not open storage to the public.

## 4. Build an agent: reuse an approved blueprint — 2 minutes

Open [Build](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/build).

**Do:** Click the Supply analyst demo example. The form resolves the actual inventory and delivery sources and chooses a workshop name if the original agent already exists. Review the model, sources, instructions and read-only actions before creating it.

**Try after creation:**

> Find SYN-17 in each attached source. Report stock_units and delivery_hours separately, with source names and dates.

**Expect:** inventory **602 stock units** and delivery **14.82 hours**. These are separate synthetic observations, not a business join or a causal explanation.

**Say:** “We are composing an agent from existing governed parts. The source connection and evidence travel with it.”

## 5. Share an artefact: show each supported path — 5 minutes

The required example fields are prefilled; consent boxes are intentionally not preselected. Review each form before submitting. Creating another example is a real publication, not a simulation.

| Category | What to use | What to show |
|---|---|---|
| [Foundry IQ from Data Source](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/share?kind=knowledge) | Inventory source; **Demo - Supply knowledge** | Start the source flow, then check ingestion / finish publication. Existing index/base resources are reused where available; do not claim a new file upload happened. |
| [REST API as MCP](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/share?kind=api-mcp&protocol=rest) | `cortex-demo-api`; prefilled OpenAPI | Publish the selected catalogue-health GET operation. The MCP tool was listed and invoked successfully against live catalogue health. |
| [GraphQL API as MCP](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/share?kind=api-mcp&protocol=graphql) | `cortex-demo-graphql`; path `graphql`; prefilled query | Publish a fixed, read-only GraphQL query as MCP. It returned two actual indexed inventory rows through APIM. |
| [Existing agent](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/share?kind=external-agent) | Databricks; `databricks-gpt-oss-20b` | Create a draft wrapper, then chat. Point to `source_agent` / `invoke`: the connected source is actually called, not replaced by a generic wrapper answer. |
| [Teams / Microsoft 365 Copilot](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/share?kind=m365) | Service analyst; **Novo demo operations** | Download the real ZIP package. Show the manifest and installation instructions; tenant installation is a separate approval step. |

**GraphQL query already populated:**

```graphql
{ rows(first: 2) { id json } }
```

These are the first returned inventory records, not necessarily SYN-17. Inspect `record_id` inside `json`.

**Existing-agent prompt:**

> Use your source_agent tool to ask the connected agent for one sentence about drafting a synthetic operations briefing. Return its reply; do not claim access to company data.

**Say:** “We can reuse a data source, a REST or GraphQL API, or an existing agent. Packaging for Teams and Microsoft 365 is supported, but packaging is not the same as tenant installation.”

**Do not demonstrate as completed:** Fabric/Studio features that need additional tenant enablement, native channel installation, or native red-team scans. Do not click **Assess and submit to tenant** during this demo.

## 6. Requests: route an access gap — 1 minute

Open [Requests → Ask for something](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/requests?view=new).

**Do:** Click **Use this example**. Submit once to see the proposed **Operations team** holder; the purpose is retained. Review the holder, then submit to create the request.

**Expect:** a tracked request with its purpose, owner/holder and status. A rehearsal request already exists as **REQ-0001**.

**Say:** “Where I cannot use a source directly, I can ask its holder for an appropriate answer. This demonstrates routing and tracking—not automatically granting access or fabricating an approved answer.”

Only an authorised holder can draft or release the answer.

## 7. Automate: independent analyses, then review — 3 minutes

Open [Set up an automation](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/automate/new) and click **Use this example** next to the goal.

**Do:** Generate the AI proposal and review the selected agents and stages. AI proposes; the user approves. Keep **Run manually** for the demo.

For the already rehearsed sequence, open [Demo - Novo operations briefing](https://cortex-web-novo.icybeach-1b7b9f0d.northeurope.azurecontainerapps.io/automate/AUT-0001).

1. Usage, Supply and Quality analysts run **in parallel**.
2. Service analysis waits for all three, preserves their findings and adds its evidence.
3. Evidence review produces a draft and flags unsupported conclusions.

**Do:** Run it once. Allow about a minute: the live rehearsals completed in approximately **37 and 53 seconds**. Show the per-step results and the source/tool evidence, not just the final prose.

**Say:** “Parallel work joins only when every branch succeeds. The final result remains a draft. Source evidence is carried forward, and the reviewer does not pretend to have independently re-read every source.”

If you show a saved rehearsal instead, explicitly identify it as a previous run.

## 8. Assurance and close — 1 minute

Show an agent’s Responsible AI report and assurance table.

**Say:** “The report maps configuration to Microsoft Responsible AI principles and NIST AI RMF. Missing evidence is not a pass. Automated accessibility checks complement—not replace—manual review.”

Native red teaming is currently blocked by the hosted Foundry ACA-session 429. Do not run **Test and publish** as the live finale. For an intentional synthetic-demo publication, review the findings and use the explicitly acknowledged advisory path; never describe that acknowledgement as passing a scan.

**Closing line:** “The value is the connected system: discover, retrieve, compose, reuse and review—building on the client’s existing Microsoft data and AI investment.”

## Presenter reference: current SYN-17 values

All records below have `observed_date = 2026-09-17`. IDs repeat independently in each dataset; they are lookup anchors, not cross-system business joins.

| Source | Field | Expected value |
|---|---|---:|
| API usage sample | `request_count` | 2153 |
| Inventory levels | `stock_units` | 602 |
| Delivery performance | `delivery_hours` | 14.82 |
| Quality checks | `quality_score` | 98.51 |
| Improvement actions | `completion_percent` | 60.09 |
| Service performance | `response_minutes` | 93.54 |
| Service feedback | `feedback_score` | 75.21 |

Use these refreshed values, not the older pre-reset examples. Do not infer estate-wide totals, trends, causal relationships or clinical outcomes from these demonstration records.

## Operator handoff (not presentation steps)

The approved refresh removed 313 functional demo objects and retained 18 provider-side evaluation/taxonomy objects after deletion refusal. Private backups remain outside the reset scope. Fourteen CSVs, physical asset relationships, indexes and Foundry IQ connections were rebuilt; unrelated resources were preserved.

The seeded workflow is manual and the external wrapper is a draft. The package path creates a ZIP, not a tenant installation. Automated accessibility checks are supplemented by a separate manual checklist. Do not describe retained historical reports or advisory publication acknowledgements as passing assessments.

The model-planned IQ path uses the existing deployment and incurs real usage. Use short record identifiers for the rehearsed lookups; an open-ended query may legitimately return no useful evidence. If that happens, show the failure honestly, use the specific recorded prompt, or label an existing saved result as a prior rehearsal.
