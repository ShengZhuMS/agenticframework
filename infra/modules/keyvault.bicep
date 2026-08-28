// Azure Key Vault — the source of truth for Cortex endpoints and keys.
//
// RBAC, not access policies. Access policies are the legacy model and cannot
// be managed with standard Azure role assignments; enableRbacAuthorization
// puts the vault under the same RBAC as everything else.
//
// NOTE: this module creates the vault and grants the app identity read access.
// It deliberately does NOT create the secrets. Endpoint values are only known
// after APIM, Foundry and the container apps exist, and the APIM subscription
// key must never be written into a template that lands in source control.
// Onboarding the values is a documented post-provision step.

param name string
param location string
param tags object

@description('Principal id of the app identity that reads secrets.')
param principalId string

@description('Soft-delete retention. 7 is the minimum and is right for a PoC that gets torn down.')
@minValue(7)
@maxValue(90)
param softDeleteRetentionInDays int = 7

@description('Purge protection blocks permanent deletion for the retention period. Leave false for a sandbox that will be destroyed and recreated.')
param enablePurgeProtection bool = false

// Key Vault Secrets User — read secret values, nothing else.
// Deliberately not Secrets Officer: the app reads, it never writes.
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    enablePurgeProtection: enablePurgeProtection ? true : null
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, principalId, keyVaultSecretsUser)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output name string = vault.name
output uri string = vault.properties.vaultUri
output id string = vault.id
