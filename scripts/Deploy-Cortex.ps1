<#
.SYNOPSIS
  Deploy Cortex to Azure, reusing your existing estate.

.DESCRIPTION
  Probes each Azure resource Cortex needs. Where it exists, Cortex is granted
  access to it. Where it does not, Cortex creates it. Nothing you already own
  is recreated or reconfigured beyond the role assignment Cortex needs.

  Defaults point at subscription ME-MngEnvMCAP181916-Core:
    API Management  prdcoreapimneu001        (PRDCOREAPIM001, North Europe)
    Purview         prdcorepurvieweus        (PRDCOREPVW001,  East US)
    Foundry         prdcorefdryeus001        (PRDCOREFDRY001, East US)
    Key Vault       prdcorekveus             (PRDCOREPVW001,  East US)
    Registry        prdcoreamlacr001         (PRDCOREAML001,  North Europe)
    Monitoring      prdcoreamlneu08774392429 (PRDCOREAML001,  North Europe)

  Safe to re-run. Every step is idempotent.

.EXAMPLE
  .\scripts\Deploy-Cortex.ps1
  Reuse everything that exists, create only what does not.

.EXAMPLE
  .\scripts\Deploy-Cortex.ps1 -WhatIfResources
  Report what would be reused and what would be created. Changes nothing.

.EXAMPLE
  .\scripts\Deploy-Cortex.ps1 -ApimName my-apim -ApimResourceGroup my-rg
  Point at different resources.
