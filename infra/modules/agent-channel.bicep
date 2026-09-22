@description('Dedicated bot for an assessed Foundry wrapper; never reuse another agent bot.')
param botName string
param agentName string
param displayName string
param agentClientId string
param tenantId string
param activityEndpoint string

resource bot 'Microsoft.BotService/botServices@2022-09-15' = {
  name: botName
  location: 'global'
  kind: 'azurebot'
  sku: { name: 'F0' }
  tags: { 'cortex-agent': agentName }
  properties: {
    displayName: displayName
    msaAppId: agentClientId
    msaAppTenantId: tenantId
    msaAppType: 'SingleTenant'
    endpoint: activityEndpoint
    publicNetworkAccess: 'Disabled'
  }
}
resource teams 'Microsoft.BotService/botServices/channels@2022-09-15' = {
  parent: bot
  name: 'MsTeamsChannel'
  location: 'global'
  properties: {
    channelName: 'MsTeamsChannel'
    properties: { isEnabled: true }
  }
}
output botServiceArmId string = bot.id
