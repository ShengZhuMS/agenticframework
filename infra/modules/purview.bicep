// Microsoft Purview.
//
// PROVISIONING TAKES 10-15 MINUTES.
//
// IMPORTANT: the governance roles this app needs (Data Product Owner,
// Governance Domain Reader, Data reader) CANNOT be assigned from Bicep.
// They are data-plane roles assigned in the Purview portal, and tenant-level
// role groups do not accept service principals at all. See section 4 of the
// deployment guide — this is a manual step and it is easy to miss.
param name string
param location string
param tags object

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

output name string = purview.name
output id string = purview.id
output principalId string = purview.identity.principalId
// The account-scoped host is the LEGACY form. The Unified Catalog API lives
// at https://api.purview-service.microsoft.com — the app uses that.
output legacyAtlasEndpoint string = purview.properties.endpoints.catalog