#>
[CmdletBinding()]
param(
  [string]$SubscriptionId,
  [string]$EnvironmentName      = 'cortex',
  [string]$Location             = 'northeurope',
  [string]$CortexResourceGroup  = 'PRDCORECORTEX001',

  [string]$ApimName             = 'prdcoreapimneu001',
  [string]$ApimResourceGroup    = 'PRDCOREAPIM001',
  [string]$PurviewName          = 'prdcorepurvieweus',
  [string]$PurviewResourceGroup = 'PRDCOREPVW001',
  [string]$FoundryAccountName   = 'prdcorefdryeus001',
  [string]$FoundryProjectName   = 'prdcorefdryproj-default',
  [string]$FoundryResourceGroup = 'PRDCOREFDRY001',
  [string]$KeyVaultName         = 'prdcorekveus',
  [string]$KeyVaultResourceGroup= 'PRDCOREPVW001',
  [string]$RegistryName         = 'prdcoreamlacr001',
  [string]$RegistryResourceGroup= 'PRDCOREAML001',
  [string]$LogAnalyticsName     = 'prdcoreamlneu03094960047',
  [string]$AppInsightsName      = 'prdcoreamlneu08774392429',
  [string]$MonitoringResourceGroup = 'PRDCOREAML001',
  [string]$ModelName            = 'gpt-4o-mini',

  [switch]$WhatIfResources,
  [switch]$SkipProvision,
  [switch]$SkipBootstrap
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Step($n,$t){ Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($t)     { Write-Host "  OK      $t" -ForegroundColor Green }
function Reuse($t)  { Write-Host "  REUSE   $t" -ForegroundColor Green }
function Create($t) { Write-Host "  CREATE  $t" -ForegroundColor Yellow }
function Warn2($t)  { Write-Host "  WARN    $t" -ForegroundColor Yellow }
function Fail($t)   { Write-Host "  FAIL    $t" -ForegroundColor Red }

# Does a resource exist? Returns $true/$false, never throws.
function Test-AzResource {
  param([string]$Rg, [string]$Name, [string]$Type)
  if (-not $Rg -or -not $Name) { return $false }
  $null = az resource show -g $Rg -n $Name --resource-type $Type 2>$null
  return ($LASTEXITCODE -eq 0)
}

try {
  # ------------------------------------------------------------- 1 checks
  Step 1 'Checking prerequisites'
  foreach ($tool in @('az','azd','node','npm')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
      throw "$tool is not installed or not on PATH. See the deployment guide, section 1."
    }
  }
  $nodeMajor = (node --version) -replace 'v(\d+)\..*','$1'
  if ([int]$nodeMajor -lt 20) { throw "Node 20 or later required. Found v$nodeMajor." }
  Ok "az, azd, node v$nodeMajor, npm"

  # --------------------------------------------------------------- 2 auth
  Step 2 'Azure sign-in'
  $acct = az account show 2>$null | ConvertFrom-Json
  if (-not $acct) { az login | Out-Null; $acct = az account show | ConvertFrom-Json }
  if ($SubscriptionId -and $acct.id -ne $SubscriptionId) {
    az account set --subscription $SubscriptionId
    $acct = az account show | ConvertFrom-Json
  }
  Ok "Subscription: $($acct.name)"
  Ok "Tenant:       $($acct.tenantId)"

  # ------------------------------------------------------- 3 probe estate
  Step 3 'Checking which resources already exist'

  $found = @{
    Apim       = Test-AzResource $ApimResourceGroup       $ApimName           'Microsoft.ApiManagement/service'
    Purview    = Test-AzResource $PurviewResourceGroup    $PurviewName        'Microsoft.Purview/accounts'
    Foundry    = Test-AzResource $FoundryResourceGroup    $FoundryAccountName 'Microsoft.CognitiveServices/accounts'
    KeyVault   = Test-AzResource $KeyVaultResourceGroup   $KeyVaultName       'Microsoft.KeyVault/vaults'
    Registry   = Test-AzResource $RegistryResourceGroup   $RegistryName       'Microsoft.ContainerRegistry/registries'
    Monitoring = Test-AzResource $MonitoringResourceGroup $AppInsightsName    'Microsoft.Insights/components'
  }

  if ($found.Apim)       { Reuse "API Management   $ApimName ($ApimResourceGroup)" }        else { Create 'API Management' }
  if ($found.Purview)    { Reuse "Purview          $PurviewName ($PurviewResourceGroup)" }  else { Create 'Purview' }
  if ($found.Foundry)    { Reuse "Foundry          $FoundryAccountName/$FoundryProjectName" } else { Create 'Foundry' }
  if ($found.KeyVault)   { Reuse "Key Vault        $KeyVaultName ($KeyVaultResourceGroup)" } else { Create 'Key Vault' }
  if ($found.Registry)   { Reuse "Registry         $RegistryName ($RegistryResourceGroup)" } else { Create 'Container registry' }
  if ($found.Monitoring) { Reuse "Monitoring       $AppInsightsName ($MonitoringResourceGroup)" } else { Create 'Log Analytics + App Insights' }
  Create "Container Apps   cortex-web, cortex-purview-mcp ($CortexResourceGroup)"
  Create "Managed identity id-$EnvironmentName ($CortexResourceGroup)"

  # A vault on the legacy access-policy model silently ignores RBAC.
  if ($found.KeyVault) {
    $rbac = az keyvault show -n $KeyVaultName -g $KeyVaultResourceGroup `
              --query properties.enableRbacAuthorization -o tsv 2>$null
    if ($rbac -ne 'true') {
      Warn2 "$KeyVaultName uses ACCESS POLICIES, not RBAC."
      Warn2 'The role assignment will be ignored. Either switch it to RBAC:'
      Write-Host "    az keyvault update -n $KeyVaultName -g $KeyVaultResourceGroup --enable-rbac-authorization true"
      Warn2 'or add an access policy for the Cortex identity after deployment.'
    }
  }

  # A model that is not deployed means agents cannot run.
  $deployModel = $false
  if ($found.Foundry) {
    $null = az cognitiveservices account deployment show `
              -g $FoundryResourceGroup -n $FoundryAccountName --deployment-name $ModelName 2>$null
    if ($LASTEXITCODE -ne 0) {
      Warn2 "Model '$ModelName' is not deployed on $FoundryAccountName. It will be deployed."
      $deployModel = $true
    } else { Ok "Model $ModelName already deployed" }
  }

  if ($WhatIfResources) {
    Write-Host "`nNothing was changed. Remove -WhatIfResources to deploy.`n" -ForegroundColor Cyan
    exit 0
  }

  # ---------------------------------------------------------- 4 providers
  Step 4 'Registering resource providers'
  foreach ($p in @('Microsoft.App','Microsoft.OperationalInsights','Microsoft.ManagedIdentity')) {
    az provider register --namespace $p --only-show-errors | Out-Null
  }
  Ok 'Registered'

  # ------------------------------------------------------------ 5 install
  Step 5 'Installing dependencies and vendoring GOV.UK Frontend'
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
  Ok 'Installed'

  # ---------------------------------------------------------- 6 provision
  if (-not $SkipProvision) {
    Step 6 'Provisioning'
    azd env new $EnvironmentName --location $Location --subscription $acct.id 2>$null | Out-Null
    azd env select $EnvironmentName | Out-Null

    $settings = @{
      AZURE_LOCATION            = $Location
      CORTEX_RESOURCE_GROUP     = $CortexResourceGroup
      APIM_NAME                 = $ApimName
      APIM_RG                   = $ApimResourceGroup
      CREATE_APIM               = (-not $found.Apim).ToString().ToLower()
      PURVIEW_NAME              = $PurviewName
      PURVIEW_RG                = $PurviewResourceGroup
      CREATE_PURVIEW            = (-not $found.Purview).ToString().ToLower()
      FOUNDRY_ACCOUNT           = $FoundryAccountName
      FOUNDRY_PROJECT           = $FoundryProjectName
      FOUNDRY_RG                = $FoundryResourceGroup
      CREATE_FOUNDRY            = (-not $found.Foundry).ToString().ToLower()
      CREATE_MODEL_DEPLOYMENT   = $deployModel.ToString().ToLower()
      MODEL_NAME                = $ModelName
      KEYVAULT_NAME             = $KeyVaultName
      KEYVAULT_RG               = $KeyVaultResourceGroup
      CREATE_KEYVAULT           = (-not $found.KeyVault).ToString().ToLower()
      REGISTRY_NAME             = $RegistryName
      REGISTRY_RG               = $RegistryResourceGroup
      CREATE_REGISTRY           = (-not $found.Registry).ToString().ToLower()
      LOG_ANALYTICS_NAME        = $LogAnalyticsName
      APP_INSIGHTS_NAME         = $AppInsightsName
      MONITORING_RG             = $MonitoringResourceGroup
      CREATE_MONITORING         = (-not $found.Monitoring).ToString().ToLower()
      APIM_PUBLISHER_EMAIL      = $acct.user.name
    }
    foreach ($k in $settings.Keys) { azd env set $k $settings[$k] | Out-Null }

    azd up --no-prompt
    if ($LASTEXITCODE -ne 0) { throw 'azd up failed. See the output above.' }
    Ok 'Provisioned and deployed'
  } else {
    Step 6 'Skipping provisioning'
    azd env select $EnvironmentName | Out-Null
  }

  # -------------------------------------------------------------- 7 values
  $v = @{}
  azd env get-values | ForEach-Object { if ($_ -match '^(\w+)="?([^"]*)"?$') { $v[$Matches[1]] = $Matches[2] } }
  $kv     = $v['KEYVAULT_NAME']
  $kvRg   = $v['KEYVAULT_RESOURCE_GROUP']
  $webUrl = $v['CORTEX_WEB_URL']
  $apim   = $v['APIM_SERVICE_NAME']
  $apimRg = $v['APIM_RESOURCE_GROUP']

  # ------------------------------------------------------------ 8 secrets
  Step 7 'Onboarding the APIM subscription key'
  $existing = az keyvault secret show --vault-name $kv --name apim-subscription-key --query value -o tsv 2>$null
  if ($existing) {
    Ok 'apim-subscription-key already onboarded'
  } else {
    $key = az rest --method POST --url ("https://management.azure.com/subscriptions/{0}/resourceGroups/{1}/providers/Microsoft.ApiManagement/service/{2}/subscriptions/master/listSecrets?api-version=2024-05-01" -f $acct.id, $apimRg, $apim) `
             --query primaryKey -o tsv 2>$null
    if ($key) {
      az keyvault secret set --vault-name $kv --name apim-subscription-key --value $key --only-show-errors | Out-Null
      Ok 'Onboarded from API Management'
    } else {
      Warn2 'Could not read the APIM key. Set it by hand:'
      Write-Host "    az keyvault secret set --vault-name $kv --name apim-subscription-key --value '<key>'"
    }
  }

  # ---------------------------------------------------------- 9 bootstrap
  if (-not $SkipBootstrap) {
    Step 8 'Creating the Defra content in Purview and API Management'
    Warn2 'Needs the Purview roles from the deployment guide, section 6.'
    npm run bootstrap
    if ($LASTEXITCODE -ne 0) {
      Warn2 'Bootstrap reported failures. It is idempotent — fix the roles and re-run: npm run bootstrap'
    } else { Ok 'Domains and data products created' }
  }

  # ------------------------------------------------------------- 10 check
  Step 9 'Checking the deployment'
  foreach ($p in @('/api/health','/api/health/keyvault','/api/health/purview','/api/health/apim','/api/health/foundry')) {
    try {
      $r = Invoke-RestMethod -Uri "$webUrl$p" -TimeoutSec 30
      if ($r.ok) { Ok $p } else { Warn2 "$p returned ok=false" }
    } catch { Fail "$p — $($_.Exception.Message)" }
  }

  Write-Host "`n===========================================================" -ForegroundColor Green
  Write-Host " Cortex is deployed." -ForegroundColor Green
  Write-Host "===========================================================" -ForegroundColor Green
  Write-Host "`n  $webUrl`n"
  Write-Host " Two steps remain. Neither can be automated.`n"
  Write-Host "  1. Purview roles — BOTH planes. Identity: $($v['CORTEX_IDENTITY_PRINCIPAL_ID'])"
  Write-Host "     Deployment guide, section 6."
  Write-Host "  2. Entra sign-in, WITH the groups claim."
  Write-Host "     Without it everyone appears to be in no groups and sees almost nothing."
  Write-Host "     Deployment guide, section 5.`n"
}
catch { Fail $_.Exception.Message; exit 1 }
finally { Pop-Location }
