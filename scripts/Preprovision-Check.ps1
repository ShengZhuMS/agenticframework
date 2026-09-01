<#
.SYNOPSIS
  Pre-provision guard for `azd up` / `azd provision`.

.DESCRIPTION
  Deploy-Cortex.ps1 is the supported entry point and does all of this in more
  depth. This hook exists because a bare `azd up` bypasses it entirely, and
  the two failures that have actually happened here both occur during
  provisioning, minutes in:

    1. A deprecated model version. ARM refuses new deployments of a model in
       the Deprecating or Deprecated lifecycle stage. The error names the
       model but not the template line, because the template never named a
       version — it inherited ARM's moving default.

    2. Container images reset to the placeholder. azd provisions before it
       deploys, so a re-provision that does not know the current image rolls
       both apps back to mcr.microsoft.com/k8se/quickstart.

  Everything here is read-only apart from `azd env set`, which only records
  values azd itself will use on the next line.
#>
$ErrorActionPreference = 'Stop'

function Note($t) { Write-Host "  $t" -ForegroundColor DarkGray }
function Warn($t) { Write-Host "  WARN  $t" -ForegroundColor Yellow }
function Ok($t)   { Write-Host "  OK    $t" -ForegroundColor Green }

Write-Host "`n[pre-provision] Checking before anything is created" -ForegroundColor Cyan

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  Warn 'Azure CLI not found — skipping checks.'
  exit 0
}

$rg          = $env:CORTEX_RESOURCE_GROUP
$foundryRg   = $env:FOUNDRY_RG
$foundryAcct = $env:FOUNDRY_ACCOUNT
$modelName   = $env:MODEL_NAME
$modelVer    = $env:MODEL_VERSION
$createModel = $env:CREATE_MODEL_DEPLOYMENT

# ------------------------------------------------------------------ images
# Read what the apps are actually running and hand it back to azd, so this
# provision keeps the deployed code instead of reverting it.
if ($rg) {
  foreach ($svc in @(
    @{ App = 'cortex-web';          Var = 'SERVICE_WEB_IMAGE_NAME' },
    @{ App = 'cortex-purview-mcp';  Var = 'SERVICE_PURVIEW_MCP_IMAGE_NAME' }
  )) {
    $known = [Environment]::GetEnvironmentVariable($svc.Var)
    if ($known) { Note "$($svc.App) keeps $known"; continue }

    $live = az containerapp show -n $svc.App -g $rg --query 'properties.template.containers[0].image' -o tsv 2>$null
    if ($LASTEXITCODE -eq 0 -and $live -and $live -notmatch 'k8se/quickstart') {
      azd env set $svc.Var $live | Out-Null
      Ok "$($svc.App) keeps its current image"
    }
  }
}

# ------------------------------------------------------------------- model
# Only worth checking when this run would actually create a deployment.
if ($createModel -eq 'true' -and $foundryAcct -and $foundryRg -and $modelName) {
  $raw = az cognitiveservices account list-models -g $foundryRg -n $foundryAcct 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) {
    Warn "Could not read the model catalogue for $foundryAcct — continuing without validation."
    exit 0
  }

  $catalogue  = $raw | ConvertFrom-Json
  $candidates = @($catalogue | Where-Object { $_.name -eq $modelName })

  if ($candidates.Count -eq 0) {
    $names = ($catalogue | Select-Object -ExpandProperty name -Unique | Sort-Object) -join ', '
    Write-Host "`n  Model '$modelName' is not offered by $foundryAcct in its region." -ForegroundColor Red
    Write-Host "  Available: $names`n" -ForegroundColor Red
    exit 1
  }

  # Deprecating and Deprecated both refuse NEW deployments, which is what
  # provisioning is about to attempt.
  $blocked = @($candidates | Where-Object {
    $_.version -eq $modelVer -and $_.lifecycleStatus -in @('Deprecating','Deprecated','Retired')
  })
  if ($blocked.Count -gt 0) {
    $usable = @($candidates | Where-Object { $_.lifecycleStatus -notin @('Deprecating','Deprecated','Retired') } |
                Sort-Object version -Descending)
    Write-Host "`n  $modelName $modelVer is '$($blocked[0].lifecycleStatus)'." -ForegroundColor Red
    Write-Host '  Azure refuses NEW deployments of it. Provisioning would fail with ServiceModelDeprecating.' -ForegroundColor Red
    if ($usable.Count -gt 0) {
      Write-Host "`n  Deployable versions: $(($usable | ForEach-Object { $_.version }) -join ', ')" -ForegroundColor Yellow
      Write-Host "  Fix:  azd env set MODEL_VERSION $($usable[0].version)`n" -ForegroundColor Yellow
    }
    exit 1
  }

  $exact = @($candidates | Where-Object { $_.version -eq $modelVer })
  if ($exact.Count -eq 0) {
    $seen = ($candidates | ForEach-Object { $_.version }) -join ', '
    Write-Host "`n  $modelName $modelVer is not offered by $foundryAcct." -ForegroundColor Red
    Write-Host "  Versions available: $seen`n" -ForegroundColor Red
    exit 1
  }

  Ok "$modelName $modelVer is deployable ($($exact[0].lifecycleStatus))"
}

Write-Host ''
exit 0
