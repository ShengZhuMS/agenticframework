// Cosmos DB, serverless — the Cortex Index.
// Serverless keeps idle cost near zero between demo rehearsals.
param name string
param location string
param tags object
param principalId string

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: name
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [ { name: 'EnableServerless' } ]
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [ { locationName: location, failoverPriority: 0 } ]
    disableLocalAuth: true
  }
}

resource db 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: account
  name: 'cortex'
  properties: { resource: { id: 'cortex' } }
}

resource entries 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: db
  name: 'entries'
  properties: {
    resource: {
      id: 'entries'
      partitionKey: { paths: [ '/cluster' ], kind: 'Hash' }
    }
  }
}

resource requests 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: db
  name: 'accessRequests'
  properties: {
    resource: {
      id: 'accessRequests'
      partitionKey: { paths: [ '/entryId' ], kind: 'Hash' }
    }
  }
}

// Cosmos data-plane RBAC: Built-in Data Contributor.
resource dataContributor 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: account
  name: guid(account.id, principalId, 'data-contributor')
  properties: {
    roleDefinitionId: '${account.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    principalId: principalId
    scope: account.id
  }
}

output endpoint string = account.properties.documentEndpoint
output name string = account.name
