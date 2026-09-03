// Grant Cortex access to a Microsoft Purview account you already have.
//
// WHAT THIS DOES AND DOES NOT DO
// Azure RBAC on the Purview resource is the control plane: it lets the Cortex
// identity read the account resource itself. The roles that make the Unified
// Catalog answer — Data Governance Administrator, Global Catalog Reader,
// Governance Domain Owner — are Purview-internal and are assigned by
// `npm run bootstrap` (scripts/purview-access.js) through the Unified Catalog
// Policies API, not here. Both layers are cheap; missing the second is what
// produces "403 Not authorized to access account".
//
// Reader is deliberately the least privilege that lets the identity resolve
// the account. Nothing Cortex does needs to change the Purview resource.

param name string
param principalId string

var reader = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'

resource purview 'Microsoft.Purview/accounts@2021-12-01' existing = {
  name: name
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
// The account-scoped host is the LEGACY form. The Unified Catalog API lives
// at https://api.purview-service.microsoft.com — the app uses that.
output legacyAtlasEndpoint string = purview.properties.endpoints.catalog
