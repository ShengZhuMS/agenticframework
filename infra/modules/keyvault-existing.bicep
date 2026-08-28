// Grant Cortex read access to a Key Vault you already have.
//
// Key Vault Secrets User only — read secret values, nothing else. Deliberately
// not Secrets Officer: the application reads, it never writes.
//
// ⚠️ Assumes the vault uses RBAC (enableRbacAuthorization: true). A vault still
// on the legacy access-policy model will ignore this role assignment; the
// deploy script checks and tells you.

param name string
param principalId string

var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: name
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
output rbacEnabled bool = vault.properties.enableRbacAuthorization
