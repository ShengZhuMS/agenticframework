// Reuse a Log Analytics workspace and Application Insights you already have.
// Creates nothing. The workspace KEY is deliberately not an output: a list*
// value in a module output lands in the deployment history in clear text
// (linter rule outputs-should-not-contain-secrets). containerapps.bicep reads
// the key itself from the workspace named here.
param logAnalyticsName string
param appInsightsName string

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsName
}

resource appi 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

output name string = law.name
output customerId string = law.properties.customerId
output connectionString string = appi.properties.ConnectionString
output workspaceId string = law.id
