// Container Apps environment plus the two Cortex apps.
//
// cortex-web has minReplicas 1 deliberately. Scale-to-zero cold start is the
// single most likely thing to embarrass a live demo — a 20-second first page
// load in front of a CTO. The cost of one always-on 0.5 vCPU replica is
// roughly £25/month and it buys the demo.

param environmentName string
param webAppName string
param mcpAppName string
param location string
param tags object

param registryLoginServer string
param identityId string
param identityClientId string

param logAnalyticsCustomerId string
@secure()
param logAnalyticsKey string
param appInsightsConnectionString string

param demoMode bool
param foundryProjectEndpoint string
param foundryModel string
param apimServiceName string
param apimGatewayUrl string
param purviewEndpoint string
param subscriptionId string
param resourceGroupName string
param cosmosEndpoint string

// Placeholder image until `azd deploy` pushes the real one.
var bootstrapImage = 'mcr.microsoft.com/k8se/quickstart:latest'

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsKey
      }
    }
  }
}

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: webAppName
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registryLoginServer
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: bootstrapImage
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            { name: 'PORT', value: '3000' }
            { name: 'NODE_ENV', value: 'production' }
            { name: 'DEMO_MODE', value: string(demoMode) }
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'AZURE_SUBSCRIPTION_ID', value: subscriptionId }
            { name: 'AZURE_RESOURCE_GROUP', value: resourceGroupName }
            { name: 'FOUNDRY_PROJECT_ENDPOINT', value: foundryProjectEndpoint }
            { name: 'FOUNDRY_MODEL', value: foundryModel }
            { name: 'APIM_SERVICE_NAME', value: apimServiceName }
            { name: 'APIM_GATEWAY_URL', value: apimGatewayUrl }
            { name: 'APIM_API_VERSION', value: '2025-09-01-preview' }
            { name: 'PURVIEW_ENDPOINT', value: purviewEndpoint }
            { name: 'PURVIEW_API_VERSION', value: '2026-03-20-preview' }
            { name: 'COSMOS_ENDPOINT', value: cosmosEndpoint }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            // Adapters default to seeded and are switched to live one at a
            // time as each integration is proven. A failing back end then
            // degrades one slice, never the whole page.
            { name: 'ADAPTER_PURVIEW', value: demoMode ? 'seeded' : 'live' }
            { name: 'ADAPTER_APIM', value: demoMode ? 'seeded' : 'live' }
            { name: 'ADAPTER_FOUNDRY', value: demoMode ? 'seeded' : 'live' }
          ]
          probes: [
            {
              type: 'Readiness'
              httpGet: { path: '/api/health', port: 3000 }
              initialDelaySeconds: 3
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        // Never zero. Cold start is the top demo risk.
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
}

// Glue 1 — the Purview MCP server. There is no official Purview MCP server,
// and no Purview tool or knowledge source inside Foundry agents, so this is
// how a Foundry agent reaches the catalogue at all.
resource mcp 'Microsoft.App/containerApps@2024-03-01' = {
  name: mcpAppName
  location: location
  tags: union(tags, { 'azd-service-name': 'purview-mcp' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // Public for the PoC. Production uses private endpoints and a
        // dedicated MCP subnet delegated to Microsoft.App/environments.
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registryLoginServer
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'purview-mcp'
          image: bootstrapImage
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'PORT', value: '3000' }
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'PURVIEW_ENDPOINT', value: purviewEndpoint }
            { name: 'PURVIEW_API_VERSION', value: '2026-03-20-preview' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 2
      }
    }
  }
}

output webUrl string = 'https://${web.properties.configuration.ingress.fqdn}'
output mcpUrl string = 'https://${mcp.properties.configuration.ingress.fqdn}'
output webName string = web.name
output environmentId string = env.id
