# Cortex

A front door to Microsoft Purview, Azure API Management and Microsoft Foundry, built for Defra.

**Everything is live.** There is no demo mode, no sample data and no offline path. Every screen reads Purview, API Management and Foundry through their real APIs. Publish an agent and it is genuinely registered in API Management; delete a data product in the Purview portal and it disappears from the Marketplace on the next refresh.

---

## Deploy it

```powershell
.\scripts\Deploy-Cortex.ps1
```

Or in VS Code: **Ctrl+Shift+P → Tasks: Run Task → Cortex: Deploy to Azure**.

**Cortex reuses your existing Azure estate.** It creates only the container apps and its own managed identity. Check what will be reused first:

```powershell
.\scripts\Deploy-Cortex.ps1 -WhatIfResources
```

Two steps cannot be automated — Entra sign-in with the **groups claim**, and the Purview roles in **both** planes. Both are in **`docs/DEPLOY.md`**, and the app will not work correctly until they are done.

## Run it locally

```powershell
.\scripts\Start-Local.ps1 -Groups all-staff,waste-crime,analysts
```

Local means *your machine, real Azure*. There is no offline mode. Anything you publish is published for real.

```powershell
npm test                       # 127 tests, no Azure needed
node scripts/bootstrap.js --dry-run   # validate content, no Azure needed
```

---

## What it does

| | |
|---|---|
| **Marketplace** | Data products from Purview, APIs and MCP servers from API Management, agents from Foundry — merged into one register with search, filters and the six visibility states |
| **Entry standard** | Every mandatory field, each showing its source and who maintains it. Limitations, lineage, licence and who it covers, minimum aggregation |
| **Map** | The estate by governance domain, with cross-domain dependencies and a full text alternative |
| **Build an agent** | Approved model catalogue, knowledge checklist with unavailable items greyed out and explained, permitted actions, seven computed assurance gates |
| **Publish** | Generates OpenAPI, imports it into APIM, creates an MCP server over it, writes the endpoint back to the register |
| **Ask** | Answers with a provenance panel: sources, freshness, confidence, and what it could not reach |
| **Requests** | A working lifecycle — the holder's agent drafts inside *their* permissions, a person reviews the method and releases |
| **Share your data** | Gateway registration, ownership confirmation, the access-request queue |

## The governance model

**Microsoft Entra group membership decides everything.** There are no personas and no anonymous browsing. Clearance and licence entitlement are derived from groups, so they live in Entra where they can be governed and revoked — not in this application.

Two consequences worth knowing:

1. **The groups claim is mandatory.** Without it every user appears to be in no groups, almost every entry correctly resolves to "not available", and the Marketplace looks broken for reasons that are not obvious. `/profile` diagnoses exactly this.
2. **An agent can never reach further than the person who built it.** The greyed-out checkbox is a courtesy; the server-side refusal on submit is the control, and it is tested.

## No number without a source

Usage, error rate and latency come from the API Management Reports API. **Cost per use, carbon and "believed estate" coverage were removed** rather than labelled illustrative — a figure nobody can defend is worse than an absent one, because it invites a question that cannot be answered. An entry with no gateway traffic says so rather than showing a zero.

---

## Layout

```
docs/             HANDOVER.md · ARCHITECTURE.md · DEPLOY.md
infra/            Bicep. Every resource name and RG is a parameter.
scripts/          Deploy-Cortex.ps1, Start-Local.ps1, Test-Cortex.ps1, bootstrap.js
bootstrap/        Defra content — INPUT to a script, not runtime data
src/bff/          Backend for frontend. All Azure credentials live here.
  adapters/       purview, apim, foundry, keyvault, token
  services/       visibility, assurance, agents, publish, ask, requests, identity
src/web/          Server-rendered GOV.UK pages
src/purview-mcp/  Glue 1 — the Purview MCP server
test/             127 tests, stubbed at the HTTP boundary
.vscode/          Tasks, launch configs, extension recommendations
```

## The two pieces of custom glue

Microsoft ships neither, and Cortex is largely the fact that they exist.

**Glue 1 — `src/purview-mcp/`.** There is no official Purview MCP server and no Purview knowledge source inside Foundry agents. This exposes the catalogue as MCP tools so an agent can reach it. Catalogue metadata only, never the underlying data.

**Glue 2 — `src/bff/services/publish.js`.** There is no documented way to expose a Foundry agent as an MCP server; Foundry's own path produces HTTP or A2A in APIM. So Cortex generates OpenAPI, imports it, projects an MCP server over it, and writes the endpoint back.

## Front end

Server-rendered GOV.UK Design System. `npm install` vendors the official `govuk-frontend` package into `src/web/assets/vendor/`; if that has not run, the app falls back to a bundled stylesheet using the same class names, so a missing build step degrades typography rather than the service.

Zero `<script>` tags. The whole application works with JavaScript disabled.

---

## Documentation

| | |
|---|---|
| **`docs/HANDOVER.md`** | Read first if you are picking this up. State of play, verified API facts, traps, next work. |
| **`docs/ARCHITECTURE.md`** | What it is, why it exists, how it is built, what was deliberately left out. |
| **`docs/DEPLOY.md`** | Deploy to Azure and run locally, including every Key Vault secret. |
