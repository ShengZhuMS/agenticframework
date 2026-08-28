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

@description('Key Vault holding endpoints and keys. The app reads it at startup with its managed identity.')
param keyVaultName string

param registryLoginServer string
param identityId string
param identityClientId string

param logAnalyticsCustomerId string
@secure()
param logAnalyticsKey string


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
            // Endpoints and keys come from Key Vault, read at startup with the
            // managed identity. Only the vault name and the switches that decide
            // HOW the app runs are passed as environment variables.
            //
            // The values below are seeded into the vault by the post-provision
            // hook. They are deliberately NOT duplicated here: two sources for
            // one value means one of them is eventually wrong, and the wrong
            // one is always the one nobody remembers to update.
            { name: 'PORT', value: '3000' }
            { name: 'NODE_ENV', value: 'production' }
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'KEYVAULT_NAME', value: keyVaultName }
            // Pinned api-versions are code-level constants, not configuration.
            { name: 'APIM_API_VERSION', value: '2025-09-01-preview' }
            { name: 'PURVIEW_API_VERSION', value: '2026-03-20-preview' }
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
            // This runs as its own container app and reads the vault itself.
            { name: 'PORT', value: '3000' }
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'KEYVAULT_NAME', value: keyVaultName }
            { name: 'PURVIEW_API_VERSION', value: '2026-03-20-preview' }
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
