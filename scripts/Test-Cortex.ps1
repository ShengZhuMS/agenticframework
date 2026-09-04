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

  # GET a JSON endpoint WITHOUT following redirects. When sign-in guards a
  # machine path, Easy Auth answers 302 to login.microsoftonline.com; following
  # it returns an HTML page that reads as "ok=false" for every check at once.
  function Get-CortexJson {
    param([string]$Uri)
    try {
      $r = Invoke-WebRequest -Uri $Uri -MaximumRedirection 0 -SkipHttpErrorCheck -TimeoutSec 60 -ErrorAction Stop
    } catch { return @{ ok = $false; error = $_.Exception.Message } }
    if ($r.StatusCode -in 301,302,303,307,308,401) { return @{ ok = $false; behindSignIn = $true } }
    try { $j = $r.Content | ConvertFrom-Json } catch { return @{ ok = $false; error = "not JSON (HTTP $($r.StatusCode))" } }
    return @{ ok = [bool]$j.ok; json = $j }
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
  $behindSignIn = $false
  foreach ($c in $checks) {
    try {
      $probe = Get-CortexJson -Uri "$Url$($c.Path)"
      if ($probe.behindSignIn) {
        $failed++; $behindSignIn = $true
        Write-Host ("  FAIL  {0} — redirected to sign-in" -f $c.Name) -ForegroundColor Red
        continue
      }
      if ($probe.error) { throw $probe.error }
      $r = $probe.json
      if ($r.ok) {
        Write-Host ("  OK    {0}" -f $c.Name) -ForegroundColor Green
        if ($c.Path -eq '/api/health/purview') {
          Write-Host ("        {0} domains, {1} data products ({2} published)" -f $r.domains, $r.dataProducts, $r.published)
        }
      } else {
        $failed++
        Write-Host ("  FAIL  {0}" -f $c.Name) -ForegroundColor Red
        if ($r.error)           { Write-Host ("        {0}" -f $r.error) }
        if ($r.missingRequired) { Write-Host ("        missing: {0}" -f ($r.missingRequired -join ', ')) }
        if ($r.sourceErrors)    { Write-Host ("        errors:  {0}" -f ($r.sourceErrors | ConvertTo-Json -Compress)) }
        # The one Purview failure that is not an app fault, and the one people
        # hit first. Say what it is and what fixes it.
        $text = "$($r.error) $($r.sourceErrors | ConvertTo-Json -Compress)"
        if ($text -match 'Not authorized to access account|failed 403') {
          Write-Host '        The Cortex identity holds no Unified Catalog role yet. Grant it:' -ForegroundColor Yellow
          Write-Host '            . .\scripts\Set-CortexEnv.ps1' -ForegroundColor Yellow
          Write-Host '            node scripts/bootstrap.js --only=roles' -ForegroundColor Yellow
          Write-Host '        then wait a minute and run this again.' -ForegroundColor Yellow
        }
      }
      if ($c.Path -eq '/api/health') {
        Write-Host ("        {0} entries across {1} domains" -f $r.entries, $r.domains)
        if ($r.entries -eq 0) {
          Write-Host '        Register is empty — run: npm run bootstrap' -ForegroundColor Yellow
        }
      }

      # Where configuration actually came from. In a subscription where the
      # vault is unreachable this is the line that matters: the check passes
      # either way, because the app is designed to fall back, so 'ok' alone
      # does not tell you whether the vault is being used.
      if ($c.Path -eq '/api/health/keyvault') {
        if ($r.configured) {
          Write-Host ("        {0} from Key Vault, {1} from environment" -f $r.fromKeyVault, $r.fromEnvironment)
          if ($r.fromKeyVault -eq 0) {
            Write-Host '        Vault is configured but supplied nothing — it is unreachable from the app.' -ForegroundColor Yellow
            Write-Host '        Expected if public network access is disabled. Run the deploy script to switch' -ForegroundColor Yellow
            Write-Host '        to direct configuration, or give the app a private endpoint.' -ForegroundColor Yellow
          }
        } else {
          Write-Host ("        Direct configuration — {0} values from the environment, no vault in use" -f $r.fromEnvironment)
        }
        if ($r.missingRequired -and $r.missingRequired.Count -gt 0) {
          Write-Host ("        MISSING: {0}" -f ($r.missingRequired -join ', ')) -ForegroundColor Red
        }
      }
    } catch {
      $failed++
      Write-Host ("  FAIL  {0} — {1}" -f $c.Name, $_.Exception.Message) -ForegroundColor Red
    }
  }

  if ($behindSignIn) {
    Write-Host '        Sign-in is guarding the health endpoints, so they cannot be checked from here.' -ForegroundColor Yellow
    Write-Host '        Set-CortexAuth.ps1 excludes /api/health*, /api/index/refresh and /shim/* from sign-in. Run it, then this again.' -ForegroundColor Yellow
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
