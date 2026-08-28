<#
.SYNOPSIS
  Deploy Cortex to Azure, end to end.

.DESCRIPTION
  Provisions every resource, deploys both container apps, onboards the one
  secret that cannot be automated, bootstraps Purview and API Management with
  the Defra content, and checks the result.

  Safe to re-run. Every step is idempotent.

.EXAMPLE
  .\scripts\Deploy-Cortex.ps1 -EnvironmentName cortex-poc -Location uksouth

.EXAMPLE
  .\scripts\Deploy-Cortex.ps1 -SkipProvision -SkipBootstrap
  Redeploy code only, leaving infrastructure and content alone.
#>
[CmdletBinding()]
param(
  [string]$EnvironmentName = 'cortex-poc',
  [string]$Location        = 'uksouth',
  [ValidateSet('Developer','BasicV2','StandardV2')]
  [string]$ApimSku         = 'Developer',
  [switch]$SkipProvision,
  [switch]$SkipBootstrap,
  [switch]$UseExistingApim,
  [string]$ExistingApimName
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Write-Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Write-Ok($t)       { Write-Host "  OK    $t" -ForegroundColor Green }
function Write-Warn2($t)    { Write-Host "  WARN  $t" -ForegroundColor Yellow }
function Write-Err($t)      { Write-Host "  FAIL  $t" -ForegroundColor Red }

try {
  # ---------------------------------------------------------------- checks
  Write-Step 1 'Checking prerequisites'
  foreach ($tool in @('az','azd','node','npm')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
      throw "$tool is not installed or not on PATH. See docs/deploy-windows.md section 1."
    }
    Write-Ok "$tool found"
  }

  $nodeMajor = (node --version) -replace 'v(\d+)\..*','$1'
  if ([int]$nodeMajor -lt 20) { throw "Node 20 or later is required. Found v$nodeMajor." }
  Write-Ok "Node v$nodeMajor"

  # ------------------------------------------------------------------ auth
  Write-Step 2 'Checking Azure sign-in'
  $account = az account show 2>$null | ConvertFrom-Json
  if (-not $account) {
    Write-Warn2 'Not signed in. Opening browser.'
    az login | Out-Null
    $account = az account show | ConvertFrom-Json
  }
  Write-Ok "Subscription: $($account.name)"
  Write-Ok "Tenant:       $($account.tenantId)"

  # ------------------------------------------------------------- providers
  Write-Step 3 'Registering resource providers'
  $providers = @(
    'Microsoft.App','Microsoft.ContainerRegistry','Microsoft.CognitiveServices',
    'Microsoft.ApiManagement','Microsoft.Purview','Microsoft.DocumentDB',
    'Microsoft.OperationalInsights','Microsoft.KeyVault'
  )
  foreach ($p in $providers) { az provider register --namespace $p --only-show-errors | Out-Null }
  Write-Ok "$($providers.Count) providers registered (registration continues in the background)"

  # --------------------------------------------------------------- install
  Write-Step 4 'Installing dependencies and vendoring GOV.UK Frontend'
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
  Write-Ok 'Dependencies installed, GOV.UK assets vendored'

  # ------------------------------------------------------------- provision
  if (-not $SkipProvision) {
    Write-Step 5 'Provisioning Azure resources'
    Write-Warn2 'API Management takes 30-45 minutes and Purview 10-15. Both start now.'

    azd env new $EnvironmentName --location $Location --subscription $account.id 2>$null | Out-Null
    azd env select $EnvironmentName | Out-Null
    azd env set APIM_SKU $ApimSku
    azd env set APIM_PUBLISHER_EMAIL $account.user.name
    if ($UseExistingApim) {
      azd env set USE_EXISTING_APIM true
      azd env set EXISTING_APIM_NAME $ExistingApimName
    }

    azd up --no-prompt
    if ($LASTEXITCODE -ne 0) { throw 'azd up failed. See the output above.' }
    Write-Ok 'Provisioned and deployed'
  } else {
    Write-Step 5 'Skipping provisioning'
    azd env select $EnvironmentName | Out-Null
  }

  # ------------------------------------------------------------------ vars
  $envValues = @{}
  azd env get-values | ForEach-Object {
    if ($_ -match '^(\w+)="?([^"]*)"?$') { $envValues[$Matches[1]] = $Matches[2] }
  }
  $kv      = $envValues['KEYVAULT_NAME']
  $webUrl  = $envValues['CORTEX_WEB_URL']
  $apimName= $envValues['APIM_SERVICE_NAME']
  $rg      = $envValues['AZURE_RESOURCE_GROUP']

  # --------------------------------------------------------------- secrets
  Write-Step 6 'Onboarding the APIM subscription key'
  $existing = az keyvault secret show --vault-name $kv --name apim-subscription-key `
                --query value -o tsv 2>$null
  if ($existing) {
    Write-Ok 'apim-subscription-key already onboarded'
  } elseif ($apimName -and $rg) {
    $key = az apim subscription list --service-name $apimName -g $rg `
             --query "[?scope=='/apis'].primaryKey | [0]" -o tsv 2>$null
    if (-not $key) {
      $key = az rest --method POST --url ("https://management.azure.com/subscriptions/{0}/resourceGroups/{1}/providers/Microsoft.ApiManagement/service/{2}/subscriptions/master/listSecrets?api-version=2024-05-01" -f $account.id, $rg, $apimName) `
               --query primaryKey -o tsv 2>$null
    }
    if ($key) {
      az keyvault secret set --vault-name $kv --name apim-subscription-key --value $key --only-show-errors | Out-Null
      Write-Ok 'apim-subscription-key onboarded from API Management'
    } else {
      Write-Warn2 'Could not read the APIM key automatically. Set it by hand:'
      Write-Host "    az keyvault secret set --vault-name $kv --name apim-subscription-key --value '<key>'"
    }
  }

  # ------------------------------------------------------------- bootstrap
  if (-not $SkipBootstrap) {
    Write-Step 7 'Creating the Defra content in Purview and API Management'
    Write-Warn2 'This needs the Purview roles from docs/deploy-windows.md section 6.'
    npm run bootstrap
    if ($LASTEXITCODE -ne 0) {
      Write-Warn2 'Bootstrap reported failures. It is idempotent — fix the roles and re-run:'
      Write-Host '    npm run bootstrap'
    } else {
      Write-Ok 'Governance domains and data products created'
    }
  }

  # ----------------------------------------------------------------- check
  Write-Step 8 'Checking the deployment'
  foreach ($probe in @('/api/health','/api/health/keyvault','/api/health/purview','/api/health/apim','/api/health/foundry')) {
    try {
      $r = Invoke-RestMethod -Uri "$webUrl$probe" -TimeoutSec 30
      if ($r.ok) { Write-Ok "$probe" } else { Write-Warn2 "$probe returned ok=false" }
    } catch {
      Write-Err "$probe unreachable — $($_.Exception.Message)"
    }
  }

  Write-Host "`n============================================================" -ForegroundColor Green
  Write-Host " Cortex is deployed." -ForegroundColor Green
  Write-Host "============================================================" -ForegroundColor Green
  Write-Host "`n  $webUrl`n"
  Write-Host " Two things remain, and neither can be automated:`n"
  Write-Host "  1. Purview governance roles — BOTH planes are required."
  Write-Host "     docs/deploy-windows.md section 6"
  Write-Host "  2. Entra sign-in, including the GROUPS claim."
  Write-Host "     Without it everyone appears to be in no groups and sees almost nothing."
  Write-Host "     docs/deploy-windows.md section 5`n"
}
catch {
  Write-Err $_.Exception.Message
  exit 1
}
finally {
  Pop-Location
}
