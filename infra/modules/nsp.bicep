// Network Security Perimeter around the Cortex storage accounts (and, in
// learning mode, the AI Search service).
//
// WHY THIS EXISTS
// The tenant applies an SFI policy with a Modify effect to every storage
// account: "Disable public network access on Storage accounts (excluding NSP
// configured resources)", plus "disable local auth". It rewrites any update
// that leaves the public endpoint open, so the sample-data account could not
// be written to and the state share could not be mounted — cortex-web never
// started. The exclusion in the policy's own name is the supported way out: a
// storage account that belongs to a perimeter, with public network access set
// to SecuredByPerimeter, is governed by the perimeter's rules and left alone.
//
// WHAT THE PERIMETER ALLOWS IN
//   subscription rule    Entra-authenticated traffic from any resource with a
//                        managed identity in this subscription: the web app
//                        and the bootstrap job (id-cortex), the AI Search
//                        service (its indexers), the Purview account (the Data
//                        Map scan) and the Foundry account (the search tool).
//   nothing else         Your laptop is outside on purpose. Anything that must
//                        touch the storage accounts runs inside Azure as the
//                        Cortex identity — the bootstrap job in
//                        containerapps.bicep. No account keys, no IP rules.
//
// ACCESS MODES
//   Enforced   the perimeter decides; the resource's own network rules are
//              ignored. Used for the two storage accounts, which is what makes
//              the policy exclusion apply.
//   Learning   the resource keeps its own rules and the perimeter only logs.
//              Used for AI Search this round: nothing changes for the Foundry
//              tool or the portal, and the flow logs show what Enforced would
//              have blocked before anyone commits to it.
//
// API VERSION
// 2024-07-01 is the GA version of Microsoft.Network/networkSecurityPerimeters.
// If ARM rejects it in your region, it appears in exactly four places below.

param name string
param location string
param tags object

@description('Resource id of the sample-data storage account.')
param dataAccountId string

@description('Resource id of the state storage account. Empty to skip.')
param stateAccountId string = ''

@description('Resource id of the AI Search service. Empty to skip.')
param searchServiceId string = ''

@allowed(['Enforced', 'Learning'])
param storageAccessMode string = 'Enforced'

@allowed(['Enforced', 'Learning'])
param searchAccessMode string = 'Learning'

resource nsp 'Microsoft.Network/networkSecurityPerimeters@2024-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {}
}

resource profile 'Microsoft.Network/networkSecurityPerimeters/profiles@2024-07-01' = {
  parent: nsp
  name: 'cortex'
  location: location
  properties: {}
}

// Managed identities from this subscription. This is the single rule the whole
// data chain relies on; every caller of the storage accounts holds an Entra
// token for an identity that lives here.
resource allowSubscription 'Microsoft.Network/networkSecurityPerimeters/profiles/accessRules@2024-07-01' = {
  parent: profile
  name: 'allow-subscription-identities'
  location: location
  properties: {
    direction: 'Inbound'
    subscriptions: [
      { id: subscription().id }
    ]
  }
}

resource dataAssociation 'Microsoft.Network/networkSecurityPerimeters/resourceAssociations@2024-07-01' = {
  parent: nsp
  name: 'data-storage'
  location: location
  properties: {
    privateLinkResource: { id: dataAccountId }
    profile: { id: profile.id }
    accessMode: storageAccessMode
  }
  dependsOn: [ allowSubscription ]
}

resource stateAssociation 'Microsoft.Network/networkSecurityPerimeters/resourceAssociations@2024-07-01' = if (!empty(stateAccountId)) {
  parent: nsp
  name: 'state-storage'
  location: location
  properties: {
    privateLinkResource: { id: stateAccountId }
    profile: { id: profile.id }
    accessMode: storageAccessMode
  }
  dependsOn: [ allowSubscription ]
}

resource searchAssociation 'Microsoft.Network/networkSecurityPerimeters/resourceAssociations@2024-07-01' = if (!empty(searchServiceId)) {
  parent: nsp
  name: 'search'
  location: location
  properties: {
    privateLinkResource: { id: searchServiceId }
    profile: { id: profile.id }
    accessMode: searchAccessMode
  }
  dependsOn: [ allowSubscription ]
}

output id string = nsp.id
output name string = nsp.name
output profileId string = profile.id
