// The data behind the data products, and the account that holds application state.
//
// TWO STORAGE ACCOUNTS, ON PURPOSE
//   sample data   ADLS Gen2 (hierarchical namespace). The Purview Data Map
//                 scans an ADLS Gen2 account cleanly — folders and files come
//                 through as adls_gen2_path assets with their schema — where a
//                 flat blob account can ingest folders as blobs and miss the
//                 files underneath. The Unified Catalog also has a native
//                 ADLSGen2Path asset type. AI Search reads it with an adlsgen2
//                 data source.
//   state         a plain blob account holding one JSON blob per collection
//                 (requests, chats, automations, agent records), read and
//                 written by the web app with its managed identity. It used to
//                 be an Azure Files share mounted into the app with the
//                 account key — see NO KEYS below for why that could never
//                 work in this tenant. Kept separate so the Data Map scan of
//                 the sample data never sees application state.
//
// NO KEYS, ANYWHERE
// The tenant's SFI policy disables shared-key access on every storage account
// and closes the public endpoint unless the account is inside a Network
// Security Perimeter. So both accounts are keyless (allowSharedKeyAccess
// false), every caller uses an Entra token, and both are associated with the
// perimeter in nsp.bicep. publicNetworkAccess is a parameter: 'Enabled' on the
// very first run (the association does not exist until after the account
// does), 'SecuredByPerimeter' from then on — the deploy script flips it once
// the association is in place and records the choice in the azd environment.
//
// ROLE GRANTS — the whole point of this file
//   Purview account identity   Storage Blob Data Reader        scans the files
//   AI Search identity         Storage Blob Data Reader        indexes the files
//   Cortex identity            Storage Blob Data Contributor   the web app reads,
//                                                              the bootstrap job writes
//   deployer (you)             Storage Blob Data Contributor   kept for a laptop
//                                                              inside the perimeter;
//                                                              harmless otherwise
// Data-plane roles: an Owner of the subscription still cannot read a blob
// without one.

param location string
param tags object

@description('Name of the ADLS Gen2 account for sample data. 3–24 lower-case letters and digits.')
param dataAccountName string

@description('Name of the blob account holding application state.')
param stateAccountName string

@description('Container for the sample data products.')
param dataContainerName string = 'products'

@description('Container for application state (one JSON blob per collection).')
param stateContainerName string = 'state'

@description('Public network access on both accounts. Enabled on a first run; SecuredByPerimeter once the perimeter association exists.')
@allowed(['Enabled', 'SecuredByPerimeter', 'Disabled'])
param publicNetworkAccess string = 'Enabled'

@description('Principal id of the Cortex user-assigned identity.')
param cortexPrincipalId string

@description('Principal id of the Purview account\'s system-assigned identity. Empty to skip the grant.')
param purviewPrincipalId string = ''

@description('Principal id of the AI Search service\'s system-assigned identity. Empty to skip the grant.')
param searchPrincipalId string = ''

@description('Object id of the person running the deployment. Empty to skip.')
param deployerPrincipalId string = ''

var blobDataReader = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var blobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// Shared by both accounts. Keyless everywhere; the perimeter decides who is
// let in once the account is SecuredByPerimeter, and the bypass keeps the
// trusted Azure services (the Data Map scan, the indexers) working while it
// is still Enabled on the first run.
var networkProperties = {
  minimumTlsVersion: 'TLS1_2'
  allowBlobPublicAccess: false
  supportsHttpsTrafficOnly: true
  allowSharedKeyAccess: false
  publicNetworkAccess: publicNetworkAccess
  networkAcls: { defaultAction: 'Allow', bypass: 'AzureServices' }
}

// -------------------------------------------------------------- sample data

resource data 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: dataAccountName
  location: location
  tags: union(tags, { purpose: 'cortex-sample-data' })
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: union(networkProperties, { isHnsEnabled: true })
}

resource dataBlob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: data
  name: 'default'
}

resource dataContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: dataBlob
  name: dataContainerName
  properties: { publicAccess: 'None' }
}

resource cortexWrites 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(data.id, cortexPrincipalId, blobDataContributor)
  scope: data
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributor)
    principalId: cortexPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource purviewReads 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(purviewPrincipalId)) {
  name: guid(data.id, purviewPrincipalId, blobDataReader)
  scope: data
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataReader)
    principalId: purviewPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource searchReads 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(searchPrincipalId)) {
  name: guid(data.id, searchPrincipalId, blobDataReader)
  scope: data
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataReader)
    principalId: searchPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// principalType is deliberately omitted for the deployer: a person, or a
// service principal in a pipeline, and ARM works either out for itself.
resource deployerWrites 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployerPrincipalId)) {
  name: guid(data.id, deployerPrincipalId, blobDataContributor)
  scope: data
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributor)
    principalId: deployerPrincipalId
  }
}

// -------------------------------------------------------------------- state

resource state 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: stateAccountName
  location: location
  tags: union(tags, { purpose: 'cortex-state' })
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: networkProperties
}

resource stateBlob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: state
  name: 'default'
}

resource stateContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: stateBlob
  name: stateContainerName
  properties: { publicAccess: 'None' }
}

resource cortexWritesState 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(state.id, cortexPrincipalId, blobDataContributor)
  scope: state
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributor)
    principalId: cortexPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output dataAccountName string = data.name
output dataAccountId string = data.id
output dataContainerName string = dataContainer.name
output dataBlobEndpoint string = data.properties.primaryEndpoints.blob
output dataDfsEndpoint string = data.properties.primaryEndpoints.dfs
output stateAccountName string = state.name
output stateAccountId string = state.id
output stateContainerName string = stateContainer.name
