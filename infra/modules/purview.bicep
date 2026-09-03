// Microsoft Purview.
//
// PROVISIONING TAKES 10-15 MINUTES.
//
// IMPORTANT: the Unified Catalog roles this app needs (Data Governance
// Administrator, Global Catalog Reader, Governance Domain Owner) are
// Purview-internal and cannot be assigned from Bicep. `npm run bootstrap`
// grants them through the Unified Catalog Policies API — see
// scripts/purview-access.js. Bicep grants only the control-plane Reader role.
param name string
param location string
param tags object
param principalId string

var reader = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'

resource purview 'Microsoft.Purview/accounts@2021-12-01' = {
  name: name
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  sku: {
    name: 'Standard'
    capacity: 1
  }
  properties: {
    publicNetworkAccess: 'Enabled'
    managedResourceGroupName: 'mrg-${name}'
  }
}

resource readerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(purview.id, principalId, reader)
  scope: purview
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', reader)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output name string = purview.name
output id string = purview.id
output principalId string = purview.identity.principalId
// The account-scoped host is the LEGACY form. The Unified Catalog API lives
// at https://api.purview-service.microsoft.com — the app uses that.
output legacyAtlasEndpoint string = purview.properties.endpoints.catalog
