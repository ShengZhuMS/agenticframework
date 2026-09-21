// =============================================================================
// Cortex — infrastructure.
//
// REUSES YOUR EXISTING ESTATE BY DEFAULT.
// Every resource name and resource group is a parameter, defaulted to the
// resources already in subscription ME-MngEnvMCAP181916-Core. Where a resource
// exists, Cortex is granted access to it. Where it does not, Cortex creates it.
//
// The create* flags are set for you by scripts/Deploy-Cortex.ps1, which probes
// each resource with `az resource show` before deploying. Set them by hand only
// if you are running `azd`/`az deployment` directly.
//
// WHAT IS ALWAYS CREATED
//   - a user-assigned managed identity (Cortex needs its own, not Databricks')
//   - the Container Apps environment and the two Cortex apps
// Nothing else. Everything else is reused if you have it.
//
// RE-RUNNING THIS TEMPLATE
// Every resource here is addressed by a fixed name and every role assignment
// by a deterministic guid(), so a second deployment with the same inputs is a
// no-op rather than a conflict. The two things that were NOT safe to re-run
// have been fixed: container images are no longer reset to the placeholder on
// every provision (see modules/containerapps.bicep), and the azd-env-name tag
// now follows environmentName instead of being hardcoded, so two environments
// can no longer claim each other's resources.
// =============================================================================

targetScope = 'subscription'

// ----------------------------------------------------------------- general

@minLength(2)
@maxLength(20)
@description('Environment name. Used to name the resources Cortex creates.')
param environmentName string = 'cortex'

@description('Region for resources Cortex creates. Defaults to North Europe, where most of your estate lives.')
param location string = 'northeurope'

@description('Resource group for the resources Cortex creates (container apps, identity). Created if absent.')
param cortexResourceGroup string = 'PRDCORECORTEX001'

// A resource group's location is immutable. Re-running with a different
// -Location against a group that already exists is rejected by ARM, and the
// message does not mention the resource group. Deploy-Cortex.ps1 reads the
// live group's location and passes it here so the group is left alone while
// new resources still land in `location`.
@description('Location of the Cortex resource group. Set by the deploy script to the existing group\'s location. Leave empty to use `location`.')
param cortexResourceGroupLocation string = ''

@description('Tags applied to everything Cortex creates. azd-env-name must track environmentName or azd cannot find its own resources.')
param tags object = {
  'azd-env-name': environmentName
  project: 'cortex'
  purpose: 'poc'
}

var effectiveRgLocation = empty(cortexResourceGroupLocation) ? location : cortexResourceGroupLocation

// ------------------------------------------------------------ API Management

@description('Existing API Management instance. Leave as-is to reuse yours.')
param apimName string = 'prdcoreapimneu001'
param apimResourceGroup string = 'PRDCOREAPIM001'

@description('Create API Management instead of reusing it. MCP servers need Developer, Basic, Standard, Premium or a v2 tier — never Consumption.')
param createApim bool = false

@allowed(['Developer', 'BasicV2', 'StandardV2'])
param apimSku string = 'Developer'
param apimPublisherEmail string = ''
param apimPublisherName string = 'Defra Cortex'

@description('APIM product that published MCP servers are bound to. Created if absent.')
param apimProductId string = 'cortex'

// -------------------------------------------------------------------- Purview

@description('Existing Microsoft Purview account. Leave as-is to reuse yours.')
param purviewName string = 'prdcorepurvieweus'
param purviewResourceGroup string = 'PRDCOREPVW001'
param createPurview bool = false

// -------------------------------------------------------------------- Foundry

@description('Existing Microsoft Foundry account (the new account+project model, not a hub).')
param foundryAccountName string = 'prdcorefdryeus001'
param foundryProjectName string = 'prdcorefdryproj-default'
param foundryResourceGroup string = 'PRDCOREFDRY001'
param createFoundry bool = false

// WHY THE MODEL AND ITS VERSION ARE BOTH PARAMETERS
// gpt-4o-mini 2024-07-18 is Deprecated: existing deployments keep serving,
// new ones are refused. The template never named a version, so ARM resolved
// the account default — which had moved to that deprecated build — and the
// whole subscription deployment failed with ServiceModelDeprecating. Naming
// the version makes the failure impossible to reach by accident, and makes
// the next migration a one-line change instead of a diagnosis.
@description('Model to deploy. Deploy-Cortex.ps1 verifies this is offered by the account and is not deprecated before provisioning.')
param modelName string = 'gpt-5.4-mini'

