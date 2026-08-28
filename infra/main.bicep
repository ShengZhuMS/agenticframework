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

module containerApps 'modules/containerapps.bicep' = {
  name: 'containerapps'
  scope: rg
  params: {
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
    appInsightsConnectionString: monitoring.outputs.connectionString
    demoMode: demoMode
    foundryProjectEndpoint: foundry.outputs.projectEndpoint
    foundryModel: modelName
    apimServiceName: useExistingApim ? existingApimName : apim.outputs.name
    apimGatewayUrl: useExistingApim ? '' : apim.outputs.gatewayUrl
    purviewEndpoint: 'https://api.purview-service.microsoft.com'
    subscriptionId: subscription().subscriptionId
    resourceGroupName: rgName
    cosmosEndpoint: cosmos.outputs.endpoint
  }
}

output AZURE_RESOURCE_GROUP string = rgName
output AZURE_LOCATION string = location
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
