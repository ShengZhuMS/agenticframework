// Seed Key Vault with the values the deployment already knows.
//
// WHY THIS IS SEPARATE FROM keyvault.bicep
// Two of these values are outputs of the container apps module, which itself
// needs the vault name. Splitting creation from seeding breaks that cycle:
// vault -> container apps -> seed.
//
// WHAT IS DELIBERATELY NOT HERE
// The APIM subscription key and the Entra client secret. Neither is known to
// the template, and writing a credential through a deployment would put it in
// the deployment history where it is readable by anyone with reader access on
// the resource group. Those two are onboarded by hand, once. Everything in
// this file is an endpoint, a name or an id — none of it is a credential.
//
// PERMISSION NOTE
// Writing secrets needs "Key Vault Secrets Officer" on the vault for the
// principal running the deployment. Reading them at runtime needs only
// "Key Vault Secrets User", which is what the app identity gets.

param keyVaultName string

@description('Endpoint and identifier values discovered during provisioning.')
param values object

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// Key Vault secret names permit letters, digits and hyphens only — hence
// kebab-case throughout, never the SCREAMING_SNAKE of an environment variable.
resource secrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [
  for item in items(values): if (!empty(item.value)) {
    parent: vault
    name: item.key
    properties: {
      value: item.value
      contentType: 'text/plain'
      attributes: {
        enabled: true
      }
    }
  }
]

output seeded array = [for item in items(values): item.key]