@description('Model version, pinned. Never leave this empty.')
param modelVersion string = '2026-03-17'

@description('Deployment name the application asks for at inference time. Defaults to the model name.')
param modelDeploymentName string = ''

@allowed(['GlobalStandard', 'Standard', 'DataZoneStandard'])
param modelSkuName string = 'GlobalStandard'

param modelCapacity int = 30

@allowed(['OnceCurrentVersionExpired', 'OnceNewDefaultVersionAvailable', 'NoAutoUpgrade'])
param modelVersionUpgradeOption string = 'OnceCurrentVersionExpired'

@description('Deploy the model. Leave false when reusing an account that already has one.')
param createModelDeployment bool = false

// ------------------------------------------------------------------ Key Vault

@description('Existing Key Vault for Cortex endpoints and keys.')
param keyVaultName string = 'prdcorekveus'
param keyVaultResourceGroup string = 'PRDCOREPVW001'
param createKeyVault bool = false

@description('Write the endpoints provisioning knows into Key Vault. Needs Key Vault Secrets Officer for whoever deploys. Deploy-Cortex.ps1 turns this off automatically rather than failing the deployment when you lack the role.')
param seedKeyVault bool = true

// WHY THIS EXISTS — the data plane / control plane split.
//
// Key Vault firewall rules apply to the DATA plane only. A vault with
// `publicNetworkAccess: Disabled` still accepts the secrets written by this
// template, because an ARM deployment is a control-plane operation and the ARM
// deployment service is on the Key Vault trusted-services list. What it refuses
// is being READ over the public internet — and Azure Container Apps is NOT a
// trusted service, so the running app cannot reach it without a private
// endpoint.
//
// The result is a vault that seeds perfectly and is useless at runtime: the app
// starts, every secret read fails, it falls back to environment variables, and
// the marketplace is empty. Setting useKeyVault false passes configuration to
// the apps directly instead. See modules/containerapps.bicep for the security
// trade this makes, and docs/DEPLOY.md §5 for the route back to a vault.
@description('Read configuration from Key Vault at runtime. Set false when the vault is unreachable from the container apps. Deploy-Cortex.ps1 detects this and sets it for you.')
param useKeyVault bool = true

@description('Entra group id to name mapping, e.g. "<guid>=all-staff,<guid>=waste-crime". Passed to the app so it survives a re-provision.')
param groupNames string = ''

@description('Groups granted to every signed-in user on top of Entra. Default all-staff; empty string for strict mode.')
param defaultGroups string = 'all-staff'

@description('Entra app registration client id for sign-in. Optional.')
param entraClientId string = ''

// ----------------------------------------------------------- Container registry

@description('Existing container registry for the Cortex images.')
param registryName string = 'prdcoreamlacr001'
param registryResourceGroup string = 'PRDCOREAML001'
param createRegistry bool = false

// --------------------------------------------------------------- Monitoring

@description('Existing Log Analytics workspace and Application Insights.')
param logAnalyticsName string = 'prdcoreamlneu03094960047'
param appInsightsName string = 'prdcoreamlneu08774392429'
param monitoringResourceGroup string = 'PRDCOREAML001'
param createMonitoring bool = false

// ----------------------------------------------------------- container images

// Fed back in by azd after each successful deploy. Empty only on a first run.
// This is what stops a re-provision rolling the apps back to the placeholder.
@description('Current image for cortex-web. azd supplies SERVICE_WEB_IMAGE_NAME.')
param webImageName string = ''

@description('Current image for cortex-purview-mcp. azd supplies SERVICE_PURVIEW_MCP_IMAGE_NAME.')
param mcpImageName string = ''

@description('Minimum replicas for the MCP server. 1 avoids a cold start on the first agent call mid-demo.')
param mcpMinReplicas int = 1

@description('Maximum replicas for cortex-web. Keep at 1: application state is a JSON store on one Azure Files share, written by one replica.')
param webMaxReplicas int = 1

