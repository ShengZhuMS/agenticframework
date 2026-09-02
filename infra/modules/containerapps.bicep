// Container Apps environment plus the two Cortex apps.
//
// cortex-web has minReplicas 1 deliberately. Scale-to-zero cold start is the
// single most likely thing to embarrass a live demo — a 20-second first page
// load in front of a CTO. The cost of one always-on 0.5 vCPU replica is
// roughly £25/month and it buys the demo.

param environmentName string
param webAppName string
param mcpAppName string
param location string
param tags object

param registryLoginServer string
param identityId string
param identityClientId string

param logAnalyticsCustomerId string
@secure()
param logAnalyticsKey string

// ------------------------------------------------------- configuration mode
//
// WHY THERE ARE TWO MODES
// Key Vault firewall rules apply to the DATA plane only. A vault with
// `publicNetworkAccess: Disabled` still accepts secrets written by an ARM
// deployment (control plane, and the ARM deployment service is a trusted
// service), but it refuses to be READ by anything without a private endpoint —
// and Azure Container Apps is not on the Key Vault trusted-services list.
//
// So in a locked-down subscription the vault can be seeded and still be
// useless at runtime: the app starts, fails every secret read, falls back to
// environment variables, and shows an empty marketplace.
//
// `useKeyVault: false` is the honest answer to that. Configuration is passed
// to the apps directly, and the three genuinely sensitive values become
// Container Apps secrets. The application needs no change: config.js already
// treats the environment as the fallback for every catalogued secret, and an
// empty KEYVAULT_NAME makes the vault adapter a no-op rather than a 15-second
// timeout at every start.
//
// THE TRADE, STATED PLAINLY: a Container Apps secret is encrypted at rest but
// readable by anyone with Contributor on the app (`az containerapp secret list
// --show-values`). Key Vault behind a private endpoint is stronger. This is a
// proof of concept in a sandbox, and the alternative is not deploying at all —
// but it should not go to production this way. docs/DEPLOY.md §5 has the route
// back.
@description('Read configuration from Key Vault at runtime. Set false when the vault is unreachable from the container apps, and configuration is passed directly instead.')
param useKeyVault bool = true

@description('Key Vault holding endpoints and keys. Only passed to the apps when useKeyVault is true.')
param keyVaultName string

// --------------------------------------------------- direct configuration
// Used only when useKeyVault is false. Names match SECRET_CATALOGUE in
// src/bff/adapters/keyvault.js — that mapping is the contract, not a
// convention, so change both or neither.

param azureSubscriptionId string = ''
param azureResourceGroup string = ''
param apimServiceName string = ''
param apimGatewayUrl string = ''
param foundryProjectEndpoint string = ''
param foundryModel string = ''
param purviewEndpoint string = ''
param entraTenantId string = ''
param entraClientId string = ''

// Entra emits group object ids; access rules read against names. This used to
// be set with `az containerapp update --set-env-vars` after every deploy and
// silently dropped by the next provision. It belongs here.
@description('Group id to name mapping, e.g. "<guid>=all-staff,<guid>=waste-crime".')
param groupNames string = ''

// ---------------------------------------------------------------- secrets
// Supplied only if you choose to pass them through the deployment. Left empty,
// the `secrets` property is omitted from the template entirely rather than
// written as an empty array — an empty array is a declarative instruction to
// DELETE whatever is there, which would wipe a secret the deploy script set
// out of band on the previous run.
//
// Deploy-Cortex.ps1 deliberately does not use these: it writes the APIM key
// straight onto the app after provisioning, so the credential never lands in
// the azd environment file on disk.

@secure()
@description('APIM subscription key. Leave empty and let the deploy script set it on the app instead.')
param apimSubscriptionKey string = ''

@secure()
param appInsightsConnectionString string = ''

@secure()
param entraClientSecret string = ''

// ---------------------------------------------------------------- images
//
// THE RE-RUN BUG THIS FIXES
// These used to be hardcoded to the placeholder. `azd up` runs provision and
// then deploy, so on every run after the first, provisioning reset both apps
// back to the mcr quickstart image before deploy pushed the real one — a
// visible outage mid-deploy, and a permanent rollback for any app azd does
// not deploy. azd writes SERVICE_<NAME>_IMAGE_NAME into the environment after
// each successful deploy; main.parameters.json feeds those values back in
// here, so a re-provision keeps whatever is already running.
@description('Image for cortex-web. Supplied by azd as SERVICE_WEB_IMAGE_NAME after the first deploy. Empty on a first run, which is the only time the placeholder is used.')
param webImageName string = ''

