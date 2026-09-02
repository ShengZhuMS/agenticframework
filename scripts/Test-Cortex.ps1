<#
.SYNOPSIS
  Check a deployed Cortex, or run the local test suite.

.EXAMPLE
  .\scripts\Test-Cortex.ps1
  Health-check the deployed app.

.EXAMPLE
  .\scripts\Test-Cortex.ps1 -Local
  Run the unit tests instead.
#>
[CmdletBinding()]
param([switch]$Local, [string]$Url, [string]$McpUrl, [string]$ResourceGroup)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
  if ($Local) {
    npm test
    exit $LASTEXITCODE
  }

  if (-not $Url -or -not $McpUrl -or -not $ResourceGroup) {
    azd env get-values | ForEach-Object {
      if (-not $Url           -and $_ -match '^CORTEX_WEB_URL="?([^"]*)"?$')       { $Url = $Matches[1] }
      if (-not $McpUrl        -and $_ -match '^CORTEX_MCP_URL="?([^"]*)"?$')       { $McpUrl = $Matches[1] }
      if (-not $ResourceGroup -and $_ -match '^AZURE_RESOURCE_GROUP="?([^"]*)"?$') { $ResourceGroup = $Matches[1] }
    }
  }
  if (-not $Url) { throw 'No URL. Pass -Url, or run from a folder with an azd environment.' }

  # WHAT IS ACTUALLY RUNNING
  # Checked first, because the two failures that look like an application fault
  # are not one. A placeholder image means the code was never pushed; an ingress
  # port that does not match the app means nothing can reach it. Both present as
  # the Container Apps welcome page or a 502, and neither is visible from an
  # HTTP check alone.
  if ($ResourceGroup -and (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Host "Container apps in $ResourceGroup`n"
    foreach ($app in @('cortex-web','cortex-purview-mcp')) {
      $raw = az containerapp show -n $app -g $ResourceGroup -o json 2>$null
      if ($LASTEXITCODE -ne 0 -or -not $raw) {
        Write-Host ("  FAIL  {0} not found" -f $app) -ForegroundColor Red
        continue
      }
      $c     = $raw | ConvertFrom-Json
      $image = $c.properties.template.containers[0].image
      $port  = $c.properties.configuration.ingress.targetPort
      $rev   = $c.properties.runningStatus

      if ($image -match 'k8se/quickstart') {
        Write-Host ("  FAIL  {0} is running the PLACEHOLDER image" -f $app) -ForegroundColor Red
        Write-Host '        Its code was never pushed. Run: .\scripts\Deploy-Cortex.ps1 -AppOnly' -ForegroundColor Yellow
      } else {
        Write-Host ("  OK    {0}  {1}" -f $app, ($image -split '/')[-1]) -ForegroundColor Green
      }
      if ($port -ne 3000) {
        Write-Host ("  FAIL  {0} ingress targets port {1}; Cortex listens on 3000" -f $app, $port) -ForegroundColor Red
        Write-Host ("        Fix: az containerapp ingress update -n {0} -g {1} --target-port 3000" -f $app, $ResourceGroup) -ForegroundColor Yellow
      }
      if ($rev -and $rev -ne 'Running') {
        Write-Host ("  WARN  {0} status is {1}" -f $app, $rev) -ForegroundColor Yellow
      }
    }
    Write-Host ''
  }

  Write-Host "Checking $Url`n"
  $checks = @(
    @{ Path = '/api/health';          Name = 'App and register' },
    @{ Path = '/api/health/keyvault'; Name = 'Key Vault' },
    @{ Path = '/api/health/purview';  Name = 'Purview' },
    @{ Path = '/api/health/apim';     Name = 'API Management' },
    @{ Path = '/api/health/foundry';  Name = 'Foundry' }
  )

  $failed = 0
  foreach ($c in $checks) {
    try {
      $r = Invoke-RestMethod -Uri "$Url$($c.Path)" -TimeoutSec 30
      if ($r.ok) {
        Write-Host ("  OK    {0}" -f $c.Name) -ForegroundColor Green
      } else {
        $failed++
        Write-Host ("  FAIL  {0}" -f $c.Name) -ForegroundColor Red
        if ($r.missingRequired) { Write-Host ("        missing: {0}" -f ($r.missingRequired -join ', ')) }
        if ($r.sourceErrors)    { Write-Host ("        errors:  {0}" -f ($r.sourceErrors | ConvertTo-Json -Compress)) }
      }
      if ($c.Path -eq '/api/health') {
        Write-Host ("        {0} entries across {1} domains" -f $r.entries, $r.domains)
        if ($r.entries -eq 0) {
          Write-Host '        Register is empty — run: npm run bootstrap' -ForegroundColor Yellow
        }
      }
    } catch {
      $failed++
      Write-Host ("  FAIL  {0} — {1}" -f $c.Name, $_.Exception.Message) -ForegroundColor Red
    }
  }

  # The MCP server is a separate container app on a separate image. It was
  # never deployed to before azure.yaml declared it as a service, so it is
  # worth confirming it is running Cortex code and not the placeholder.
  if ($McpUrl) {
    try {
      $m = Invoke-RestMethod -Uri "$McpUrl/health" -TimeoutSec 30
      if ($m.ok) {
        Write-Host ("  OK    Purview MCP server ({0} tools)" -f $m.tools) -ForegroundColor Green
      } else {
        $failed++
        Write-Host '  FAIL  Purview MCP server returned ok=false' -ForegroundColor Red
      }
    } catch {
      $failed++
      Write-Host ("  FAIL  Purview MCP server — {0}" -f $_.Exception.Message) -ForegroundColor Red
      Write-Host '        If this 404s, the app is still on the placeholder image. Run: .\scripts\Deploy-Cortex.ps1 -AppOnly' -ForegroundColor Yellow
    }
  }

  Write-Host ''
  if ($failed) { Write-Host "$failed check(s) failed." -ForegroundColor Red; exit 1 }
  Write-Host 'All checks passed. The golden path will run.' -ForegroundColor Green
}
finally { Pop-Location }