// ------------------------------------------------- data, search and state
//
// New in round 4. All three are created in the Cortex resource group and are
// independent of the shared services above, so an existing deployment can
// take them on with a re-provision and lose nothing.

@description('Create the sample-data storage account (ADLS Gen2) and the state share. False keeps a deployment without data behind its products.')
param createData bool = true

@description('Create an Azure AI Search service for the per-product indexes. False disables data grounding; agents describe products but cannot read rows.')
param createSearch bool = true

@description('AI Search tier. basic holds 15 indexes — enough for the 14 sample products. standard for more.')
@allowed(['free', 'basic', 'standard'])
param searchSku string = 'basic'

@description('Semantic ranker plan on the search service. disabled removes a regional failure mode; the agent tool uses keyword search by default anyway.')
@allowed(['disabled', 'free', 'standard'])
param searchSemantic string = 'disabled'

@description('Object id of the person (or pipeline identity) deploying, so bootstrap can upload the sample files. Deploy-Cortex.ps1 fills it in.')
param deployerPrincipalId string = ''

// ------------------------------------------------ round 6: the perimeter
//
// The tenant's SFI policy closes the public endpoint on every storage account
// "excluding NSP configured resources". So the two Cortex accounts live inside
// a Network Security Perimeter (modules/nsp.bicep) that admits managed
// identities from this subscription, and their public network access is set
// to SecuredByPerimeter — the value the policy leaves alone.
//
// storagePublicNetworkAccess starts as Enabled because the perimeter
// association cannot exist before the account does. Deploy-Cortex.ps1 flips
// it to SecuredByPerimeter once the association is in place and records that
// in the azd environment (STORAGE_PUBLIC_NETWORK_ACCESS), so every later
// provision writes the right value directly.
@description('Create the Network Security Perimeter around the storage accounts (and the search service). False leaves the accounts on their own network rules.')
param createPerimeter bool = true

@description('Access mode for the storage accounts in the perimeter. Enforced is what the policy exclusion needs.')
@allowed(['Enforced', 'Learning'])
param storageAccessMode string = 'Enforced'

@description('Access mode for the AI Search service in the perimeter. Learning changes nothing and logs what Enforced would block.')
@allowed(['Enforced', 'Learning'])
param searchAccessMode string = 'Learning'

@description('Public network access on the storage accounts. Enabled on the first run; SecuredByPerimeter once associated. The deploy script manages this.')
@allowed(['Enabled', 'SecuredByPerimeter', 'Disabled'])
param storagePublicNetworkAccess string = 'Enabled'

@description('Who may open a chat window with an agent: all-staff (this phase) or visibility (Marketplace rules).')
@allowed(['all-staff', 'visibility'])
param chatPolicy string = 'all-staff'
@description('Approved external connector metadata. Credentials belong in secret references, never this JSON.')
param connectorConfiguration string = '[]'
@secure()
param fabricConnectorSecret string = ''
@secure()
param studioConnectorSecret string = ''

// ------------------------------------------------------------------ derived

var prefix = toLower(replace(environmentName, '_', '-'))
var uniq = substring(uniqueString(subscription().id, environmentName), 0, 6)

var effectiveApimRg = createApim ? cortexResourceGroup : apimResourceGroup
var effectivePurviewRg = createPurview ? cortexResourceGroup : purviewResourceGroup
var effectiveFoundryRg = createFoundry ? cortexResourceGroup : foundryResourceGroup
var effectiveKeyVaultRg = createKeyVault ? cortexResourceGroup : keyVaultResourceGroup
var effectiveRegistryRg = createRegistry ? cortexResourceGroup : registryResourceGroup
var effectiveMonitoringRg = createMonitoring ? cortexResourceGroup : monitoringResourceGroup

var effectiveApimName = createApim ? 'apim-${prefix}-${uniq}' : apimName
var effectivePurviewName = createPurview ? 'pview-${prefix}-${uniq}' : purviewName
var effectiveFoundryAccount = createFoundry ? 'aif-${prefix}-${uniq}' : foundryAccountName
var effectiveFoundryProject = createFoundry ? 'cortex' : foundryProjectName
var effectiveKeyVaultName = createKeyVault ? take('kv${replace(prefix, '-', '')}${uniq}', 24) : keyVaultName
var effectiveRegistryName = createRegistry ? 'cr${replace(prefix, '-', '')}${uniq}' : registryName

