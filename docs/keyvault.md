# Cortex — Key Vault secrets to onboard

**17 values. Bicep writes 12 of them. You onboard 5, and only 2 of those are genuinely secret.**

---

## The short version

```bash
azd up                                    # creates the vault, writes 12 values
az keyvault secret set --vault-name <kv> --name apim-subscription-key --value "<key>"
```

That is the minimum. Everything else is optional or already written.

---

## 1. What you onboard by hand

Bicep cannot write these: it does not know them, and a credential written through a deployment stays readable in the deployment history afterwards.

| Secret name | Required | Genuinely secret | What it is and where to get it |
|---|---|---|---|
| `apim-subscription-key` | **Yes** | **Yes** | The subscription key for the Cortex product in API Management. This is the one credential the app truly holds — it is a bearer token for every published MCP server.<br>`az apim subscription list --service-name <apim> -g <rg>`, or Portal → APIM → Subscriptions → Cortex → Show/copy primary key. |
| `entra-client-secret` | No | **Yes** | Client secret of the sign-in app registration. **Skip this if you can** — use a federated credential, or run with the persona switcher, and there is no secret to rotate. |
| `entra-client-id` | No | No | Application (client) ID of the sign-in app registration. Only needed once you turn on real Entra sign-in. |
| `foundry-mcp-connection` | No | No | Id of the Foundry project connection that carries the APIM key, so an agent can call an APIM MCP server. Created after first deployment — see section 4. |
| `purview-datamap-endpoint` | No | No | Data Map base URL. Only set this if the default does not match yours; the host and path prefix differ between portal generations. |

**Setting them:**

```bash
KV=$(azd env get-values | grep KEYVAULT_NAME | cut -d'"' -f2)

az keyvault secret set --vault-name "$KV" \
  --name apim-subscription-key --value "<primary key>"

# Only if you are enabling real sign-in
az keyvault secret set --vault-name "$KV" --name entra-client-id     --value "<appId>"
az keyvault secret set --vault-name "$KV" --name entra-client-secret --value "<secret>"
```

---

## 2. What Bicep writes for you

These are endpoints and identifiers that provisioning discovers. They are written automatically by the `keyvault-secrets` module. Set `seedKeyVault=false` if you would rather onboard everything by hand.

| Secret name | Required | Value |
|---|---|---|
| `azure-subscription-id` | Yes | Subscription holding APIM and Foundry. Used to build ARM resource IDs. |
| `azure-resource-group` | Yes | Resource group holding APIM. |
| `apim-service-name` | Yes | APIM instance name. |
| `apim-gateway-url` | Yes | `https://<apim>.azure-api.net` |
| `foundry-project-endpoint` | Yes | `https://<resource>.services.ai.azure.com/api/projects/<project>` |
| `purview-mcp-url` | Yes | The Cortex Purview MCP server (Glue 1), ending `/mcp` |
| `public-base-url` | Yes | Public URL of the web app. APIM calls back to it, so the generated OpenAPI must carry a reachable address. |
| `foundry-model` | No | Deployed model name. Defaults to `gpt-5-mini`. |
| `purview-endpoint` | No | Defaults to `https://api.purview-service.microsoft.com`. Override only for a private endpoint. |
| `cosmos-endpoint` | No | Cortex Index account endpoint. Auth is managed identity — there is no key. |
| `appinsights-connection-string` | No | Contains an instrumentation key, so it is treated as a credential. |
| `entra-tenant-id` | No | Tenant id, for sign-in and for the `validate-azure-ad-token` policy in APIM. |

---

## 3. Worth saying plainly: most of this is not secret

You asked to onboard all Azure resource URIs and keys. The code supports that, and the tables above do it. But it is worth being clear about what you are buying.

**Genuinely secret — 3 of 17.** `apim-subscription-key`, `entra-client-secret`, and `appinsights-connection-string` (which embeds an instrumentation key). These grant access. They belong in a vault.

**The other 14 are configuration, not credentials.** A resource group name or an endpoint URL is not a secret — it is in the portal, in `azd env get-values`, and in the ARM template. Putting them in Key Vault buys one real thing: **a single place to change configuration**, which is genuinely useful across environments. It costs three: a startup dependency, a per-value lookup, and a failure mode where the app cannot start because a *non-secret* is unreachable.

