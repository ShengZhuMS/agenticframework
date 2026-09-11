// Azure AI Search — one index per data product, built from the sample files.
//
// WHY IT IS HERE
// A data product describes data; an agent needs to READ it. The Foundry
// azure_ai_search tool reads an index; the index is built by an indexer that
// reads the storage account with this service's own identity. Nothing is
// copied into Cortex and no key is used anywhere in the chain.
//
// TIER
// Basic holds 15 indexes, 15 indexers and 15 data sources — room for the 14
// data products and one spare. A fifteenth product needs Standard S1
// (50 of each). Free (3 indexes) is too small; leave it for experiments.
//
// IDENTITIES AND ROLES
//   this service (system-assigned)   Storage Blob Data Reader on the data
//                                    account — granted in data.bicep
//   Cortex identity                  Search Service Contributor (create
//                                    indexes, indexers, data sources) and
//                                    Search Index Data Contributor (read
//                                    and probe)
//   Foundry account identity         Search Index Data Contributor +
//                                    Search Service Contributor — what the
//                                    azure_ai_search tool needs for a
//                                    keyless project connection
//
// authOptions.aadOrApiKey: the app and Foundry use Entra; the portal can
// still use the admin key for a quick look.

param name string
param location string
param tags object

@allowed(['free', 'basic', 'standard'])
param sku string = 'basic'

@description('Semantic ranker plan. "free" costs nothing on Basic and above; "disabled" removes one failure mode if the region lacks it.')
@allowed(['disabled', 'free', 'standard'])
param semanticSearch string = 'disabled'

@description('Principal id of the Cortex user-assigned identity.')
param cortexPrincipalId string

@description('Principal id of the Foundry account\'s system-assigned identity. Empty to skip.')
param foundryPrincipalId string = ''

var searchServiceContributor = '7ca78c08-252a-4471-8644-bb5ff32d4ba0'
var searchIndexDataContributor = '8ebe5a00-799e-43f5-93ac-243d3dce84a7'

resource search 'Microsoft.Search/searchServices@2024-06-01-preview' = {
  name: name
  location: location
  tags: tags
  sku: { name: sku }
  identity: { type: 'SystemAssigned' }
  properties: {
    replicaCount: 1
    partitionCount: 1
    hostingMode: 'default'
    publicNetworkAccess: 'enabled'
    semanticSearch: semanticSearch
    authOptions: {
      aadOrApiKey: { aadAuthFailureMode: 'http401WithBearerChallenge' }
    }
    disableLocalAuth: false
  }
}

resource cortexServiceContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, cortexPrincipalId, searchServiceContributor)
  scope: search
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', searchServiceContributor)
    principalId: cortexPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource cortexDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, cortexPrincipalId, searchIndexDataContributor)
  scope: search
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', searchIndexDataContributor)
    principalId: cortexPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource foundryServiceContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(foundryPrincipalId)) {
  name: guid(search.id, foundryPrincipalId, searchServiceContributor)
  scope: search
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', searchServiceContributor)
    principalId: foundryPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource foundryDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(foundryPrincipalId)) {
  name: guid(search.id, foundryPrincipalId, searchIndexDataContributor)
  scope: search
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', searchIndexDataContributor)
    principalId: foundryPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output name string = search.name
output id string = search.id
output endpoint string = 'https://${search.name}.search.windows.net'
output principalId string = search.identity.principalId