var effectiveModelDeployment = empty(modelDeploymentName) ? modelName : modelDeploymentName

// Storage account names: 3–24 lower-case letters and digits, globally unique.
var dataAccountName = take('st${replace(prefix, '-', '')}data${uniq}', 24)
var stateAccountName = take('st${replace(prefix, '-', '')}state${uniq}', 24)
var searchServiceName = 'srch-${prefix}-${uniq}'
var searchEndpoint = createSearch ? 'https://${searchServiceName}.search.windows.net' : ''
var perimeterName = 'nsp-${prefix}'

// ------------------------------------------------------- resource group

resource cortexRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: cortexResourceGroup
  location: effectiveRgLocation
  tags: tags
}

// ------------------------------------------------------------- identity
// Always created. Cortex needs an identity of its own — reusing one that
// belongs to another workload would make its permissions impossible to reason
// about, and impossible to revoke without collateral damage.

module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: cortexRg
  params: {
    name: 'id-${prefix}'
    location: location
    tags: tags
  }
}

// ----------------------------------------------------------- monitoring

module monitoringNew 'modules/monitoring.bicep' = if (createMonitoring) {
  name: 'monitoring-new'
  scope: cortexRg
  params: {
    logAnalyticsName: 'log-${prefix}'
    appInsightsName: 'appi-${prefix}'
    location: location
    tags: tags
  }
}

module monitoringExisting 'modules/monitoring-existing.bicep' = if (!createMonitoring) {
  name: 'monitoring-existing'
  scope: resourceGroup(effectiveMonitoringRg)
  params: {
    logAnalyticsName: logAnalyticsName
    appInsightsName: appInsightsName
  }
}

// ------------------------------------------------------------- registry

module registryNew 'modules/registry.bicep' = if (createRegistry) {
  name: 'registry-new'
  scope: cortexRg
  params: {
    name: effectiveRegistryName
    location: location
    tags: tags
    principalId: identity.outputs.principalId
  }
}

module registryExisting 'modules/registry-existing.bicep' = if (!createRegistry) {
  name: 'registry-existing'
  scope: resourceGroup(effectiveRegistryRg)
  params: {
    name: registryName
    principalId: identity.outputs.principalId
  }
}

// --------------------------------------------------------- API Management

module apimNew 'modules/apim.bicep' = if (createApim) {
  name: 'apim-new'
  scope: cortexRg
  params: {
    name: effectiveApimName
    location: location
    tags: tags
    sku: apimSku
    publisherEmail: apimPublisherEmail
    publisherName: apimPublisherName
    productId: apimProductId
    principalId: identity.outputs.principalId
  }
}

module apimExisting 'modules/apim-existing.bicep' = if (!createApim) {
  name: 'apim-existing'
  scope: resourceGroup(effectiveApimRg)
  params: {
    name: apimName
    productId: apimProductId
    principalId: identity.outputs.principalId
  }
}

// ---------------------------------------------------------------- Purview
// Bicep grants the control-plane half: Reader on the account for the Cortex
// identity. The Unified Catalog roles the app actually needs (Data Governance
// Administrator, Global Catalog Reader, Governance Domain Owner) are
// Purview-internal and are granted by `npm run bootstrap` through the Unified
// Catalog Policies API — see scripts/purview-access.js. Deploy-Cortex.ps1
// runs that for you; it is no longer a portal step.

module purviewNew 'modules/purview.bicep' = if (createPurview) {
  name: 'purview-new'
  scope: cortexRg
  params: {
    name: effectivePurviewName
    location: location
    tags: tags
    principalId: identity.outputs.principalId
  }
}

module purviewExisting 'modules/purview-existing.bicep' = if (!createPurview) {
  name: 'purview-existing'
  scope: resourceGroup(effectivePurviewRg)
  params: {
    name: purviewName
    principalId: identity.outputs.principalId
  }
}

// ---------------------------------------------------------------- Foundry

