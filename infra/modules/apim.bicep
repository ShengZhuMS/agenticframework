// API Management.
//
// MCP server support is GA (Ignite, 25 Nov 2025) on Developer, Basic,
// Standard, Premium and the v2 tiers. Consumption is NOT supported.
//
// Note the management api-version for MCP resources is 2025-09-01-preview
// even though the feature is GA — that is used by the app at runtime, not
// here. This module only creates the instance.
//
// PROVISIONING TAKES 30-45 MINUTES.
param name string
param location string
param tags object
param sku string
param publisherEmail string
param publisherName string
param productId string = 'cortex'
param principalId string

var skuCapacity = sku == 'Developer' ? 1 : 1

resource apim 'Microsoft.ApiManagement/service@2024-05-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: sku
    capacity: skuCapacity
  }
  identity: { type: 'SystemAssigned' }
  properties: {
    publisherEmail: publisherEmail
    publisherName: publisherName
  }
}

// A product to bind published MCP servers to.
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

// The app's identity needs to create MCP servers, tools, policies and
// product bindings — that is API Management Service Contributor.
resource contributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(apim.id, principalId, '312a565d-c81f-4fd8-895a-4e21e48d571c')
  scope: apim
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '312a565d-c81f-4fd8-895a-4e21e48d571c')
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output name string = apim.name
output id string = apim.id
output gatewayUrl string = apim.properties.gatewayUrl
output principalId string = apim.identity.principalId
