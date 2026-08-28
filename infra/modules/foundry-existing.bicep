// Grant Cortex access to a Microsoft Foundry account you already have.
//
// ⚠️ ROLE NAMES CHANGED. Use Foundry User and Foundry Project Manager. Do NOT
// use 'Azure AI Developer' — despite the name it is scoped to Azure ML
// workspaces and Foundry hubs, not Foundry projects, and will not work.
// Roles beginning 'Cognitive Services' must not be assigned either.

param accountName string
param projectName string
param principalId string

@description('Deploy the model. False when the account already has it — the usual case for an existing account.')
param deployModel bool = false
param modelName string = 'gpt-4o-mini'
param modelCapacity int = 30

// Foundry User (was Azure AI User — the name changed, the id did not).
var foundryUser = '53ca6127-db72-4b80-b1b0-d745d6d5456d'
// Foundry Agent Consumer — least privilege for invoking agents.
var foundryAgentConsumer = 'eed3b665-ab3a-47b6-8f48-c9382fb1dad6'

resource account 'Microsoft.CognitiveServices/accounts@2025-04-01-preview' existing = {
  name: accountName
}

// Only deployed on request. An existing account usually already has a model,
// and redeploying one you did not create is a good way to disrupt somebody
// else's workload.
resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview' = if (deployModel) {
  parent: account
  name: modelName
  sku: {
    name: 'GlobalStandard'
    capacity: modelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
    }
  }
}

resource userRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, principalId, foundryUser)
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryUser)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

resource consumerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, principalId, foundryAgentConsumer)
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryAgentConsumer)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output accountName string = account.name
output projectName string = projectName
output projectEndpoint string = 'https://${account.name}.services.ai.azure.com/api/projects/${projectName}'