module foundryNew 'modules/foundry.bicep' = if (createFoundry) {
  name: 'foundry-new'
  scope: cortexRg
  params: {
    accountName: effectiveFoundryAccount
    projectName: effectiveFoundryProject
    location: location
    tags: tags
    modelName: modelName
    modelVersion: modelVersion
    modelDeploymentName: effectiveModelDeployment
    modelSkuName: modelSkuName
    modelCapacity: modelCapacity
    modelVersionUpgradeOption: modelVersionUpgradeOption
    deployModel: true
    principalId: identity.outputs.principalId
  }
}

module foundryExisting 'modules/foundry-existing.bicep' = if (!createFoundry) {
  name: 'foundry-existing'
  scope: resourceGroup(effectiveFoundryRg)
  params: {
    accountName: foundryAccountName
    projectName: foundryProjectName
    modelName: modelName
    modelVersion: modelVersion
    modelDeploymentName: effectiveModelDeployment
    modelSkuName: modelSkuName
    modelCapacity: modelCapacity
    modelVersionUpgradeOption: modelVersionUpgradeOption
    deployModel: createModelDeployment
    principalId: identity.outputs.principalId
  }
}

// -------------------------------------------------------------- Key Vault

module keyVaultNew 'modules/keyvault.bicep' = if (createKeyVault) {
  name: 'keyvault-new'
  scope: cortexRg
  params: {
    name: effectiveKeyVaultName
    location: location
    tags: tags
    principalId: identity.outputs.principalId
  }
}

module keyVaultExisting 'modules/keyvault-existing.bicep' = if (!createKeyVault) {
  name: 'keyvault-existing'
  scope: resourceGroup(effectiveKeyVaultRg)
  params: {
    name: keyVaultName
    principalId: identity.outputs.principalId
  }
}

// -------------------------------------------------- data, search and state
//
// Ordering: search first (its identity needs blob access), then data (grants
// the Purview, search and Cortex identities on the new account).

module search 'modules/search.bicep' = if (createSearch) {
  name: 'search'
  scope: cortexRg
  params: {
    name: searchServiceName
    location: location
    tags: tags
    sku: searchSku
    semanticSearch: searchSemantic
    cortexPrincipalId: identity.outputs.principalId
    foundryPrincipalId: createFoundry ? foundryNew!.outputs.accountPrincipalId : foundryExisting!.outputs.accountPrincipalId
  }
}

module data 'modules/data.bicep' = if (createData) {
  name: 'data'
  scope: cortexRg
  params: {
    location: location
    tags: tags
    dataAccountName: dataAccountName
    stateAccountName: stateAccountName
    publicNetworkAccess: storagePublicNetworkAccess
    cortexPrincipalId: identity.outputs.principalId
    purviewPrincipalId: createPurview ? purviewNew!.outputs.principalId : purviewExisting!.outputs.principalId
    searchPrincipalId: createSearch ? search!.outputs.principalId : ''
    deployerPrincipalId: deployerPrincipalId
  }
}

// ------------------------------------------------------------- perimeter
// After the accounts (it associates them) and after search (optional member).
module perimeter 'modules/nsp.bicep' = if (createData && createPerimeter) {
  name: 'perimeter'
  scope: cortexRg
  params: {
    name: perimeterName
    location: location
    tags: tags
    dataAccountId: data!.outputs.dataAccountId
    stateAccountId: data!.outputs.stateAccountId
    searchServiceId: createSearch ? search!.outputs.id : ''
    storageAccessMode: storageAccessMode
    searchAccessMode: searchAccessMode
  }
}

// --------------------------------------------------------- container apps
// Always created. This is the front door and it does not exist yet.

