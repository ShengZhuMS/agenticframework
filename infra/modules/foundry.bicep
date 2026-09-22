// Microsoft Foundry — account + project (the NEW model, not hub-based).
//
// RBAC WARNING: do NOT use 'Azure AI Developer'. Despite the name it is
// scoped to Azure ML workspaces and Foundry hubs, not Foundry projects, and
// will fail. Use Foundry User (build/test) and Foundry Project Manager
// (connections, publish). Roles beginning 'Cognitive Services' must also
// not be assigned.
param accountName string
param projectName string
param location string
param tags object
param principalId string

// Model parameters mirror modules/foundry-existing.bicep exactly, because
// main.bicep passes the same set to both. A new account has no model yet, so
// deployModel defaults to true here and false there.
@description('Deploy the model. main.bicep passes true for a new account.')
param deployModel bool = true

@description('The model to deploy. Kept separate from the deployment name so the deployment can be renamed without changing models.')
param modelName string = 'gpt-5.4-mini'

// Pinned, for the reason main.bicep gives: an unpinned version resolves to the
// account default, which moves — and a default that has entered Deprecated
// fails every new deployment with ServiceModelDeprecating.
@description('Model version, pinned. Never leave this empty.')
param modelVersion string = '2026-03-17'

@description('Deployment name, i.e. what the application asks for at inference time. Defaults to the model name.')
param modelDeploymentName string = ''

@allowed(['GlobalStandard', 'Standard', 'DataZoneStandard'])
param modelSkuName string = 'GlobalStandard'

param modelCapacity int = 30

@allowed(['OnceCurrentVersionExpired', 'OnceNewDefaultVersionAvailable', 'NoAutoUpgrade'])
param modelVersionUpgradeOption string = 'OnceCurrentVersionExpired'

var effectiveDeploymentName = empty(modelDeploymentName) ? modelName : modelDeploymentName

// Role definition IDs. Foundry User was previously named Azure AI User —
// the names changed, the IDs did not.
var foundryUser = '53ca6127-db72-4b80-b1b0-d745d6d5456d'
var foundryAgentConsumer = 'eed3b665-ab3a-47b6-8f48-c9382fb1dad6'
// Lets Cortex create project connections (MCP servers, AI Search). See foundry-existing.bicep.
var foundryProjectManager = 'eadc314b-1a2d-4efa-be10-5d325db5065e'

resource account 'Microsoft.CognitiveServices/accounts@2025-04-01-preview' = {
  name: accountName
  location: location
  tags: tags
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    allowProjectManagement: true
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: false
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-04-01-preview' = {
  parent: account
  name: projectName
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'Cortex'
    description: 'Agents built and published through Cortex.'
  }
}

// A model deployment is a PUT on a fixed name, so re-running with identical
// inputs is a no-op. Version and upgrade policy are explicit — see above.
resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview' = if (deployModel) {
  parent: account
  name: effectiveDeploymentName
  sku: {
    name: modelSkuName
    capacity: modelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
    versionUpgradeOption: modelVersionUpgradeOption
  }
}

// The app creates and tests agents, so it needs Foundry User.
resource userRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, principalId, foundryUser)
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryUser)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

// Least-privilege invoke path, for anything that only calls agents.
resource consumerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, principalId, foundryAgentConsumer)
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryAgentConsumer)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

resource projectManagerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, principalId, foundryProjectManager)
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryProjectManager)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output accountName string = account.name
output projectName string = project.name
// The canonical shape: https://<resource>.services.ai.azure.com/api/projects/<project>
output projectEndpoint string = 'https://${account.name}.services.ai.azure.com/api/projects/${project.name}'
output projectPrincipalId string = project.identity.principalId
output accountPrincipalId string = account.identity.principalId
output modelDeploymentName string = effectiveDeploymentName
