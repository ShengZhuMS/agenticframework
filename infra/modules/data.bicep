// The data behind the data products, and the share that holds application state.
//
// TWO STORAGE ACCOUNTS, ON PURPOSE
//   sample data   ADLS Gen2 (hierarchical namespace). The Purview Data Map
//                 scans an ADLS Gen2 account cleanly — folders and files come
//                 through as adls_gen2_path assets with their schema — where a
//                 flat blob account can ingest folders as blobs and miss the
//                 files underneath. The Unified Catalog also has a native
//                 ADLSGen2Path asset type. AI Search reads it with an adlsgen2
//                 data source.
//   state         a plain account with an Azure Files share, mounted into the
//                 web app (containerapps.bicep). Files and hierarchical
//                 namespace do not mix on one account, hence the second.
//
// Both are cheap (pennies a month at this size) and both are created only
// when asked — an existing deployment keeps working without them, it just has
// no data behind its products and no persistence.
//
// ROLE GRANTS — the whole point of this file
//   Purview account identity   Storage Blob Data Reader   scans the files
//   AI Search identity         Storage Blob Data Reader   indexes the files
//   Cortex identity            Storage Blob Data Contributor   uploads / repairs
//   deployer (you)             Storage Blob Data Contributor   bootstrap uploads
// Data-plane roles: an Owner of the subscription still cannot read a blob
// without one, which is the single most common reason bootstrap says 403.

param location string
param tags object

@description('Name of the ADLS Gen2 account for sample data. 3–24 lower-case letters and digits.')
param dataAccountName string

@description('Name of the account holding the Azure Files share for application state.')
param stateAccountName string

@description('Container for the sample data products.')
param dataContainerName string = 'products'

@description('File share for application state.')
param stateShareName string = 'cortex-state'

@description('Principal id of the Cortex user-assigned identity.')
param cortexPrincipalId string

@description('Principal id of the Purview account\'s system-assigned identity. Empty to skip the grant.')
param purviewPrincipalId string = ''

@description('Principal id of the AI Search service\'s system-assigned identity. Empty to skip the grant.')
param searchPrincipalId string = ''

@description('Object id of the person running the deployment, so bootstrap can upload. Empty to skip.')
param deployerPrincipalId string = ''

var blobDataReader = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var blobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// -------------------------------------------------------------- sample data

resource data 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: dataAccountName
  location: location
  tags: union(tags, { purpose: 'cortex-sample-data' })
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    isHnsEnabled: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    // Keyless everywhere. Bootstrap, the scan, the indexer and the app all use identities.
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Enabled'
    networkAcls: { defaultAction: 'Allow', bypass: 'AzureServices' }
  }
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
//
// Container Apps mounts Azure Files with the account KEY (that is how the
// managedEnvironments/storages resource works today), so shared-key access
// stays on for this one account. It holds JSON files of requests and
// automations — nothing sensitive, and the key never leaves the platform.

resource state 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: stateAccountName
  location: location
  tags: union(tags, { purpose: 'cortex-state' })
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: true
    publicNetworkAccess: 'Enabled'
    networkAcls: { defaultAction: 'Allow', bypass: 'AzureServices' }
  }
}

resource stateFiles 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: state
  name: 'default'
}

resource stateShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: stateFiles
  name: stateShareName
  properties: {
    shareQuota: 5
    enabledProtocols: 'SMB'
  }
}

output dataAccountName string = data.name
output dataAccountId string = data.id
output dataContainerName string = dataContainer.name
output dataBlobEndpoint string = data.properties.primaryEndpoints.blob
output dataDfsEndpoint string = data.properties.primaryEndpoints.dfs
output stateAccountName string = state.name
output stateShareName string = stateShare.name
