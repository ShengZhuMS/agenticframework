// Reuse a Log Analytics workspace and Application Insights you already have.
// Reads their keys so the container apps can send logs. Creates nothing.
param logAnalyticsName string
param appInsightsName string

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsName
}

resource appi 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

output customerId string = law.properties.customerId
output primarySharedKey string = law.listKeys().primarySharedKey
output connectionString string = appi.properties.ConnectionString