@description('Image for cortex-purview-mcp. Supplied by azd as SERVICE_PURVIEW_MCP_IMAGE_NAME after the first deploy.')
param mcpImageName string = ''

// The MCP server is called by a Foundry agent in the middle of a demo, and an
// MCP client gives up long before a cold container finishes starting. One
// replica of 0.25 vCPU is a few pounds a month; a timeout mid-answer is not
// recoverable in front of an audience. Set to 0 if you are only testing.
@description('Minimum replicas for the MCP server. 1 avoids a cold start on the first agent call.')
param mcpMinReplicas int = 1

// Placeholder image, used only until `azd deploy` pushes the real one.
var bootstrapImage = 'mcr.microsoft.com/k8se/quickstart:latest'

var effectiveWebImage = empty(webImageName) ? bootstrapImage : webImageName
var effectiveMcpImage = empty(mcpImageName) ? bootstrapImage : mcpImageName

// THE PORT IS NEVER CONDITIONAL. Read this before "fixing" it.
//
// `azd up` provisions and then deploys, and `azd deploy` updates ONLY the
// container image — it does not re-run this template. So any ingress setting
// derived from "is this still the placeholder?" is written while the
// placeholder is running and is never corrected once the real image is pushed
// a minute later.
//
// Making targetPort follow the placeholder (80) therefore breaks the app on the
// very first deploy: the real image listens on 3000, ingress still points at 80,
// nothing answers, and the revision never becomes healthy. What you get is the
// Container Apps welcome page or a 502 — never Cortex.
//
// So ingress always points at 3000, the port Cortex actually listens on. On a
// first provision the placeholder is briefly unreachable, which is harmless and
// resolves the moment `azd deploy` pushes the real image.
//
// The readiness probe IS conditional, because that direction is safe: a missing
// probe never breaks anything, whereas a probe against the placeholder fails the
// revision and takes the whole provision down with it.
var appPort = 3000
var webIsPlaceholder = empty(webImageName)
var mcpIsPlaceholder = empty(mcpImageName)

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsKey
      }
    }
  }
}

// An app's own FQDN cannot be read inside its own definition — that is a
// circular reference. The environment's default domain is known before either
// app is created, and an externally-ingressed app is always
// <app-name>.<defaultDomain>, so both public URLs can be computed up front.
// This is what lets PUBLIC_BASE_URL and PURVIEW_MCP_URL be set directly
// instead of being patched on afterwards by a script.
var computedWebUrl = 'https://${webAppName}.${env.properties.defaultDomain}'
var computedMcpUrl = 'https://${mcpAppName}.${env.properties.defaultDomain}'

// ------------------------------------------------------------ environment

// Pinned api-versions are code-level constants, not configuration.
var pinnedVersions = [
  { name: 'APIM_API_VERSION', value: '2025-09-01-preview' }
  { name: 'PURVIEW_API_VERSION', value: '2026-03-20-preview' }
]

var commonEnv = [
  { name: 'PORT', value: '${appPort}' }
  { name: 'NODE_ENV', value: 'production' }
  { name: 'AZURE_CLIENT_ID', value: identityClientId }
]

// Key Vault mode: the vault name and nothing else. The values it supplies are
// deliberately NOT duplicated here — two sources for one value means one of
// them is eventually wrong, and the wrong one is always the one nobody
// remembers to update.
var keyVaultEnv = useKeyVault ? [ { name: 'KEYVAULT_NAME', value: keyVaultName } ] : []

// Direct mode: the same values, passed straight to the app. KEYVAULT_NAME is
// deliberately absent — an empty vault name makes the adapter skip cleanly
// rather than spend its timeout budget failing.
var directEnv = useKeyVault ? [] : [
  { name: 'AZURE_SUBSCRIPTION_ID', value: azureSubscriptionId }
  { name: 'AZURE_RESOURCE_GROUP', value: azureResourceGroup }
  { name: 'APIM_SERVICE_NAME', value: apimServiceName }
  { name: 'APIM_GATEWAY_URL', value: apimGatewayUrl }
  { name: 'FOUNDRY_PROJECT_ENDPOINT', value: foundryProjectEndpoint }
  { name: 'FOUNDRY_MODEL', value: foundryModel }
  { name: 'PURVIEW_ENDPOINT', value: purviewEndpoint }
  { name: 'PURVIEW_MCP_URL', value: '${computedMcpUrl}/mcp' }
  { name: 'PUBLIC_BASE_URL', value: computedWebUrl }
  { name: 'ENTRA_TENANT_ID', value: entraTenantId }
]

