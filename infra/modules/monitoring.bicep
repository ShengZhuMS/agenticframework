// Log Analytics + Application Insights. Required for the health and error-rate
// figures on entry pages, and for diagnosing a demo that misbehaves.
param logAnalyticsName string
param appInsightsName string
param location string
param tags object

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: law.id
  }
}

output customerId string = law.properties.customerId
output primarySharedKey string = law.listKeys().primarySharedKey
output connectionString string = appi.properties.ConnectionString
output workspaceId string = law.id
