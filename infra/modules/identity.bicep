// One user-assigned managed identity, used by both container apps.
// No secrets anywhere: Azure-to-Azure auth is entirely identity-based.
param name string
param location string
param tags object

resource id 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
  tags: tags
}

output id string = id.id
output principalId string = id.properties.principalId
output clientId string = id.properties.clientId
output name string = id.name
