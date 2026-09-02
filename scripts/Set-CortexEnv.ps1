<#
.SYNOPSIS
  Load the Cortex configuration into THIS PowerShell session.

.DESCRIPTION
  DOT-SOURCE THIS. `.\scripts\Set-CortexEnv.ps1` runs in its own scope and the
  variables vanish when it exits — the leading dot is what makes them stick:

      . .\scripts\Set-CortexEnv.ps1

  WHY THIS EXISTS
  bootstrap.js reads configuration exactly the way the app does: Key Vault
  first, environment variables second. That worked when the vault was readable
  from your machine. It is not — public network access is disabled, and the
  Key Vault firewall applies to the data plane, which is what a read is.

  The deployed container apps are fine: provisioning writes their configuration
  directly onto them. But `npm run bootstrap` runs HERE, on your laptop, in a
  process that has neither the vault nor those environment variables. So every
  required value resolves to nothing and bootstrap exits with:

      Missing required configuration:
        - azure-subscription-id
        ... (the 8 entries marked required in SECRET_CATALOGUE)

  This script closes that gap. It reads what provisioning already published
  into the azd environment, fetches the APIM subscription key from API
  Management's ARM endpoint — a control-plane call, so the Key Vault firewall
  is irrelevant to it — and sets both as environment variables for this
  session only.

  NOTHING IS WRITTEN TO DISK. The APIM key lives in this session's memory and
  disappears when you close the window. That is deliberate: a .env file
  containing it would be a credential sitting in your repo folder.

.EXAMPLE
  . .\scripts\Set-CortexEnv.ps1
  npm run bootstrap

.EXAMPLE
  . .\scripts\Set-CortexEnv.ps1 -Quiet
  Same, without the summary.
#>
[CmdletBinding()]
param(
  [string]$EnvironmentName,
  [switch]$Quiet
)

# A normal invocation gets its own scope, so everything below would be set and
# then immediately discarded. Catch that rather than let someone conclude the
# script does not work.
if ($MyInvocation.InvocationName -ne '.') {
  Write-Host ''
  Write-Host '  This script must be DOT-SOURCED or it has no effect.' -ForegroundColor Red
  Write-Host '  The variables would be set in a child scope and discarded on exit.' -ForegroundColor Red
  Write-Host ''
  Write-Host '  Run it like this — note the leading dot and space:' -ForegroundColor Yellow
  Write-Host '      . .\scripts\Set-CortexEnv.ps1' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}

$ErrorActionPreference = 'Stop'
$cortexRoot = Split-Path -Parent $PSScriptRoot

try {
  Push-Location $cortexRoot

  if ($EnvironmentName) { azd env select $EnvironmentName | Out-Null }

  $v = @{}
  azd env get-values 2>$null | ForEach-Object {
    if ($_ -match '^(\w+)="?([^"]*)"?$') { $v[$Matches[1]] = $Matches[2] }
  }

  if (-not $v['CORTEX_WEB_URL']) {
    throw 'No deployment found in the azd environment. Run .\scripts\Deploy-Cortex.ps1 first.'
  }

  # THE TRAP IN THIS MAPPING.
  # The app's `azure-resource-group` value is the group holding API MANAGEMENT,
  # because everything it builds with it is an APIM ARM resource id. The azd
  # output named AZURE_RESOURCE_GROUP is the group holding CORTEX. They are
  # different groups, and using the wrong one makes every APIM call 404 with a
  # message that says nothing about resource groups.
  $apimRg = $v['APIM_RESOURCE_GROUP']
  if (-not $apimRg) { $apimRg = $v['APIM_RG'] }

  $env:AZURE_SUBSCRIPTION_ID    = $v['AZURE_SUBSCRIPTION_ID']
  $env:AZURE_RESOURCE_GROUP     = $apimRg
  $env:APIM_SERVICE_NAME        = $v['APIM_SERVICE_NAME']
  $env:APIM_GATEWAY_URL         = $v['APIM_GATEWAY_URL']
  $env:FOUNDRY_PROJECT_ENDPOINT = $v['FOUNDRY_PROJECT_ENDPOINT']
  $env:PUBLIC_BASE_URL          = $v['CORTEX_WEB_URL']
  $env:PURVIEW_MCP_URL          = if ($v['CORTEX_MCP_URL']) { "$($v['CORTEX_MCP_URL'])/mcp" } else { '' }

  if ($v['FOUNDRY_MODEL_DEPLOYMENT']) { $env:FOUNDRY_MODEL = $v['FOUNDRY_MODEL_DEPLOYMENT'] }
  if ($v['APIM_PRODUCT_ID'])          { $env:APIM_PRODUCT_ID = $v['APIM_PRODUCT_ID'] }

  # Deliberately NOT set. The vault is unreachable from here, and leaving this
  # empty is what makes the adapter skip cleanly instead of spending its whole
  # 15-second timeout budget failing before it falls back to these values.
  $env:KEYVAULT_NAME = ''

  # Control-plane call against API Management. Unaffected by the Key Vault
  # firewall, which is why this works when reading the vault does not.
  $apimKey = $null
  if ($env:APIM_SERVICE_NAME -and $apimRg -and $env:AZURE_SUBSCRIPTION_ID) {
    $url = "https://management.azure.com/subscriptions/$($env:AZURE_SUBSCRIPTION_ID)/resourceGroups/$apimRg/providers/Microsoft.ApiManagement/service/$($env:APIM_SERVICE_NAME)/subscriptions/master/listSecrets?api-version=2024-05-01"
    $apimKey = az rest --method POST --url $url --query primaryKey -o tsv 2>$null
  }
  if ($apimKey) {
    $env:APIM_SUBSCRIPTION_KEY = $apimKey
  } else {
    Write-Host '  WARN  Could not read the APIM subscription key from API Management.' -ForegroundColor Yellow
    Write-Host '        Bootstrap will report it missing. Set it by hand if you have it:' -ForegroundColor Yellow
    Write-Host '            $env:APIM_SUBSCRIPTION_KEY = ''<key>''' -ForegroundColor Yellow
  }

  if (-not $Quiet) {
    Write-Host ''
    Write-Host '  Cortex configuration loaded into this session.' -ForegroundColor Green
    Write-Host ''
    Write-Host "    subscription : $($env:AZURE_SUBSCRIPTION_ID)"
    Write-Host "    APIM         : $($env:APIM_SERVICE_NAME)  (resource group $apimRg)"
    Write-Host "    Foundry      : $($env:FOUNDRY_PROJECT_ENDPOINT)"
    Write-Host "    Web          : $($env:PUBLIC_BASE_URL)"
    Write-Host "    MCP          : $($env:PURVIEW_MCP_URL)"
    Write-Host "    APIM key     : $(if ($env:APIM_SUBSCRIPTION_KEY) { 'loaded (not shown)' } else { 'NOT SET' })"
    Write-Host ''
    Write-Host '  This session only. Nothing was written to disk.' -ForegroundColor DarkGray
    Write-Host '  Now run:  npm run bootstrap' -ForegroundColor Cyan
    Write-Host ''
  }
}
finally { Pop-Location }