The implementation handles that cost — see section 6 — so the choice is safe either way. If you want the simpler shape later, keep the 3 real secrets in the vault and move the other 14 to container app environment variables. The code supports both at once, with no change.

**The strongest argument for the current setup is not secrecy.** It is that endpoints change between sandbox, dev and production, and one vault per environment means one place to change them.

---

## 4. After the first deployment

Two follow-ups, both one-off.

**a. Create the Foundry connection that lets an agent call APIM.** Foundry needs the APIM subscription key to reach an APIM MCP server:

```bash
azd ai connection create cortex-apim --kind remote-tool \
  --target "$(az keyvault secret show --vault-name "$KV" --name purview-mcp-url --query value -o tsv)" \
  --auth-type custom-keys \
  --custom-key "Ocp-Apim-Subscription-Key=<the APIM key>"

az keyvault secret set --vault-name "$KV" --name foundry-mcp-connection --value "<connection id>"
```

**b. Purview governance roles.** Unchanged, and still the step people miss — it cannot be automated, and it needs **both** planes. See section 4 of the deployment guide.

---

## 5. Checking it worked

```bash
curl -s https://<app>/api/health/keyvault | jq
```

```jsonc
{
  "ok": true,
  "vault": "https://kv-cortexpoc-a1b2c3.vault.azure.net",
  "hydrated": true,
  "missingRequired": [],
  "fromKeyVault": 13,
  "fromEnvironment": 0,
  "secrets": [
    { "secret": "apim-gateway-url",      "source": "keyvault", "present": true,
      "value": "https://apim-cortex.azure-api.net" },
    { "secret": "apim-subscription-key", "source": "keyvault", "present": true }
  ]
}
```

Note the second entry. **A sensitive secret reports that it resolved and from where, but never its value.** Non-sensitive entries do show their value, because a wrong endpoint is the most common misconfiguration and you need to be able to see it.

`missingRequired` is the field to watch. If it is not empty, live adapters will fail — and the same list is printed in the startup log, so you see it before anyone clicks anything.

---

## 6. How the app behaves when the vault misbehaves

Deliberate, and tested.

| Situation | Behaviour |
|---|---|
| Vault unreachable | Falls back to environment variables, records the error, **starts anyway**. Verified: 570ms to listening against a non-existent vault. |
| Vault accepts the connection then never replies | Bounded by `KEYVAULT_TIMEOUT_MS` (5s per secret) and `KEYVAULT_BUDGET_MS` (15s total), then falls back. `fetch()` has no default timeout — without this guard the container would never pass its readiness probe. |
| Secret missing | Falls back to the environment. A 404 is a normal condition, not a fault. |
| 403 on a secret | Falls back, and the error names the fix: the app identity needs the **Key Vault Secrets User** role. |
| Demo mode | **No vault call at all.** `DEMO_MODE=true` makes no external calls of any kind, so a demo on a hostile network never touches Key Vault. |

Secrets are cached for 10 minutes, so a rotated key is picked up without a restart, and no page load ever waits on the vault.

---

## 7. Permissions

| Principal | Role | Scope | Why |
|---|---|---|---|
| Cortex managed identity | **Key Vault Secrets User** | The vault | Read secret values. Assigned by Bicep. Deliberately not Secrets Officer — the app reads, it never writes. |
| Whoever runs `azd up` | **Key Vault Secrets Officer** | The vault | Write the 12 seeded values. Only needed when `seedKeyVault=true`. |
| You, onboarding by hand | **Key Vault Secrets Officer** | The vault | Set the manual secrets. |

The vault uses **RBAC, not access policies** (`enableRbacAuthorization: true`). Access policies are the legacy model and cannot be managed with standard Azure role assignments.

---

## 8. Local development

No vault needed. Environment variables still work exactly as before.

```bash
DEMO_MODE=true npm start                      # nothing external at all
```

```bash
DEMO_MODE=false KEYVAULT_NAME=kv-cortexpoc-a1b2c3 npm start    # real vault via az login
```

```bash
DEMO_MODE=false \
APIM_SERVICE_NAME=apim-cortex \
FOUNDRY_PROJECT_ENDPOINT=https://... \
npm start                                     # no vault, pure environment
```

Key Vault wins where both are set, so onboarding a value always takes effect. A stale environment variable can never silently override what operations put in the vault.
