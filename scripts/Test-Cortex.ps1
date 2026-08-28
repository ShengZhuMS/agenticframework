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
param([switch]$Local, [string]$Url)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
  if ($Local) {
    npm test
    exit $LASTEXITCODE
  }

  if (-not $Url) {
    azd env get-values | ForEach-Object {
      if ($_ -match '^CORTEX_WEB_URL="?([^"]*)"?$') { $Url = $Matches[1] }
    }
  }
  if (-not $Url) { throw 'No URL. Pass -Url, or run from a folder with an azd environment.' }

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

  Write-Host ''
  if ($failed) { Write-Host "$failed check(s) failed." -ForegroundColor Red; exit 1 }
  Write-Host 'All checks passed. The golden path will run.' -ForegroundColor Green
}
finally { Pop-Location }
