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

@description('The model to deploy. Kept separate from the deployment name so the deployment can be renamed without changing models.')
param modelName string = 'gpt-5.4-mini'

// WHY THE VERSION IS EXPLICIT
// Omitting it makes ARM resolve the account's *default* version, which moves
// underneath you. That is what broke this deployment: the default for
// gpt-4o-mini resolved to 2024-07-18, which entered the Deprecated lifecycle
// stage. Deprecated means existing deployments keep serving but NEW ones are
// refused outright — ServiceModelDeprecating, with no obvious cause in the
// template because the template never named a version. Always name it.
@description('Model version, pinned. Never leave this empty — an unpinned version resolves to whatever ARM currently defaults to, which is how a deployment starts failing without the template changing.')
param modelVersion string = '2026-03-17'

@description('Deployment name, i.e. what the application asks for at inference time. Defaults to the model name.')
param modelDeploymentName string = ''

@description('GlobalStandard unless you need data residency, in which case Standard.')
@allowed(['GlobalStandard', 'Standard', 'DataZoneStandard'])
param modelSkuName string = 'GlobalStandard'

param modelCapacity int = 30

// OnceCurrentVersionExpired is the setting that stops this failure recurring:
// the pinned version is held until Azure retires it, and only then does Azure
// move it forward, rather than the deployment silently failing on a re-run.
@allowed(['OnceCurrentVersionExpired', 'OnceNewDefaultVersionAvailable', 'NoAutoUpgrade'])
param modelVersionUpgradeOption string = 'OnceCurrentVersionExpired'

var effectiveDeploymentName = empty(modelDeploymentName) ? modelName : modelDeploymentName

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
//
// RE-RUN SAFETY: a model deployment is a PUT on a fixed name, so re-running
// with identical inputs is a no-op. It is only a conflict if the sku or
// capacity changed, which is why Deploy-Cortex.ps1 reads the live deployment
// first and leaves deployModel false when one already exists and is healthy.
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
output modelDeploymentName string = effectiveDeploymentName