var mcpDirectEnv = useKeyVault ? [] : [
  { name: 'AZURE_SUBSCRIPTION_ID', value: azureSubscriptionId }
  { name: 'AZURE_RESOURCE_GROUP', value: azureResourceGroup }
  { name: 'PURVIEW_ENDPOINT', value: purviewEndpoint }
  { name: 'ENTRA_TENANT_ID', value: entraTenantId }
]

var optionalEnv = concat(
  empty(entraClientId) ? [] : [ { name: 'ENTRA_CLIENT_ID', value: entraClientId } ],
  empty(groupNames) ? [] : [ { name: 'CORTEX_GROUP_NAMES', value: groupNames } ]
)

// A secretRef pointing at a secret that does not exist stops the container
// starting, so each of these appears only when its value was supplied.
var webSecrets = concat(
  empty(apimSubscriptionKey) ? [] : [ { name: 'apim-subscription-key', value: apimSubscriptionKey } ],
  empty(appInsightsConnectionString) ? [] : [ { name: 'appinsights-connection-string', value: appInsightsConnectionString } ],
  empty(entraClientSecret) ? [] : [ { name: 'entra-client-secret', value: entraClientSecret } ]
)

var webSecretEnv = concat(
  empty(apimSubscriptionKey) ? [] : [ { name: 'APIM_SUBSCRIPTION_KEY', secretRef: 'apim-subscription-key' } ],
  empty(appInsightsConnectionString) ? [] : [ { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'appinsights-connection-string' } ],
  empty(entraClientSecret) ? [] : [ { name: 'ENTRA_CLIENT_SECRET', secretRef: 'entra-client-secret' } ]
)

var webEnv = concat(commonEnv, keyVaultEnv, directEnv, optionalEnv, webSecretEnv, pinnedVersions)
var mcpEnv = concat(commonEnv, keyVaultEnv, mcpDirectEnv, [ { name: 'PURVIEW_API_VERSION', value: '2026-03-20-preview' } ])

var webBaseConfig = {
  activeRevisionsMode: 'Single'
  ingress: {
    external: true
    targetPort: appPort
    transport: 'auto'
    allowInsecure: false
  }
  registries: [
    {
      server: registryLoginServer
      identity: identityId
    }
  ]
}

// union() rather than a property set to [] — see the note on the secret params.
var webConfig = empty(webSecrets) ? webBaseConfig : union(webBaseConfig, { secrets: webSecrets })

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: webAppName
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: env.id
    configuration: webConfig
    template: {
      containers: [
        {
          name: 'web'
          image: effectiveWebImage
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: webEnv
          probes: webIsPlaceholder ? [] : [
            {
              type: 'Readiness'
              httpGet: { path: '/api/health', port: appPort }
              initialDelaySeconds: 3
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        // Never zero. Cold start is the top demo risk.
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
}

// Glue 1 — the Purview MCP server. There is no official Purview MCP server,
// and no Purview tool or knowledge source inside Foundry agents, so this is
// how a Foundry agent reaches the catalogue at all.
resource mcp 'Microsoft.App/containerApps@2024-03-01' = {
  name: mcpAppName
  location: location
  tags: union(tags, { 'azd-service-name': 'purview-mcp' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // Public for the PoC. Production uses private endpoints and a
        // dedicated MCP subnet delegated to Microsoft.App/environments.
        external: true
        targetPort: appPort
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registryLoginServer
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'purview-mcp'
          image: effectiveMcpImage
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: mcpEnv
          // The MCP server serves /health, not /api/health — it is a different
          // process from the web app and does not share its routing.
          probes: mcpIsPlaceholder ? [] : [
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: appPort }
              initialDelaySeconds: 3
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: mcpMinReplicas
        maxReplicas: 2
      }
    }
  }
}

output webUrl string = 'https://${web.properties.configuration.ingress.fqdn}'
output mcpUrl string = 'https://${mcp.properties.configuration.ingress.fqdn}'
output webName string = web.name
output mcpName string = mcp.name
output environmentId string = env.id
output environmentName string = env.name
output configSource string = useKeyVault ? 'keyvault' : 'direct'
