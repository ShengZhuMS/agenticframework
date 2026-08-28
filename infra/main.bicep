// =============================================================================
// Cortex — infrastructure.
//
// Subscription-scope entry point. `azd up` runs this.
//
// PROVISIONING TIME WARNING
//   API Management takes 30-45 minutes and Purview 10-15. Both are started
//   first and run in parallel with everything else. Budget an hour for a
//   cold deployment and do not discover this the day before a demo.
//
// COST WARNING
//   APIM Standard v2 (~£450/mo) plus Purview (~£800/mo) dominate. Set
//   apimSku to 'Developer' (~£40/mo) for a PoC, or point at existing
//   instances with useExistingApim / useExistingPurview.
// =============================================================================

targetScope = 'subscription'

@minLength(2)
@maxLength(20)
@description('Environment name. Used to derive all resource names.')
param environmentName string

@description('Azure region. uksouth is Defra-appropriate and has every service used here.')
param location string = 'uksouth'

@description('APIM SKU. Developer is fine for a PoC and ~10x cheaper. MCP server support requires Developer, Basic, Standard, Premium, or a v2 tier — Consumption is NOT supported.')
@allowed(['Developer', 'BasicV2', 'StandardV2'])
param apimSku string = 'Developer'

param apimPublisherEmail string
param apimPublisherName string = 'Defra Cortex PoC'

@description('Model to deploy. gpt-5-mini is cheap, fast and sufficient for summarise-and-cite work.')
param modelName string = 'gpt-5-mini'

@description('Model capacity in thousands of tokens per minute. Lower this if the sandbox quota rejects the deployment.')
param modelCapacity int = 30

@description('Skip APIM creation and use an existing instance.')
param useExistingApim bool = false
param existingApimName string = ''
param existingApimResourceGroup string = ''

@description('Skip Purview creation and use an existing account.')
param useExistingPurview bool = false
param existingPurviewName string = ''
param existingPurviewResourceGroup string = ''

@description('Pin every adapter to seeded data. Recommended true for the first demo.')
param demoMode bool = true

@description('Write the endpoints and identifiers provisioning knows into Key Vault. Needs "Key Vault Secrets Officer" on the vault for whoever runs the deployment. Set false to onboard every value by hand.')
param seedKeyVault bool = true

param tags object = {
  'azd-env-name': environmentName
  project: 'cortex'
  purpose: 'poc'
}

var prefix = toLower(replace(environmentName, '_', '-'))
var uniq = substring(uniqueString(subscription().id, environmentName), 0, 6)
var rgName = 'rg-${prefix}'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: rgName
  location: location
  tags: tags
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: rg
  params: {
    name: 'id-${prefix}'
    location: location
    tags: tags
  }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  scope: rg
  params: {
    logAnalyticsName: 'log-${prefix}'
    appInsightsName: 'appi-${prefix}'
    location: location
    tags: tags
  }
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  scope: rg
  params: {
    name: 'cr${replace(prefix, '-', '')}${uniq}'
    location: location
    tags: tags
    principalId: identity.outputs.principalId
  }
}

// Started early — this is the long pole at 30-45 minutes.
module apim 'modules/apim.bicep' = if (!useExistingApim) {
  name: 'apim'
  scope: rg
  params: {
    name: 'apim-${prefix}-${uniq}'
    location: location
    tags: tags
    sku: apimSku
    publisherEmail: apimPublisherEmail
    publisherName: apimPublisherName
    principalId: identity.outputs.principalId
  }
}

module purview 'modules/purview.bicep' = if (!useExistingPurview) {
  name: 'purview'
  scope: rg
  params: {
    name: 'pview-${prefix}-${uniq}'
    location: location
    tags: tags
  }
}

module foundry 'modules/foundry.bicep' = {
  name: 'foundry'
  scope: rg
  params: {
    accountName: 'aif-${prefix}-${uniq}'
    projectName: 'cortex'
    location: location
    tags: tags
    modelName: modelName
    modelCapacity: modelCapacity
    principalId: identity.outputs.principalId
  }
}

module cosmos 'modules/cosmos.bicep' = {
  name: 'cosmos'
  scope: rg
  params: {
    name: 'cosmos-${prefix}-${uniq}'
    location: location
    tags: tags
    principalId: identity.outputs.principalId
  }
}

module keyvault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  scope: rg
  params: {
    // Vault names are globally unique, 3-24 chars, letters/digits/hyphens.
    name: take('kv-${replace(prefix, '-', '')}${uniq}', 24)
    location: location
    tags: tags
    principalId: identity.outputs.principalId
  }
}

module containerApps 'modules/containerapps.bicep' = {
  name: 'containerapps'
  scope: rg
  params: {
    keyVaultName: keyvault.outputs.name
    environmentName: 'cae-${prefix}'
    webAppName: 'cortex-web'
    mcpAppName: 'cortex-purview-mcp'
    location: location
    tags: tags
    registryLoginServer: registry.outputs.loginServer
    identityId: identity.outputs.id
    identityClientId: identity.outputs.clientId
    logAnalyticsCustomerId: monitoring.outputs.customerId
    logAnalyticsKey: monitoring.outputs.primarySharedKey
    demoMode: demoMode
  }
}

// Seed the vault with everything provisioning knows. Runs after container
// apps because two of the values are its outputs.
//
// The APIM subscription key and the Entra client secret are NOT here — they
// are not known to the template, and a credential written through a
// deployment is readable in the deployment history afterwards. Those two are
// onboarded by hand. See the deployment guide.
module keyvaultSecrets 'modules/keyvault-secrets.bicep' = if (seedKeyVault) {
  name: 'keyvault-secrets'
  scope: rg
  params: {
    keyVaultName: keyvault.outputs.name
    values: {
      'azure-subscription-id': subscription().subscriptionId
      'azure-resource-group': rgName
      'apim-service-name': useExistingApim ? existingApimName : apim.outputs.name
      'apim-gateway-url': useExistingApim ? '' : apim.outputs.gatewayUrl
      'foundry-project-endpoint': foundry.outputs.projectEndpoint
      'foundry-model': modelName
      'purview-endpoint': 'https://api.purview-service.microsoft.com'
      'purview-mcp-url': '${containerApps.outputs.mcpUrl}/mcp'
      'public-base-url': containerApps.outputs.webUrl
      'cosmos-endpoint': cosmos.outputs.endpoint
      'appinsights-connection-string': monitoring.outputs.connectionString
      'entra-tenant-id': subscription().tenantId
    }
  }
}

output AZURE_RESOURCE_GROUP string = rgName
output AZURE_LOCATION string = location
output KEYVAULT_NAME string = keyvault.outputs.name
output KEYVAULT_URI string = keyvault.outputs.uri
output CORTEX_WEB_URL string = containerApps.outputs.webUrl
output CORTEX_MCP_URL string = containerApps.outputs.mcpUrl
output CORTEX_IDENTITY_PRINCIPAL_ID string = identity.outputs.principalId
output CORTEX_IDENTITY_CLIENT_ID string = identity.outputs.clientId
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registry.outputs.loginServer
output FOUNDRY_PROJECT_ENDPOINT string = foundry.outputs.projectEndpoint
output APIM_SERVICE_NAME string = useExistingApim ? existingApimName : apim.outputs.name
output APIM_GATEWAY_URL string = useExistingApim ? '' : apim.outputs.gatewayUrl
output PURVIEW_ACCOUNT_NAME string = useExistingPurview ? existingPurviewName : purview.outputs.name
output PURVIEW_ENDPOINT string = 'https://api.purview-service.microsoft.com'