module containerApps 'modules/containerapps.bicep' = {
  name: 'containerapps'
  scope: cortexRg
  params: {
    environmentName: 'cae-${prefix}'
    webAppName: 'cortex-web'
    mcpAppName: 'cortex-purview-mcp'
    location: location
    tags: tags
    keyVaultName: effectiveKeyVaultName
    registryLoginServer: createRegistry ? registryNew!.outputs.loginServer : registryExisting!.outputs.loginServer
    identityId: identity.outputs.id
    identityClientId: identity.outputs.clientId
    // Name and resource group only. The module reads the workspace key itself,
    // so the key never travels through a module output into the deployment
    // history. Referencing the module output (rather than the parameter) is
    // also what orders container apps after the workspace when it is new.
    logAnalyticsName: createMonitoring ? monitoringNew!.outputs.name : monitoringExisting!.outputs.name
    logAnalyticsResourceGroup: effectiveMonitoringRg
    webImageName: webImageName
    mcpImageName: mcpImageName
    mcpMinReplicas: mcpMinReplicas
    webMaxReplicas: webMaxReplicas

    // Direct configuration. Ignored when useKeyVault is true, so the same
    // values are computed once here and the mode decides which path uses them.
    useKeyVault: useKeyVault
    azureSubscriptionId: subscription().subscriptionId
    azureResourceGroup: effectiveApimRg
    apimServiceName: effectiveApimName
    apimGatewayUrl: 'https://${effectiveApimName}.azure-api.net'
    foundryProjectEndpoint: 'https://${effectiveFoundryAccount}.services.ai.azure.com/api/projects/${effectiveFoundryProject}'
    foundryModel: effectiveModelDeployment
    purviewEndpoint: 'https://api.purview-service.microsoft.com'
    entraTenantId: subscription().tenantId
    entraClientId: entraClientId
    groupNames: groupNames
    defaultGroups: defaultGroups
    chatPolicy: chatPolicy
    connectorConfiguration: connectorConfiguration
    fabricConnectorSecret: fabricConnectorSecret
    studioConnectorSecret: studioConnectorSecret

    // Round 4: where the Foundry project lives in ARM (for project
    // connections), the search service, the sample-data account and the
    // state share. Empty values switch the feature off in the app.
    foundryAccountName: effectiveFoundryAccount
    foundryProjectName: effectiveFoundryProject
    foundryResourceGroup: effectiveFoundryRg
    purviewAccountName: effectivePurviewName
    searchEndpoint: searchEndpoint
    searchServiceName: createSearch ? searchServiceName : ''
    dataStorageAccount: createData ? data!.outputs.dataAccountName : ''
    dataContainer: createData ? data!.outputs.dataContainerName : 'products'
    dataResourceGroup: cortexResourceGroup
    stateAccountName: createData ? data!.outputs.stateAccountName : ''
    stateContainerName: createData ? data!.outputs.stateContainerName : 'state'
    identityPrincipalId: identity.outputs.principalId

    // The APIM subscription key and the App Insights connection string are
    // deliberately NOT passed. Deploy-Cortex.ps1 writes them onto the app after
    // provisioning, so neither credential is written into the azd environment
    // file on disk or left readable in the deployment history.
  }
}

// ------------------------------------------------------- Key Vault secrets
// Seeded after container apps because two of the values are its outputs.
// The APIM subscription key and any Entra client secret are NOT here: they are
// not known to the template, and a credential written through a deployment
// stays readable in the deployment history afterwards.
//
// cortex-environment-name is a marker, not configuration. Several azd
// environments can point at one shared vault, in which case the last one
// provisioned silently owns every value in it. Deploy-Cortex.ps1 reads this
// before provisioning and warns when it is about to take the vault over.

module keyVaultSecrets 'modules/keyvault-secrets.bicep' = if (seedKeyVault) {
  name: 'keyvault-secrets'
  scope: resourceGroup(effectiveKeyVaultRg)
  params: {
    keyVaultName: effectiveKeyVaultName
    values: {
      'azure-subscription-id': subscription().subscriptionId
      'azure-resource-group': effectiveApimRg
      'apim-service-name': effectiveApimName
      'apim-gateway-url': 'https://${effectiveApimName}.azure-api.net'
      'foundry-project-endpoint': 'https://${effectiveFoundryAccount}.services.ai.azure.com/api/projects/${effectiveFoundryProject}'
      'foundry-model': effectiveModelDeployment
      'purview-endpoint': 'https://api.purview-service.microsoft.com'
      'purview-mcp-url': '${containerApps.outputs.mcpUrl}/mcp'
      'public-base-url': containerApps.outputs.webUrl
      'appinsights-connection-string': createMonitoring ? monitoringNew!.outputs.connectionString : monitoringExisting!.outputs.connectionString
      'entra-tenant-id': subscription().tenantId
      'cortex-environment-name': environmentName
    }
  }
}

// ---------------------------------------------------------------- outputs

