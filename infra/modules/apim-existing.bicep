// Grant Cortex access to an API Management instance you already have.
// Creates nothing except a product to bind published MCP servers to, and the
// role assignment Cortex needs to create them.

param name string
param productId string
param principalId string

// API Management Service Contributor — create MCP servers, tools, policies and
// product bindings. Scoped to this one APIM instance, nothing wider.
var apimContributor = '312a565d-c81f-4fd8-895a-4e21e48d571c'

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: name
}

// A product to bind published MCP servers to. Idempotent: if you already have
// one with this id, this updates it rather than failing.
resource product 'Microsoft.ApiManagement/service/products@2024-05-01' = {
  parent: apim
  name: productId
  properties: {
    displayName: 'Cortex'
    description: 'Data products, skills and agents published through Cortex.'
    subscriptionRequired: true
    approvalRequired: false
    state: 'published'
  }
}

resource contributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(apim.id, principalId, apimContributor)
  scope: apim
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', apimContributor)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output name string = apim.name
output gatewayUrl string = apim.properties.gatewayUrl
output id string = apim.id