output AZURE_RESOURCE_GROUP string = cortexResourceGroup
output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP_LOCATION string = effectiveRgLocation
output CORTEX_WEB_URL string = containerApps.outputs.webUrl
output CORTEX_MCP_URL string = containerApps.outputs.mcpUrl
output CORTEX_WEB_APP_NAME string = containerApps.outputs.webName
output CORTEX_MCP_APP_NAME string = containerApps.outputs.mcpName
output CORTEX_CONTAINER_ENVIRONMENT string = containerApps.outputs.environmentName
output CORTEX_IDENTITY_PRINCIPAL_ID string = identity.outputs.principalId
output CORTEX_IDENTITY_CLIENT_ID string = identity.outputs.clientId

output KEYVAULT_NAME string = effectiveKeyVaultName
output KEYVAULT_RESOURCE_GROUP string = effectiveKeyVaultRg
output KEYVAULT_SEEDED bool = seedKeyVault
output CORTEX_CONFIG_SOURCE string = containerApps.outputs.configSource
output APIM_SERVICE_NAME string = effectiveApimName
output APIM_RESOURCE_GROUP string = effectiveApimRg
output APIM_GATEWAY_URL string = 'https://${effectiveApimName}.azure-api.net'
output PURVIEW_ACCOUNT_NAME string = effectivePurviewName
output PURVIEW_RESOURCE_GROUP string = effectivePurviewRg
output FOUNDRY_ACCOUNT_NAME string = effectiveFoundryAccount
output FOUNDRY_PROJECT_ENDPOINT string = 'https://${effectiveFoundryAccount}.services.ai.azure.com/api/projects/${effectiveFoundryProject}'
output FOUNDRY_MODEL_NAME string = modelName
output FOUNDRY_MODEL_VERSION string = modelVersion
output FOUNDRY_MODEL_DEPLOYMENT string = effectiveModelDeployment
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = createRegistry ? registryNew!.outputs.loginServer : registryExisting!.outputs.loginServer

// Round 4 — read by Set-CortexEnv.ps1 so bootstrap can reach the same places the app does.
output FOUNDRY_ACCOUNT_RESOURCE_GROUP string = effectiveFoundryRg
output FOUNDRY_PROJECT_NAME string = effectiveFoundryProject
output FOUNDRY_ACCOUNT_PRINCIPAL_ID string = createFoundry ? foundryNew!.outputs.accountPrincipalId : foundryExisting!.outputs.accountPrincipalId
output PURVIEW_ACCOUNT_PRINCIPAL_ID string = createPurview ? purviewNew!.outputs.principalId : purviewExisting!.outputs.principalId
output SEARCH_SERVICE_NAME string = createSearch ? searchServiceName : ''
output SEARCH_ENDPOINT string = searchEndpoint
output DATA_STORAGE_ACCOUNT string = createData ? data!.outputs.dataAccountName : ''
output DATA_CONTAINER string = createData ? data!.outputs.dataContainerName : 'products'
output STATE_STORAGE_ACCOUNT string = createData ? data!.outputs.stateAccountName : ''
output STATE_CONTAINER string = createData ? data!.outputs.stateContainerName : 'state'
output CORTEX_CHAT_POLICY string = chatPolicy
output CORTEX_BOOTSTRAP_JOB string = containerApps.outputs.bootstrapJobName
output NSP_NAME string = (createData && createPerimeter) ? perimeterName : ''
output STORAGE_ACCESS_MODE string = storageAccessMode
output SEARCH_ACCESS_MODE string = searchAccessMode

output CREATED_THIS_ROUND array = concat(
  createSearch ? ['AI Search: ${searchServiceName} (${searchSku})'] : [],
  createData ? ['Storage: ${dataAccountName} (sample data, ADLS Gen2), ${stateAccountName} (state blobs)'] : [],
  (createData && createPerimeter) ? ['Network Security Perimeter: ${perimeterName}'] : []
)

output REUSED array = concat(
  createApim ? [] : ['API Management: ${apimName}'],
  createPurview ? [] : ['Purview: ${purviewName}'],
  createFoundry ? [] : ['Foundry: ${foundryAccountName}/${foundryProjectName}'],
  createKeyVault ? [] : ['Key Vault: ${keyVaultName}'],
  createRegistry ? [] : ['Container registry: ${registryName}'],
  createMonitoring ? [] : ['Monitoring: ${appInsightsName}']
)
