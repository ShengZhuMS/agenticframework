<#
.SYNOPSIS
  Deploy Cortex to Azure, reusing your existing estate. Safe to run repeatedly.

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

  BUILT FOR REPEATED RUNS
  Every step is idempotent and the script pre-flights the things that have
  actually broken a run here:

    * Model version. An unpinned model resolves to whatever ARM currently
      defaults to. gpt-4o-mini's default moved to 2024-07-18, which is
      Deprecated, and Azure refuses new deployments of it. The script now
      verifies the requested model AND version are offered by the account and
      are not deprecating, and tells you what to switch to when they are.
    * Container images. `azd up` provisions then deploys, so provisioning used
      to reset both apps to the placeholder image on every run. The image
      currently running is read back and fed into the template.
    * Resource group location. A group's location is immutable; the live one
      is read and reused so a changed -Location cannot wedge the deployment.
    * Key Vault. Seeding is skipped rather than failing the whole deployment
      when you lack Secrets Officer, and the vault's current owning
      environment is checked before it is taken over.
    * Soft-deleted names. Checked and recovered before a create is attempted,
      which is the real cause of "a resource with this name already exists or
      is in a conflicting state".

.EXAMPLE
  .\scripts\Deploy-Cortex.ps1
  Reuse everything that exists, create only what does not.

.EXAMPLE
  .\scripts\Deploy-Cortex.ps1 -WhatIfResources
  Report what would be reused, created and changed. Changes nothing.

.EXAMPLE
  .\scripts\Deploy-Cortex.ps1 -AppOnly
  Rebuild and push the container images only. No infrastructure, no bootstrap.

.EXAMPLE
  .\scripts\Deploy-Cortex.ps1 -UpgradeModel
  Move an existing model deployment onto the pinned model and version.

.EXAMPLE
  .\scripts\Deploy-Cortex.ps1 -GroupMap 'operations=Operations'
  Full deployment, and map an Entra group onto the name the access rules use.

.EXAMPLE
  .\scripts\Deploy-Cortex.ps1 -DemoIdentities -DemoUserEmail colleague@defra.gov.uk
  Full deployment, plus the "same page, different eyes" set-up: the demo Entra
  groups are created and mapped, you are put in all of them, and the colleague
  is invited into the analysts group only.

.EXAMPLE
  .\scripts\Deploy-Cortex.ps1 -NoPerimeter
  Leave the storage accounts on their own network rules instead of inside the
  Network Security Perimeter. Only sensible in a tenant without the SFI
  storage policy; in this one the accounts are then closed by policy.

.EXAMPLE
  .\scripts\Deploy-Cortex.ps1 -Reset
  Delete everything Cortex created and start clean. Prompts first.
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

  # gpt-4o-mini 2024-07-18 is Deprecated and cannot be deployed. gpt-5.4-mini
  # is the current GA equivalent. Both the name and the version are pinned on
  # purpose — see the note in infra/modules/foundry-existing.bicep.
  [string]$ModelName            = 'gpt-5.4-mini',
  [string]$ModelVersion         = '2026-03-17',
  [string]$ModelDeploymentName  = '',
  [ValidateSet('GlobalStandard','Standard','DataZoneStandard')]
  [string]$ModelSku             = 'GlobalStandard',
  [int]$ModelCapacity           = 30,

  # 'auto' probes the vault and decides. 'keyvault' forces the vault path even
  # when it looks unreachable. 'direct' skips the vault entirely and passes
  # configuration to the container apps, with the sensitive values held as
  # Container Apps secrets. See docs/DEPLOY.md section 5.
  [ValidateSet('auto','keyvault','direct')]
  [string]$ConfigSource         = 'auto',

  # Sign-in. Set-CortexAuth.ps1 runs after provisioning unless -SkipAuth.
  # "alias=Entra group display name" entries map groups onto the names the
  # access rules use; -DefaultGroups is what every signed-in user is treated as.
  [string[]]$GroupMap           = @(),
  [string]$DefaultGroups        = 'all-staff',

  # Round 4: the sample-data account, the AI Search service and the state
  # share are created by default. -NoData / -NoSearch leave them out;
  # -NoScanWait starts the Purview scan and moves on rather than waiting.
  [switch]$NoData,
  [switch]$NoSearch,
  [ValidateSet('free','basic','standard')]
  [string]$SearchSku            = 'basic',
  [ValidateSet('all-staff','visibility')]
  [string]$ChatPolicy           = 'all-staff',
  [switch]$NoScanWait,

  # Round 6: the two storage accounts live inside a Network Security Perimeter
  # (the tenant's storage policy excludes NSP-configured resources), state is
  # blobs read with the managed identity, and bootstrap's storage-touching
  # section runs as a Container Apps job inside the perimeter. Step 7b checks
  # the accounts are SecuredByPerimeter and repairs them; a policy exemption
  # on the Cortex resource group is created as insurance unless
  # -NoPolicyExemption. -NoPerimeter switches the whole thing off.
  [switch]$NoPolicyExemption,
  [switch]$NoPerimeter,
  [ValidateSet('Enforced','Learning')]
  [string]$StorageAccessMode    = 'Enforced',
  [ValidateSet('Enforced','Learning')]
  [string]$SearchAccessMode     = 'Learning',

  # Round 5: the demo identities. -DemoIdentities creates the Entra groups the
  # access rules read, adds you to all of them and maps them; each
  # -DemoUserEmail is invited (or found) and put in the -DemoUserGroups only,
  # so the two accounts see different Marketplaces.
  [switch]$DemoIdentities,
  [string[]]$DemoUserEmail      = @(),
  [string[]]$DemoGroupMap       = @(
    'analysts=Cortex Analysts',
    'operations=Cortex Operations',
    'research=Cortex Research',
    'finance=Cortex Finance',
    'people=Cortex People',
    'cortex-redteam=Cortex Red Team Reviewers',
    'cortex-official-sensitive=Cortex Official-Sensitive'
  ),
  [string[]]$DemoUserGroups     = @('Cortex Analysts'),

  [switch]$WhatIfResources,
  [switch]$SkipProvision,
  [switch]$SkipBootstrap,
  [switch]$SkipAuth,
  [switch]$SkipHealthCheck,
  [switch]$AppOnly,
  [switch]$UpgradeModel,
  [switch]$ForceSeedKeyVault,
  [switch]$Reset
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Step($n,$t){ Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($t)     { Write-Host "  OK      $t" -ForegroundColor Green }
function Reuse($t)  { Write-Host "  REUSE   $t" -ForegroundColor Green }
function Create($t) { Write-Host "  CREATE  $t" -ForegroundColor Yellow }
function Keep($t)   { Write-Host "  KEEP    $t" -ForegroundColor DarkGray }
function Warn2($t)  { Write-Host "  WARN    $t" -ForegroundColor Yellow }
function Fail($t)   { Write-Host "  FAIL    $t" -ForegroundColor Red }
function Info($t)   { Write-Host "          $t" -ForegroundColor DarkGray }

# Run an az command and return parsed JSON, or $null when it fails. Never
# throws: every probe in this script is allowed to answer "no".
function Get-AzJson {
  param([string[]]$Arguments)
  $out = & az @Arguments 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  try { return ($out | ConvertFrom-Json) } catch { return $null }
}

# Does a resource exist? Returns $true/$false, never throws.
function Test-AzResource {
  param([string]$Rg, [string]$Name, [string]$Type)
  if (-not $Rg -or -not $Name) { return $false }
  $null = az resource show -g $Rg -n $Name --resource-type $Type 2>$null
  return ($LASTEXITCODE -eq 0)
}

# GET a JSON endpoint WITHOUT following redirects. When sign-in guards a machine
# path, Easy Auth answers 302 to login.microsoftonline.com; following that
# returns an HTML sign-in page, which used to read as "ok=false" for every check
# at once and point nowhere. Now it is named for what it is.
function Get-CortexJson {
  param([string]$Uri, [string]$Method = 'GET')
  try {
    $r = Invoke-WebRequest -Uri $Uri -Method $Method -MaximumRedirection 0 -SkipHttpErrorCheck -TimeoutSec 120 -ErrorAction Stop
  } catch {
    # The ingress holds a request open while a replica is still starting and
    # gives up after a couple of minutes — the browser's "stream timeout".
    # That is the platform, not the app, exactly like a 404 below.
    if ($_.Exception.Message -match 'timeout|timed out|canceled|cancelled') { return @{ ok = $false; notServing = $true; error = 'timed out — the app is not answering' } }
    return @{ ok = $false; error = $_.Exception.Message }
  }
  if ($r.StatusCode -in 301,302,303,307,308,401) { return @{ ok = $false; behindSignIn = $true; status = $r.StatusCode } }
  # A 404 or 5xx with a non-JSON body did not come from Cortex: the app answers
  # every health path with JSON. It is the platform answering for a revision
  # that is not serving — see Wait-CortexRevision.
  if ($r.StatusCode -in 404,502,503,504) { return @{ ok = $false; notServing = $true; status = $r.StatusCode; error = "HTTP $($r.StatusCode) from the platform — the app is not answering" } }
  try { $j = $r.Content | ConvertFrom-Json } catch { return @{ ok = $false; error = "not JSON (HTTP $($r.StatusCode))"; status = $r.StatusCode } }
  return @{ ok = [bool]$j.ok; json = $j; status = $r.StatusCode }
}

# Is the app's newest revision actually serving? `az containerapp show` reports
# the template happily while the revision behind it has failed — a volume that
# cannot be mounted, an image that cannot be pulled, a container that exits on
# start. The platform then answers 404 on every path, which reads like a
# routing fault and is not. This waits for a revision that is still coming up,
# restarts one that has failed (once, when asked), and reports what it saw.
function Wait-CortexRevision {
  param([string]$App, [string]$Rg, [int]$TimeoutSeconds = 150, [switch]$RestartIfFailed)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $restartedAt = $null
  $rev = ''; $health = ''; $running = ''; $prov = ''
  while ($true) {
    $live = Get-AzJson @('containerapp','show','-n',$App,'-g',$Rg,'-o','json')
    if (-not $live) { return @{ ok = $false; revision = ''; health = 'not found'; running = ''; provisioning = '' } }
    $rev = $live.properties.latestRevisionName
    $state = Get-AzJson @('containerapp','revision','show','-n',$App,'-g',$Rg,'--revision',$rev,'-o','json')
    $health  = "$($state.properties.healthState)"
    $running = "$($state.properties.runningState)"
    $prov    = "$($state.properties.provisioningState)"
    if ($running -in @('Running','RunningAtMaxScale','ScaledToZero') -and $health -ne 'Unhealthy' -and $prov -ne 'Failed') {
      return @{ ok = $true; revision = $rev; health = $health; running = $running; provisioning = $prov }
    }
    $failed = ($prov -eq 'Failed') -or ($running -in @('Failed','Degraded','Stopped')) -or ($health -eq 'Unhealthy')
    if ($failed) {
      if ($RestartIfFailed -and -not $restartedAt) {
        Warn2 "$App revision $rev is $running ($health). Restarting it once — the usual cure after a storage account has been repaired."
        az containerapp revision restart -n $App -g $Rg --revision $rev --only-show-errors -o none 2>$null
        $restartedAt = Get-Date
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
      } elseif (-not $restartedAt) {
        break   # nothing else to try
      } elseif (((Get-Date) - $restartedAt).TotalSeconds -gt 45) {
        break   # it was restarted and has failed again — final
      }
    }
    if ((Get-Date) -gt $deadline) { break }
    Start-Sleep -Seconds 10
  }
  return @{ ok = $false; revision = $rev; health = $health; running = $running; provisioning = $prov }
}

# Why is it not serving? The replica's container states carry the reason the
# revision cannot; the platform's system log carries the text (a mount that
# failed, an image pull that was refused). Both are printed so the cause is on
# screen rather than three portal blades away.
function Show-CortexRevisionFailure {
  param([string]$App, [string]$Rg, [hashtable]$Result)
  Fail "$App revision '$($Result.revision)' is not serving — provisioning: $($Result.provisioning), running: $($Result.running), health: $($Result.health)"
  if ($Result.revision) {
    $replicas = Get-AzJson @('containerapp','replica','list','-n',$App,'-g',$Rg,'--revision',$Result.revision,'-o','json')
    foreach ($r in @($replicas)) {
      foreach ($c in @($r.properties.containers)) {
        Info "replica $($r.name): container $($c.name) is $($c.runningState) (restarts: $($c.restartCount)) $($c.runningStateDetails)"
      }
    }
  }
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $raw = @(az containerapp logs show -n $App -g $Rg --type system --tail 60 --only-show-errors 2>$null)
  $ErrorActionPreference = $prev
  $lines = @()
  foreach ($l in $raw) {
    $text = $l
    try { $o = $l | ConvertFrom-Json; $text = "$($o.TimeStamp) $($o.Reason) $($o.Msg)$($o.Log)".Trim() } catch { }
    if ($text) { $lines += $text }
  }
  $telling = @($lines | Where-Object { $_ -match 'error|fail|mount|volume|unhealthy|backoff|pull|exit|denied|timeout|unauthori' })
  if ($telling.Count -eq 0) { $telling = @($lines | Select-Object -Last 8) }
  foreach ($l in ($telling | Select-Object -Last 12)) { Info "log: $l" }
  if (($telling -join ' ') -match 'mount|volume|azurefile|cifs|smb') {
    Warn2 'A revision is still trying to mount the old Azure Files state share. That share was replaced by blobs'
    Warn2 'in round 6 (the tenant policy disables account keys, so it could never mount here).'
    Info  'Re-provision so the template without the volume is applied:  .\scripts\Deploy-Cortex.ps1'
  }
  if (Test-CortexAuthSidecarBroken -App $App -Rg $Rg -Revision $Result.revision) {
    Warn2 'The sign-in sidecar (http-auth) cannot start: its client secret is missing from this revision''s'
    Warn2 'secrets. The app container itself is fine. Re-minting the secret gives the next revision a good one:'
    Info  '    .\scripts\Set-CortexAuth.ps1 -RotateSecret'
  }
}

# The Easy Auth sidecar reads the Entra client secret from the app's secrets.
# A revision whose http-auth container sits in CreateContainerConfigError has
# lost it — the web container runs, the platform never routes to the revision.
function Test-CortexAuthSidecarBroken {
  param([string]$App, [string]$Rg, [string]$Revision)
  if (-not $Revision) { return $false }
  $replicas = Get-AzJson @('containerapp','replica','list','-n',$App,'-g',$Rg,'--revision',$Revision,'-o','json')
  foreach ($r in @($replicas)) {
    foreach ($c in @($r.properties.containers)) {
      if ($c.name -eq 'http-auth' -and "$($c.runningStateDetails) $($c.runningState)" -match 'CreateContainerConfigError') { return $true }
    }
  }
  return $false
  Info "Everything the platform logged:  az containerapp logs show -n $App -g $Rg --type system --tail 100"
  Info "What the app itself logged:      az containerapp logs show -n $App -g $Rg --type console --tail 100"
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

  # Some `az containerapp job …` commands live in the containerapp EXTENSION,
  # not the core CLI. Without this, the first such command stops the script
  # with "Do you want to install it now? (Y/n)" — which is exactly what
  # swallowed the bootstrap job's log on the first perimeter run. Process
  # scope only: nothing is written to your CLI configuration.
  $env:AZURE_EXTENSION_USE_DYNAMIC_INSTALL = 'yes_without_prompt'
  $env:AZURE_EXTENSION_RUN_AFTER_DYNAMIC_INSTALL = 'true'
  Ok 'Azure CLI extensions install themselves when a command needs one'

  # THE MARK OF THE WEB. Files that arrive through OneDrive sync, a browser
  # download or an extracted zip carry a Zone.Identifier stream, and PowerShell's
  # default RemoteSigned policy then refuses to run them:
  #   "...is not digitally signed. You cannot run this script on the current system."
  # This script got past that or you would not be reading this — but the azd
  # pre-provision hook and the scripts this one calls may not have. That is what
  # failed the first full run: the hook was refused, azd cancelled its docker
  # builds, and those reported a missing imgId file. Unblock everything first.
  $marked = @(Get-ChildItem -Path $root -Recurse -Include *.ps1,*.psm1,*.psd1 -File |
              Where-Object { $_.FullName -notmatch '[\\/](node_modules|\.venv|\.git)[\\/]' } |
              Where-Object { Get-Item -Path $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue })
  if ($marked.Count -gt 0) {
    $marked | Unblock-File -ErrorAction SilentlyContinue
    Ok "Unblocked $($marked.Count) script(s) that carried the Mark of the Web"
  } else {
    Ok 'No script carries the Mark of the Web'
  }

  # Source files that have travelled through a chat or a transfer tool can come
  # back with anything shaped like a credential replaced by asterisks — this has
  # happened to this repository once. It parses, deploys, and then every call
  # to Azure is refused. Cheap to check, expensive to discover in production.
  $masked = Get-ChildItem -Path (Join-Path $root 'src'), (Join-Path $root 'scripts'), (Join-Path $root 'infra') -Recurse -Include *.js,*.ps1,*.bicep -File |
              Select-String -Pattern '[*]{6}' -List
  if ($masked) {
    foreach ($m in $masked) { Fail "$($m.Path):$($m.LineNumber) contains a masked value (a run of asterisks)" }
    throw 'Masked credential placeholders found in the source. Restore those lines from git before deploying.'
  }
  Ok 'No masked placeholders in the source'

  # Docker not running is the single most common local failure, and azd only
  # reports it once it has already spent minutes provisioning.
  $needsDocker = $AppOnly -or (-not $WhatIfResources -and -not $SkipProvision -and -not $Reset)
  if ($needsDocker) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
      throw 'docker is not installed or not on PATH. Images cannot be built. See the deployment guide, section 1.'
    }
    $null = docker info 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Docker is installed but not running. Start Docker Desktop and run this again.' }
    Ok 'Docker daemon responding'
  }

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

  # THE STALE-TOKEN TRAP. Directory calls made with a token the CLI cached
  # BEFORE your directory role changed are refused by continuous access
  # evaluation ("TokenCreatedWithOutdatedPolicies ... InteractionRequired"), and
  # the refusal reads like a missing permission. Only a fresh sign-in clears it.
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $whoami = (az ad signed-in-user show --query id -o tsv --only-show-errors 2>&1 | Out-String)
  $whoamiRc = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  $cae = 'TokenCreatedWithOutdatedPolicies|InteractionRequired|AADSTS50173|AADSTS53003|AADSTS50076'
  if ($whoamiRc -ne 0 -and $whoami -match $cae) {
    Warn2 'Your cached Azure CLI token predates a change to your directory roles, and Entra now refuses it.'
    Info  'Clearing the cached sign-in and signing you in again — pick your account in the window that opens.'
    # On Windows a plain `az login` can complete silently through the broker
    # and hand back the same revoked token, so clear first and, if it is still
    # refused, use the device-code flow, which always re-authenticates.
    az account clear --only-show-errors 2>$null | Out-Null
    az login --scope 'https://graph.microsoft.com//.default' --only-show-errors | Out-Null
    az account set --subscription $acct.id --only-show-errors | Out-Null
    $ErrorActionPreference = 'Continue'
    $whoami = (az ad signed-in-user show --query id -o tsv --only-show-errors 2>&1 | Out-String)
    $whoamiRc = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($whoamiRc -ne 0 -and $whoami -match $cae) {
      Warn2 'Still refused: Windows signed you in silently with the same token. Using the device-code flow — enter the code in your browser.'
      az login --use-device-code --scope 'https://graph.microsoft.com//.default'
      az account set --subscription $acct.id --only-show-errors | Out-Null
      $whoami = (az ad signed-in-user show --query id -o tsv --only-show-errors 2>$null)
      $whoamiRc = $LASTEXITCODE
    }
    if ($whoamiRc -ne 0) {
      throw "Entra keeps refusing the CLI's token. In a NEW terminal run:  az account clear; az login --use-device-code; az account set --subscription $($acct.id)   then run this script again."
    }
  }
  $signedInId = if ($whoamiRc -eq 0 -or $whoami) { "$whoami".Trim() } else { '' }
  if (-not $signedInId -or $signedInId -notmatch '^[0-9a-f-]{36}$') { $signedInId = $acct.user.name }

  # -------------------------------------------------------------- 3 reset
  # Deliberately narrow. It removes what Cortex created and the local azd
  # state, and nothing else — your APIM, Purview, Foundry, Key Vault,
  # registry and monitoring are shared and are never touched here.
  if ($Reset) {
    Step 3 'Reset'
    Warn2 "This deletes resource group $CortexResourceGroup and the local azd environment '$EnvironmentName'."
    Info  'It does NOT delete: the Key Vault secrets, the cortex product in APIM,'
    Info  'the role assignments for the Cortex identity, or the Purview domains'
    Info  'and data products created by bootstrap. Those are removed by hand.'
    $answer = Read-Host "Type the resource group name to confirm"
    if ($answer -ne $CortexResourceGroup) { throw 'Reset cancelled — the name did not match.' }

    if (Get-AzJson @('group','show','-n',$CortexResourceGroup)) {
      Write-Host '  Deleting resource group (this takes a few minutes)...'
      az group delete --name $CortexResourceGroup --yes | Out-Null
      Ok "Deleted $CortexResourceGroup"
    } else {
      Keep "$CortexResourceGroup does not exist"
    }

    $envDir = Join-Path $root ".azure/$EnvironmentName"
    if (Test-Path $envDir) { Remove-Item -Recurse -Force $envDir; Ok "Removed local environment '$EnvironmentName'" }
    Write-Host "`nReset complete. Run the script again to deploy from clean.`n" -ForegroundColor Cyan
    exit 0
  }

  # --------------------------------------------------------- 3b app only
  # Skips every check that only matters to infrastructure. Use after a code
  # change when nothing about the estate has moved.
  if ($AppOnly) {
    Step 3 'Deploying application code only'
    azd env select $EnvironmentName
    if ($LASTEXITCODE -ne 0) { throw "No azd environment named '$EnvironmentName'. Run without -AppOnly first." }
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
    azd deploy --no-prompt
    if ($LASTEXITCODE -ne 0) { throw 'azd deploy failed. See the output above.' }
    Ok 'Images built and pushed'
    # A pushed image is not a running app. Wait for the new revisions to serve
    # and say so — or say exactly why they do not.
    $broken = 0
    foreach ($app in @('cortex-web','cortex-purview-mcp')) {
      $rv = Wait-CortexRevision -App $app -Rg $CortexResourceGroup -TimeoutSeconds 180
      if ($rv.ok) { Ok "$app revision $($rv.revision) is serving" }
      else { $broken++; Show-CortexRevisionFailure -App $app -Rg $CortexResourceGroup -Result $rv }
    }
    Write-Host ''
    if ($broken) { throw "$broken container app(s) did not come up. Fix the cause above and run again." }
    exit 0
  }

  # ------------------------------------------------------- 4 probe estate
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

  # A resource group's location cannot be changed after creation. Reusing the
  # live one means a different -Location no longer wedges the deployment.
  $rgLocation = ''
  $existingRg = Get-AzJson @('group','show','-n',$CortexResourceGroup)
  if ($existingRg) {
    $rgLocation = $existingRg.location
    Reuse "Resource group   $CortexResourceGroup ($rgLocation)"
    if ($rgLocation -ne $Location) {
      Info "New resources go to $Location; the group itself stays in $rgLocation. This is fine."
    }
  } else {
    Create "Resource group   $CortexResourceGroup ($Location)"
  }
  Create "Container Apps   cortex-web, cortex-purview-mcp ($CortexResourceGroup)"
  Create "Managed identity id-$EnvironmentName ($CortexResourceGroup)"

  # ------------------------------------------------- 5 soft-deleted names
  # "A resource with this name already exists or is in a conflicting state"
  # is almost always a soft-deleted resource holding its name. Only relevant
  # where Cortex would create the resource itself.
  if (-not $found.KeyVault) {
    $deletedVault = @(Get-AzJson @('keyvault','list-deleted','--query',"[?name=='$KeyVaultName']"))
    if ($deletedVault.Count -gt 0) {
      Warn2 "Key Vault '$KeyVaultName' is soft-deleted and still holds its name."
      Info  "Recover it:  az keyvault recover --name $KeyVaultName"
      Info  "Or purge it: az keyvault purge --name $KeyVaultName   (destroys the secrets)"
      throw 'Resolve the soft-deleted Key Vault, then run this again.'
    }
  }
  if (-not $found.Foundry) {
    $deletedAi = @(Get-AzJson @('cognitiveservices','account','list-deleted','--query',"[?name=='$FoundryAccountName']"))
    if ($deletedAi.Count -gt 0) {
      Warn2 "Foundry account '$FoundryAccountName' is soft-deleted and still holds its name."
      Info  "Purge it: az cognitiveservices account purge -n $FoundryAccountName -g $FoundryResourceGroup -l <location>"
      throw 'Resolve the soft-deleted Foundry account, then run this again.'
    }
  }

  # ------------------------------------------------- 5b Key Vault reachability
  #
  # THE DISTINCTION THAT MATTERS HERE — data plane versus control plane.
  #
  # Key Vault firewall rules apply to the DATA plane only. A vault with
  # publicNetworkAccess = Disabled STILL accepts the secrets this template
  # writes, because an ARM deployment is a control-plane operation and the ARM
  # deployment service is on the Key Vault trusted-services list. What it
  # refuses is being READ over the public internet.
  #
  # Azure Container Apps is NOT on that trusted list. So a locked-down vault
  # seeds perfectly and is then unreadable by the running app: every secret
  # lookup fails, the app falls back to environment variables exactly as it was
  # designed to, and the marketplace is empty for reasons that look like an
  # application fault and are not.
  #
  # Rather than deploy something that cannot work, detect it and pass
  # configuration to the container apps directly instead.
  $seedKeyVault = $true
  $useKeyVault = $true
  if ($found.KeyVault) {
    $vault = Get-AzJson @('keyvault','show','-n',$KeyVaultName,'-g',$KeyVaultResourceGroup)
    if ($vault -and $vault.properties.enableRbacAuthorization -ne $true) {
      Warn2 "$KeyVaultName uses ACCESS POLICIES, not RBAC."
      Warn2 'The role assignment will be ignored. Either switch it to RBAC:'
      Write-Host "    az keyvault update -n $KeyVaultName -g $KeyVaultResourceGroup --enable-rbac-authorization true"
      Warn2 'or add an access policy for the Cortex identity after deployment.'
    }

    $publicAccess = if ($vault) { $vault.properties.publicNetworkAccess } else { '' }
    # Reads the vault the way the app will. -o none because a secret NAME is
    # not sensitive but there is no reason to print one either.
    az keyvault secret list --vault-name $KeyVaultName --maxresults 1 -o none 2>$null
    $dataPlaneReadable = ($LASTEXITCODE -eq 0)

    switch ($ConfigSource) {
      'keyvault' { $useKeyVault = $true;  Ok 'Configuration source: Key Vault (forced)' }
      'direct'   { $useKeyVault = $false; Ok 'Configuration source: passed directly to the apps (forced)' }
      default {
        if ($publicAccess -eq 'Disabled') {
          $useKeyVault = $false
          Warn2 "$KeyVaultName has public network access DISABLED."
          Info  'Container Apps is not a Key Vault trusted service, so the running app'
          Info  'cannot read it without a private endpoint. Configuration will be passed'
          Info  'to the container apps directly instead, and the sensitive values held as'
          Info  'Container Apps secrets. Override with -ConfigSource keyvault.'
        } elseif (-not $dataPlaneReadable) {
          $useKeyVault = $false
          Warn2 "$KeyVaultName did not answer a data-plane read from this machine."
          Info  'Either a firewall rule excludes you, or you lack Key Vault Secrets User.'
          Info  'Configuration will be passed to the container apps directly. If the app'
          Info  'itself can reach the vault, override with -ConfigSource keyvault.'
        } else {
          Ok 'Configuration source: Key Vault'
        }
      }
    }

    # Seeding is a control-plane write, so it is NOT blocked by the firewall
    # and is still worth doing — it keeps the vault as the record of the
    # deployment's configuration for when a private endpoint arrives. It is
    # skipped only when the deployment genuinely cannot write.
    if (-not $useKeyVault -and $publicAccess -eq 'Disabled') {
      Info  'The vault will still be seeded: ARM writes secrets through the control'
      Info  'plane, which the firewall does not restrict. The app just will not read it.'
    }

    # Seeding secrets needs Secrets Officer. Without it the whole deployment
    # fails on a step that is not load-bearing, so it is skipped instead —
    # the app falls back to environment variables and still starts.
    $vaultId = $vault.id
    $roles = Get-AzJson @('role','assignment','list','--assignee',$signedInId,'--scope',$vaultId,'--include-inherited','--query','[].roleDefinitionName')
    $canWrite = $false
    if ($roles) {
      foreach ($r in $roles) {
        if ($r -in @('Key Vault Secrets Officer','Key Vault Administrator','Owner','Contributor')) { $canWrite = $true }
      }
    }
    if (-not $canWrite -and -not $ForceSeedKeyVault) {
      $seedKeyVault = $false
      Warn2 "You do not hold Key Vault Secrets Officer on $KeyVaultName."
      Info  'Seeding is being SKIPPED so the deployment does not fail on it.'
      Info  "Grant the role and re-run, or force it with -ForceSeedKeyVault."
    } else {
      Ok "Key Vault seeding enabled"
    }

    # Several azd environments can share one vault, in which case the last
    # one provisioned quietly owns every value in it. Only checkable when the
    # data plane answers — it is a secret read like any other.
    $owner = if ($dataPlaneReadable) {
      az keyvault secret show --vault-name $KeyVaultName --name cortex-environment-name --query value -o tsv 2>$null
    } else { $null }
    if ($owner -and $owner -ne $EnvironmentName) {
      Warn2 "$KeyVaultName currently holds the configuration for environment '$owner'."
      Info  "Provisioning '$EnvironmentName' will overwrite it. Both environments cannot share one vault."
    }
  }

  # Pushing images needs AcrPush on the registry. Warned, not blocked —
  # admin credentials or a broader inherited role may still cover it.
  if ($found.Registry) {
    $acr = Get-AzJson @('acr','show','-n',$RegistryName,'-g',$RegistryResourceGroup)
    if ($acr) {
      $acrRoles = Get-AzJson @('role','assignment','list','--assignee',$signedInId,'--scope',$acr.id,'--include-inherited','--query','[].roleDefinitionName')
      $canPush = $false
      if ($acrRoles) {
        foreach ($r in $acrRoles) {
          if ($r -in @('AcrPush','Contributor','Owner')) { $canPush = $true }
        }
      }
      if (-not $canPush) {
        Warn2 "No AcrPush on $RegistryName was found for you. The deploy step may fail to push images."
        Info  "Fix: az role assignment create --assignee $signedInId --role AcrPush --scope $($acr.id)"
      }
    }
  }

  # ------------------------------------------------------- 6 model checks
  # THE FAILURE THIS SCRIPT EXISTS TO PREVENT.
  Step 4 'Checking the model is deployable'

  $effectiveDeploymentName = if ($ModelDeploymentName) { $ModelDeploymentName } else { $ModelName }
  $effectiveVersion = $ModelVersion
  # A separate variable, not $ModelSku: the parameter carries a ValidateSet,
  # and reassigning it to a sku the account reports would re-run validation
  # and throw on anything outside that set.
  $effectiveSku = $ModelSku
  $deployModel = $false

  if ($found.Foundry) {
    $catalogue = Get-AzJson @('cognitiveservices','account','list-models','-g',$FoundryResourceGroup,'-n',$FoundryAccountName)
    if (-not $catalogue) {
      Warn2 'Could not read the model catalogue for this account. Skipping validation.'
      Info  'If provisioning fails with ServiceModelDeprecating, the pinned version is no longer deployable.'
    } else {
      $candidates = @($catalogue | Where-Object { $_.name -eq $ModelName })
      if (-not $candidates -or $candidates.Count -eq 0) {
        $names = ($catalogue | Select-Object -ExpandProperty name -Unique | Sort-Object) -join ', '
        throw "Model '$ModelName' is not offered by $FoundryAccountName in its region. Available: $names"
      }

      # Deprecating and Deprecated both refuse NEW deployments. This is the
      # exact state gpt-4o-mini 2024-07-18 is in.
      $usable = @($candidates | Where-Object { $_.lifecycleStatus -notin @('Deprecating','Deprecated','Retired') })
      $exact  = @($usable | Where-Object { $_.version -eq $effectiveVersion })

      if ($exact.Count -eq 0) {
        $blocked = @($candidates | Where-Object { $_.version -eq $effectiveVersion })
        if ($blocked.Count -gt 0) {
          Warn2 "$ModelName $effectiveVersion is '$($blocked[0].lifecycleStatus)' and cannot be used for new deployments."
        } else {
          Warn2 "$ModelName $effectiveVersion is not offered by this account."
        }
        if ($usable.Count -eq 0) {
          $all = ($candidates | ForEach-Object { "$($_.version) [$($_.lifecycleStatus)]" }) -join ', '
          throw "No deployable version of '$ModelName' on $FoundryAccountName. Versions seen: $all"
        }
        $effectiveVersion = (($usable | Sort-Object version -Descending) | Select-Object -First 1).version
        Warn2 "Falling back to the newest deployable version: $effectiveVersion"
        Info  "Pin it with -ModelVersion $effectiveVersion to make this explicit."
      } else {
        Ok "$ModelName $effectiveVersion is deployable ($($exact[0].lifecycleStatus))"
      }

      # The sku has to be offered for that version, or the deployment is
      # rejected with a message about capacity rather than about the sku.
      $chosen = @($catalogue | Where-Object { $_.name -eq $ModelName -and $_.version -eq $effectiveVersion })
      if ($chosen.Count -gt 0 -and $chosen[0].skus) {
        $skuNames = @($chosen[0].skus | ForEach-Object { $_.name })
        if ($skuNames.Count -gt 0 -and $effectiveSku -notin $skuNames) {
          Warn2 "$effectiveSku is not offered for $ModelName $effectiveVersion. Offered: $($skuNames -join ', ')"
          $effectiveSku = $skuNames[0]
          Warn2 "Using $effectiveSku instead."
        }
      }
    }

    # What is already deployed?
    $existingDeployment = Get-AzJson @('cognitiveservices','account','deployment','show','-g',$FoundryResourceGroup,'-n',$FoundryAccountName,'--deployment-name',$effectiveDeploymentName)
    if ($existingDeployment) {
      $liveName = $existingDeployment.properties.model.name
      $liveVer  = $existingDeployment.properties.model.version
      if ($liveName -eq $ModelName -and $liveVer -eq $effectiveVersion) {
        Keep "Deployment '$effectiveDeploymentName' already runs $liveName $liveVer — left alone"
      } elseif ($UpgradeModel) {
        Warn2 "Deployment '$effectiveDeploymentName' runs $liveName $liveVer. Upgrading to $ModelName $effectiveVersion."
        $deployModel = $true
      } else {
        Warn2 "Deployment '$effectiveDeploymentName' runs $liveName $liveVer, not $ModelName $effectiveVersion."
        Info  'Left as-is. Re-run with -UpgradeModel to move it, which replaces the deployment in place.'
      }
    } else {
      Create "Model deployment '$effectiveDeploymentName' ($ModelName $effectiveVersion, $effectiveSku)"
      $deployModel = $true
    }
  }

  if ($WhatIfResources) {
    Write-Host "`nNothing was changed. Remove -WhatIfResources to deploy.`n" -ForegroundColor Cyan
    exit 0
  }

  # ---------------------------------------------------------- 7 providers
  Step 5 'Registering resource providers'
  foreach ($p in @('Microsoft.App','Microsoft.OperationalInsights','Microsoft.ManagedIdentity','Microsoft.ContainerRegistry')) {
    az provider register --namespace $p --only-show-errors | Out-Null
  }
  Ok 'Registered'

  # ------------------------------------------------------------ 8 install
  Step 6 'Installing dependencies and vendoring GOV.UK Frontend'
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
  Ok 'Installed'

  # ---------------------------------------------------------- 9 provision
  if (-not $SkipProvision) {
    Step 7 'Provisioning'

    # `azd env new` fails when the environment already exists. Checking first
    # keeps a genuine failure visible instead of swallowing it.
    $envExists = $false
    $envList = azd env list --output json 2>$null | ConvertFrom-Json
    if ($envList) { $envExists = [bool](@($envList | Where-Object { $_.Name -eq $EnvironmentName }).Count) }

    if (-not $envExists) {
      azd env new $EnvironmentName --location $Location --subscription $acct.id
      if ($LASTEXITCODE -ne 0) { throw "Could not create the azd environment '$EnvironmentName'." }
      Ok "Created environment '$EnvironmentName'"
    } else {
      Keep "Environment '$EnvironmentName' already exists"
    }
    azd env select $EnvironmentName | Out-Null

    # Read what azd already knows before writing anything, so the values azd
    # owns — chiefly the pushed image names — are never clobbered.
    $current = @{}
    azd env get-values | ForEach-Object { if ($_ -match '^(\w+)="?([^"]*)"?$') { $current[$Matches[1]] = $Matches[2] } }

    # A fresh clone has no record of the images, but the apps may still be
    # running the real ones. Read them off the live apps so provisioning
    # cannot roll the deployment back to the placeholder.
    foreach ($svc in @(@{ App='cortex-web'; Var='SERVICE_WEB_IMAGE_NAME' },
                       @{ App='cortex-purview-mcp'; Var='SERVICE_PURVIEW_MCP_IMAGE_NAME' })) {
      if (-not $current[$svc.Var]) {
        $liveImage = az containerapp show -n $svc.App -g $CortexResourceGroup `
                       --query 'properties.template.containers[0].image' -o tsv 2>$null
        if ($liveImage -and $liveImage -notmatch 'k8se/quickstart') {
          azd env set $svc.Var $liveImage | Out-Null
          Keep "$($svc.App) keeps its current image"
        }
      } else {
        Keep "$($svc.App) keeps $($current[$svc.Var])"
      }
    }

    $settings = @{
      AZURE_LOCATION                = $Location
      CORTEX_RESOURCE_GROUP         = $CortexResourceGroup
      # Never empty: an empty native argument is dropped by the shell, and the
      # group's own location must be a real region either way.
      CORTEX_RESOURCE_GROUP_LOCATION= $(if ($rgLocation) { $rgLocation } else { $Location })
      APIM_NAME                     = $ApimName
      APIM_RG                       = $ApimResourceGroup
      CREATE_APIM                   = (-not $found.Apim).ToString().ToLower()
      PURVIEW_NAME                  = $PurviewName
      PURVIEW_RG                    = $PurviewResourceGroup
      CREATE_PURVIEW                = (-not $found.Purview).ToString().ToLower()
      FOUNDRY_ACCOUNT               = $FoundryAccountName
      FOUNDRY_PROJECT               = $FoundryProjectName
      FOUNDRY_RG                    = $FoundryResourceGroup
      CREATE_FOUNDRY                = (-not $found.Foundry).ToString().ToLower()
      CREATE_MODEL_DEPLOYMENT       = $deployModel.ToString().ToLower()
      MODEL_NAME                    = $ModelName
      MODEL_VERSION                 = $effectiveVersion
      MODEL_DEPLOYMENT_NAME         = $effectiveDeploymentName
      MODEL_SKU                     = $effectiveSku
      MODEL_CAPACITY                = $ModelCapacity.ToString()
      KEYVAULT_NAME                 = $KeyVaultName
      KEYVAULT_RG                   = $KeyVaultResourceGroup
      CREATE_KEYVAULT               = (-not $found.KeyVault).ToString().ToLower()
      SEED_KEYVAULT                 = $seedKeyVault.ToString().ToLower()
      USE_KEYVAULT                  = $useKeyVault.ToString().ToLower()
      REGISTRY_NAME                 = $RegistryName
      REGISTRY_RG                   = $RegistryResourceGroup
      CREATE_REGISTRY               = (-not $found.Registry).ToString().ToLower()
      LOG_ANALYTICS_NAME            = $LogAnalyticsName
      APP_INSIGHTS_NAME             = $AppInsightsName
      MONITORING_RG                 = $MonitoringResourceGroup
      CREATE_MONITORING             = (-not $found.Monitoring).ToString().ToLower()
      APIM_PUBLISHER_EMAIL          = $acct.user.name
      # Round 4
      CREATE_DATA                   = (-not $NoData).ToString().ToLower()
      CREATE_SEARCH                 = (-not $NoSearch).ToString().ToLower()
      SEARCH_SKU                    = $SearchSku
      CORTEX_CHAT_POLICY            = $ChatPolicy
      # Round 6
      CREATE_PERIMETER              = (-not $NoPerimeter).ToString().ToLower()
      STORAGE_ACCESS_MODE           = $StorageAccessMode
      SEARCH_ACCESS_MODE            = $SearchAccessMode
      # Enabled on the first run (the perimeter association cannot exist before
      # the account does); SecuredByPerimeter once step 7b has confirmed the
      # association and recorded the value. Never downgraded here.
      STORAGE_PUBLIC_NETWORK_ACCESS = $(if (-not $NoPerimeter -and $current['STORAGE_PUBLIC_NETWORK_ACCESS'] -eq 'SecuredByPerimeter') { 'SecuredByPerimeter' } else { 'Enabled' })
    }
    if ($NoPerimeter) { Warn2 'No perimeter (-NoPerimeter): in this tenant the storage policy will close both accounts and nothing can write to them.' }
    # Who is deploying, so the template can grant Storage Blob Data
    # Contributor on the sample-data account: bootstrap uploads as you, and an
    # Owner still cannot write a blob without a data-plane role.
    $me = az ad signed-in-user show --query id -o tsv 2>$null
    if ($me) { $settings['DEPLOYER_PRINCIPAL_ID'] = $me } else { Warn2 'Could not read your object id; bootstrap may be refused when uploading sample data.' }
    foreach ($k in $settings.Keys) { azd env set $k $settings[$k] | Out-Null }

    azd up --no-prompt
    if ($LASTEXITCODE -ne 0) {
      Fail 'azd up failed.'
      Write-Host ''
      Write-Host '  Most likely causes, in the order worth checking:' -ForegroundColor Yellow
      Write-Host '   * "is not digitally signed" on Preprovision-Check.ps1 — a script carried the Mark of the Web.'
      Write-Host '       This script now unblocks them at step 1 and the hook runs with -ExecutionPolicy Bypass. Re-run.'
      Write-Host '   * "imgId: The system cannot find the file specified" — the docker build was CANCELLED because'
      Write-Host '       another step failed (usually the one above). It is not a Docker fault. Fix that step, re-run.'
      Write-Host '   * ServiceModelDeprecating — the pinned model version is no longer deployable.'
      Write-Host "       .\scripts\Deploy-Cortex.ps1 -WhatIfResources   shows what the account will accept."
      Write-Host '   * AuthorizationFailed on a role assignment — you lack User Access Administrator.'
      Write-Host '       Ask your admin, then re-run with -SkipProvision to finish the rest.'
      Write-Host '   * A name in a conflicting state — check for soft-deleted resources in the portal.'
      Write-Host '   * Quota — the model sku or capacity is not available in that region.'
      Write-Host ''
      Write-Host '  Nothing here is destructive. Fix the cause and run the same command again.' -ForegroundColor Yellow
      Write-Host ''
      throw 'azd up failed. See the output above.'
    }
    Ok 'Provisioned and deployed'
  } else {
    Step 7 'Skipping provisioning'
    azd env select $EnvironmentName | Out-Null
  }

  # -------------------------------------------------------------- 10 values
  $v = @{}
  azd env get-values | ForEach-Object { if ($_ -match '^(\w+)="?([^"]*)"?$') { $v[$Matches[1]] = $Matches[2] } }
  $kv     = $v['KEYVAULT_NAME']
  $kvRg   = $v['KEYVAULT_RESOURCE_GROUP']
  $webUrl = $v['CORTEX_WEB_URL']
  $mcpUrl = $v['CORTEX_MCP_URL']
  $apim   = $v['APIM_SERVICE_NAME']
  $apimRg = $v['APIM_RESOURCE_GROUP']

  # Read back from the deployment output rather than the local variable, so a
  # -SkipProvision run still knows which mode the deployed app is actually in.
  $configSource = $v['CORTEX_CONFIG_SOURCE']
  if (-not $configSource) { $configSource = if ($useKeyVault) { 'keyvault' } else { 'direct' } }
  Ok "Configuration source: $configSource"

  # Everything that goes wrong from here is collected and reported honestly at
  # the end. A deployment with a container app that is not serving used to
  # finish with a green "Cortex is deployed" — that is the one thing this
  # script must never do again.
  $problems = @()

  # --------------------------------------------------- 7b storage and perimeter
  #
  # THE TENANT-POLICY TRAP, AND ITS ANSWER. The tenant's SFI policy (a Modify
  # effect at management-group scope) closes the public endpoint on every
  # storage account and disables account keys — "excluding NSP configured
  # resources". The first live run showed both halves: bootstrap refused with
  # "403 AuthorizationFailure" (the network code), and cortex-web never
  # starting because its Azure Files share could not be mounted with a key.
  # Round 6 answers it the way the policy names: both accounts are inside a
  # Network Security Perimeter with public network access SecuredByPerimeter,
  # state is blobs read with the managed identity, and the storage-touching
  # bootstrap section runs as a job inside Azure (step 11). This step checks
  # the accounts are in that state, repairs them when the policy has been at
  # work, and keeps a policy exemption on the resource group as insurance.
  $storageRepaired = $false
  $perimeter = if ($NoPerimeter) { '' } else { $v['NSP_NAME'] }
  if ($v['DATA_STORAGE_ACCOUNT'] -or $v['STATE_STORAGE_ACCOUNT']) {
    Step '7b' $(if ($perimeter) { "Checking the storage accounts are secured by perimeter $perimeter" } else { 'Checking a tenant policy has not locked the storage accounts' })
    $saArgs = @{ EnvironmentName = $EnvironmentName; ResourceGroup = $CortexResourceGroup; Perimeter = $perimeter; Quiet = $true }
    if ($v['DATA_STORAGE_ACCOUNT'])  { $saArgs.DataAccount  = $v['DATA_STORAGE_ACCOUNT'] }
    if ($v['STATE_STORAGE_ACCOUNT']) { $saArgs.StateAccount = $v['STATE_STORAGE_ACCOUNT'] }
    if ($NoPolicyExemption) { $saArgs.NoExemption = $true }
    $prevEap2 = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & (Join-Path $root 'scripts/Set-CortexStorageAccess.ps1') @saArgs
    $saRc = $LASTEXITCODE
    $ErrorActionPreference = $prevEap2
    switch ($saRc) {
      0 { Ok $(if ($perimeter) { 'Both storage accounts are inside the perimeter and secured by it' } else { 'Both storage accounts are reachable over their public endpoint' }) }
      2 { $storageRepaired = $true; Ok 'Storage access repaired' }
      default {
        $problems += 'a storage account is not in the state the perimeter needs (see step 7b)'
        Warn2 'Storage access could not be fully repaired. The bootstrap job and the state blobs will fail until it is.'
      }
    }

    # Round 4 left an environment-level Azure Files definition behind. The
    # template no longer mounts it; the definition is harmless but points at a
    # key that the policy has revoked, so tidy it away.
    $envName = $v['CORTEX_CONTAINER_ENVIRONMENT']
    if ($envName) {
      $oldShare = Get-AzJson @('containerapp','env','storage','show','-n',$envName,'-g',$CortexResourceGroup,'--storage-name','cortex-state')
      if ($oldShare) {
        az containerapp env storage remove -n $envName -g $CortexResourceGroup --storage-name cortex-state --yes --only-show-errors -o none 2>$null
        if ($LASTEXITCODE -eq 0) { Ok 'Removed the round-4 file-share definition from the environment (state is blobs now)' }
      }
    }
  }

  # A partly-finished provision leaves the outputs absent. Saying so plainly
  # beats five confusing failures in the steps that follow.
  if (-not $webUrl) {
    Warn2 'Provisioning did not publish its outputs, so the deployment is incomplete.'
    Info  'Everything above this point succeeded and is safe to re-run.'
    Info  "Run:  .\scripts\Deploy-Cortex.ps1"
    throw 'Incomplete deployment — no web URL was published.'
  }

  # --------------------------------------------------- 8 reconcile the apps
  # WHY THIS EXISTS
  # `azd deploy` updates the container image and nothing else. Anything else
  # about the app was written during provisioning, while the placeholder image
  # was still running, and is never revisited. If those two disagree — most
  # obviously the ingress port — the app is unreachable and the symptom is the
  # Container Apps welcome page or a 502, neither of which points at the cause.
  #
  # So after deploying, check the live apps against what they should be and
  # correct them in place. This also repairs a deployment that is already in
  # that state, without a re-provision.
  Step 8 'Reconciling the container apps'
  $appPort = 3000
  foreach ($app in @('cortex-web','cortex-purview-mcp')) {
    $live = Get-AzJson @('containerapp','show','-n',$app,'-g',$CortexResourceGroup)
    if (-not $live) { Warn2 "$app not found in $CortexResourceGroup"; continue }

    $image = $live.properties.template.containers[0].image
    $port  = $live.properties.configuration.ingress.targetPort

    if ($image -match 'k8se/quickstart') {
      Warn2 "$app is still running the placeholder image."
      Info  'Its code was never pushed. Build and push it with:'
      Info  "    .\scripts\Deploy-Cortex.ps1 -AppOnly"
      $problems += "$app is still on the placeholder image"
      continue
    } else {
      Ok "$app runs $image"
    }

    if ($port -ne $appPort) {
      Warn2 "$app ingress points at port $port but Cortex listens on $appPort. Correcting."
      az containerapp ingress update -n $app -g $CortexResourceGroup --target-port $appPort --only-show-errors | Out-Null
      if ($LASTEXITCODE -eq 0) { Ok "$app ingress now targets $appPort" }
      else { Fail "Could not update ingress on $app. Fix by hand: az containerapp ingress update -n $app -g $CortexResourceGroup --target-port $appPort" }
    }

    # The template can say one thing and the revision another. This is the
    # check that was missing when cortex-web answered 404 on every path while
    # the script reported it as running: the revision had never come up.
    $rv = Wait-CortexRevision -App $app -Rg $CortexResourceGroup -RestartIfFailed
    if ($rv.ok) {
      Ok "$app revision $($rv.revision) is serving ($($rv.running), $($rv.health))"
    } else {
      Show-CortexRevisionFailure -App $app -Rg $CortexResourceGroup -Result $rv
      $problems += "$app is not serving (revision $($rv.revision): $($rv.running), $($rv.health))"
    }
  }

  # ------------------------------------------------------------ 11 secrets
  #
  # WHERE THE APIM KEY GOES, AND WHY IT IS NOT A BICEP PARAMETER.
  #
  # Reading the key is a control-plane call against API Management, so it works
  # regardless of the Key Vault firewall. Writing it is the part that has to
  # adapt:
  #
  #   Key Vault mode — write it to the vault, as before.
  #   Direct mode    — write it as a Container Apps secret on cortex-web.
  #
  # It is set here rather than passed through Bicep on purpose. azd sources
  # template parameters from .azure/<env>/.env, so a credential passed that way
  # is written to disk in plaintext. Setting it on the app afterwards keeps it
  # out of the repo, out of the azd environment file, and out of the deployment
  # history.
  #
  # The cost of that choice: a bare `azd provision` that bypasses this script
  # may drop the secret. That is why this step runs on every deployment and
  # re-asserts it, and why it is cheap to re-run.
  Step 9 'Onboarding the APIM subscription key'

  $apimKey = $null
  if ($apim -and $apimRg) {
    $apimKey = az rest --method POST --url ("https://management.azure.com/subscriptions/{0}/resourceGroups/{1}/providers/Microsoft.ApiManagement/service/{2}/subscriptions/master/listSecrets?api-version=2024-05-01" -f $acct.id, $apimRg, $apim) `
                 --query primaryKey -o tsv 2>$null
    if (-not $apimKey) {
      Warn2 'Could not read the APIM subscription key from API Management.'
      Info  'You may lack rights on the APIM instance. Published MCP servers will not authenticate until it is set.'
    }
  }

  if ($configSource -eq 'keyvault') {
    if (-not $kv) {
      Warn2 'No Key Vault name in the environment. Skipping.'
    } else {
      $existing = az keyvault secret show --vault-name $kv --name apim-subscription-key --query value -o tsv 2>$null
      if ($existing) {
        Ok 'apim-subscription-key already onboarded'
      } elseif ($apimKey) {
        az keyvault secret set --vault-name $kv --name apim-subscription-key --value $apimKey --only-show-errors | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok 'Onboarded from API Management' }
        else {
          Warn2 'Could not write the key to the vault — you likely lack Key Vault Secrets Officer,'
          Warn2 'or the vault refuses data-plane writes from here. Set it by hand:'
          Write-Host "    az keyvault secret set --vault-name $kv --name apim-subscription-key --value '<key>'"
        }
      }
    }
  }
  else {
    # Direct mode. The secret lives on the container app.
    if (-not $apimKey) {
      Warn2 'No APIM key to set. Skipping.'
    } else {
      # Compare before writing. Setting an identical secret still creates a new
      # revision, and a new revision on every deploy is churn nobody asked for.
      $currentKey = az containerapp secret show -n 'cortex-web' -g $CortexResourceGroup `
                      --secret-name 'apim-subscription-key' --query value -o tsv 2>$null

      if ($currentKey -eq $apimKey) {
        Ok 'apim-subscription-key already set on cortex-web'
      } else {
        az containerapp secret set -n 'cortex-web' -g $CortexResourceGroup `
          --secrets "apim-subscription-key=$apimKey" --only-show-errors | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok 'apim-subscription-key stored as a Container Apps secret' }
        else { Fail 'Could not set the secret on cortex-web.' }
      }

      # The env var has to reference the secret, or the app never reads it.
      $envRef = az containerapp show -n 'cortex-web' -g $CortexResourceGroup `
                  --query "properties.template.containers[0].env[?name=='APIM_SUBSCRIPTION_KEY'].secretRef | [0]" -o tsv 2>$null
      if ($envRef -ne 'apim-subscription-key') {
        az containerapp update -n 'cortex-web' -g $CortexResourceGroup `
          --set-env-vars 'APIM_SUBSCRIPTION_KEY=secretref:apim-subscription-key' --only-show-errors | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok 'cortex-web reads APIM_SUBSCRIPTION_KEY from that secret' }
        else { Fail 'Could not map APIM_SUBSCRIPTION_KEY on cortex-web.' }
      }

      # The bootstrap job runs bootstrap.js, for which the key is required
      # configuration. Same secret, same reference, on the job.
      $job = $v['CORTEX_BOOTSTRAP_JOB']
      if ($job) {
        $jobKey = az containerapp job secret show -n $job -g $CortexResourceGroup --secret-name 'apim-subscription-key' --query value -o tsv 2>$null
        if ($jobKey -ne $apimKey) {
          az containerapp job secret set -n $job -g $CortexResourceGroup --secrets "apim-subscription-key=$apimKey" --only-show-errors -o none 2>$null
          if ($LASTEXITCODE -eq 0) { Ok "apim-subscription-key stored on the bootstrap job $job" } else { Fail "Could not set the secret on $job." }
        }
        $jobRef = az containerapp job show -n $job -g $CortexResourceGroup `
                    --query "properties.template.containers[0].env[?name=='APIM_SUBSCRIPTION_KEY'].secretRef | [0]" -o tsv 2>$null
        if ($jobRef -ne 'apim-subscription-key') {
          az containerapp job update -n $job -g $CortexResourceGroup `
            --set-env-vars 'APIM_SUBSCRIPTION_KEY=secretref:apim-subscription-key' --only-show-errors -o none 2>$null
          if ($LASTEXITCODE -eq 0) { Ok "$job reads APIM_SUBSCRIPTION_KEY from that secret" } else { Fail "Could not map APIM_SUBSCRIPTION_KEY on $job." }
        }
      }
    }

    # App Insights is optional, and its connection string embeds an
    # instrumentation key, so it gets the same treatment rather than being a
    # plain environment variable.
    $aiConn = az monitor app-insights component show -g $MonitoringResourceGroup -a $AppInsightsName `
                --query connectionString -o tsv 2>$null
    if ($aiConn) {
      $currentAi = az containerapp secret show -n 'cortex-web' -g $CortexResourceGroup `
                     --secret-name 'appinsights-connection-string' --query value -o tsv 2>$null
      if ($currentAi -ne $aiConn) {
        az containerapp secret set -n 'cortex-web' -g $CortexResourceGroup `
          --secrets "appinsights-connection-string=$aiConn" --only-show-errors | Out-Null
        az containerapp update -n 'cortex-web' -g $CortexResourceGroup `
          --set-env-vars 'APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:appinsights-connection-string' --only-show-errors | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok 'App Insights connection string stored as a Container Apps secret' }
      } else {
        Ok 'App Insights connection string already set'
      }
    }
  }

  # ------------------------------------------------------------ 11b sign-in
  #
  # Entra sign-in, WITH the groups claim, plus the group mapping and the
  # default group. All idempotent, all in Set-CortexAuth.ps1 so it can also be
  # run on its own when the mapping changes. Container Apps authentication is
  # outside the Bicep, so this survives a re-provision either way.
  if (-not $SkipAuth) {
    Step 10 'Switching on Entra sign-in with the groups claim'
    $authArgs = @{ EnvironmentName = $EnvironmentName; DefaultGroups = $DefaultGroups; Quiet = $true }
    if ($GroupMap.Count -gt 0) { $authArgs.GroupMap = $GroupMap }
    & (Join-Path $root 'scripts/Set-CortexAuth.ps1') @authArgs
    if ($LASTEXITCODE -ne 0) {
      Warn2 'Sign-in could not be configured. The app will show "Sign-in is not configured" until it is.'
      Info  'Re-run by hand:  .\scripts\Set-CortexAuth.ps1'
      $problems += 'sign-in could not be configured (step 10)'
    } else { Ok 'Sign-in configured' }

    # ------------------------------------------------- 10b demo identities
    #
    # "The same page through different eyes" needs two accounts in different
    # groups. The groups are the ones the bootstrap content's access rules
    # already name (analysts, waste-crime, ne-evidence, ea-flood-risk, and the
    # Official-Sensitive clearance), so no content changes: you are put in all
    # of them and see everything; each demo user is put in -DemoUserGroups
    # only and sees the "Open to all staff" entries plus what those groups
    # unlock. Idempotent — existing groups and members are left alone.
    if ($DemoIdentities) {
      Step '10b' 'Setting up the demo identities'
      $demoArgs = @{ EnvironmentName = $EnvironmentName; DefaultGroups = $DefaultGroups; GroupMap = $DemoGroupMap; CreateGroups = $true; Quiet = $true }
      & (Join-Path $root 'scripts/Set-CortexAuth.ps1') @demoArgs
      if ($LASTEXITCODE -ne 0) {
        Warn2 'The demo groups could not all be created or mapped. Re-run by hand:'
        Info  "    .\scripts\Set-CortexAuth.ps1 -CreateGroups -GroupMap '$($DemoGroupMap -join "','")'"
        $problems += 'demo groups not fully set up (step 10b)'
      } else { Ok "Demo groups created, mapped, and you are a member of all $($DemoGroupMap.Count)" }
      foreach ($email in $DemoUserEmail) {
        & (Join-Path $root 'scripts/Add-CortexUser.ps1') -Email $email -Groups $DemoUserGroups -EnvironmentName $EnvironmentName
        if ($LASTEXITCODE -ne 0) {
          Warn2 "$email could not be added. Re-run by hand:  .\scripts\Add-CortexUser.ps1 -Email $email -Groups '$($DemoUserGroups -join "','")'"
          $problems += "demo user $email not added (step 10b)"
        } else { Ok "$email is in: $($DemoUserGroups -join ', ') (and all-staff, like everyone signed in)" }
      }
      if ($DemoUserEmail.Count -eq 0) {
        Info 'No -DemoUserEmail given. Invite the second account later with:'
        Info "    .\scripts\Add-CortexUser.ps1 -Email <address> -Groups '$($DemoUserGroups -join "','")'"
      }
      Info 'Anyone who signed in before the groups existed must sign out and in again to pick them up.'
    }
  } else {
    Step 10 'Skipping sign-in configuration'
    if ($DemoIdentities) { Warn2 '-DemoIdentities needs sign-in; run without -SkipAuth to set the demo groups up.' }
  }

  # ---------------------------------------------------------- 12 bootstrap
  #
  # BOOTSTRAP RUNS HERE, NOT IN THE CONTAINER.
  #
  # bootstrap.js reads configuration the same way the app does: Key Vault
  # first, environment second. The deployed apps get their configuration from
  # provisioning, but this is a local Node process — it has neither. When the
  # vault is unreachable from this machine (public network access disabled,
  # and a read is a data-plane operation) every required value resolves to
  # nothing and bootstrap exits with "Missing required configuration".
  #
  # So the values are put into the environment before the child process
  # starts. `$env:` here is inherited by npm, which is exactly what is wanted;
  # nothing is written to disk.
  if (-not $SkipBootstrap) {
    Step 11 'Granting Purview access, creating neutral demo content, sample data and indexes'
    Info 'The roles are granted with YOUR signed-in account through the Unified Catalog Policies API.'
    Info 'If Purview refuses you (403), add yourself as a Data Governance Administrator in the'
    Info 'Purview portal (Settings → Solution settings → Unified Catalog → Roles and permissions).'
    Info 'Then: Foundry connections for every MCP server, sample files into storage, a Data Map scan'
    Info '(3–10 minutes — bootstrap waits unless -NoScanWait), assets attached to the products, one'
    Info 'AI Search index per product. Every section is idempotent and can be re-run on its own.'

    # The app's azure-resource-group is the group holding API MANAGEMENT — it
    # exists to build APIM ARM resource ids. Not the Cortex group, which is
    # what the azd output called AZURE_RESOURCE_GROUP holds.
    $env:AZURE_SUBSCRIPTION_ID    = $acct.id
    $env:AZURE_RESOURCE_GROUP     = $apimRg
    $env:APIM_SERVICE_NAME        = $apim
    $env:APIM_GATEWAY_URL         = $v['APIM_GATEWAY_URL']
    $env:FOUNDRY_PROJECT_ENDPOINT = $v['FOUNDRY_PROJECT_ENDPOINT']
    $env:PUBLIC_BASE_URL          = $webUrl
    $env:PURVIEW_MCP_URL          = if ($mcpUrl) { "$mcpUrl/mcp" } else { '' }
    # The identity bootstrap grants the Purview roles to. Without it the roles
    # step is skipped and the deployed app keeps answering 403 from Purview.
    $env:CORTEX_IDENTITY_PRINCIPAL_ID = $v['CORTEX_IDENTITY_PRINCIPAL_ID']
    if ($apimKey) { $env:APIM_SUBSCRIPTION_KEY = $apimKey }

    # Round 4 — where the Foundry project lives (for project connections), the
    # Purview account (Data Map), the sample-data account and the search service.
    $env:FOUNDRY_ACCOUNT_NAME     = $v['FOUNDRY_ACCOUNT_NAME']
    $env:FOUNDRY_PROJECT_NAME     = $v['FOUNDRY_PROJECT_NAME']
    $env:FOUNDRY_RESOURCE_GROUP   = $v['FOUNDRY_ACCOUNT_RESOURCE_GROUP']
    $env:PURVIEW_ACCOUNT_NAME     = $v['PURVIEW_ACCOUNT_NAME']
    $env:DATA_STORAGE_ACCOUNT     = $v['DATA_STORAGE_ACCOUNT']
    $env:DATA_CONTAINER           = $v['DATA_CONTAINER']
    $env:DATA_RESOURCE_GROUP      = $CortexResourceGroup
    $env:DATA_STORAGE_LOCATION    = $Location
    $env:SEARCH_ENDPOINT          = $v['SEARCH_ENDPOINT']
    $env:SEARCH_SERVICE_NAME      = $v['SEARCH_SERVICE_NAME']
    if (-not $v['FOUNDRY_ACCOUNT_PRINCIPAL_ID']) {
      Warn2 'The Foundry account has no system-assigned identity, so agents cannot read AI Search keylessly.'
      Info  "Azure portal → $($v['FOUNDRY_ACCOUNT_NAME']) → Identity → System assigned → On, then re-run this script."
    }

    # Only point bootstrap at the vault when the vault is actually usable from
    # here. An unreachable vault name costs the timeout budget and supplies
    # nothing; empty makes the adapter skip straight to these values.
    $env:KEYVAULT_NAME = if ($configSource -eq 'keyvault') { $kv } else { '' }

    # BOOTSTRAP IN THREE PARTS, BECAUSE OF THE PERIMETER.
    #   here      roles, Purview content, API Management, Foundry connections —
    #             none of it touches storage, and the Purview roles must be
    #             granted by YOU (a Unified Catalog administrator), not by the
    #             Cortex identity.
    #   the job   the data section — upload the sample files, register and run
    #             the Data Map scan, attach the scanned assets — as the Cortex
    #             identity, inside Azure, because your laptop is outside the
    #             perimeter by design.
    #   here      the AI Search indexes, which are created through the search
    #             service (public, learning mode) and verified by reading each
    #             indexer's result — the first proof the perimeter lets the
    #             search service into the storage account.
    # Without a perimeter (-NoPerimeter, or a tenant without the policy) the
    # data section runs here as before.
    $job = $v['CORTEX_BOOTSTRAP_JOB']
    $useJob = [bool]$perimeter -and [bool]$job -and [bool]$v['DATA_STORAGE_ACCOUNT']
    $noWaitArg = if ($NoScanWait) { @('--no-wait') } else { @() }

    if ($useJob) { node scripts/bootstrap.js --skip=data,search @noWaitArg }
    elseif ($NoScanWait) { npm run bootstrap -- --no-wait }
    else { npm run bootstrap }
    $bootstrapRc = $LASTEXITCODE
    if ($bootstrapRc -ne 0) {
      Warn2 'Bootstrap reported failures. It is idempotent — fix the cause and re-run.'
      Info  'To re-run by hand, load the configuration into your session first:'
      Info  '    . .\scripts\Set-CortexEnv.ps1'
      Info  $(if ($useJob) { '    node scripts/bootstrap.js --skip=data,search' } else { '    npm run bootstrap' })
      Info  'Without that first line the values above are gone and every one is reported missing.'
      $problems += 'bootstrap reported failures (step 11)'
    } elseif (-not $useJob) { Ok 'Purview access granted; content, connections, sample data and indexes in place' }
    else { Ok 'Purview access granted; content and connections in place' }

    $jobOk = $false
    if ($useJob) {
      Step '11b' "Running the sample-data section inside the perimeter (job $job)"
      Info 'Uploads the files, registers and runs the Data Map scan, attaches the assets — as the Cortex identity.'

      # azd deploys services, not jobs: give the job the image the web app is
      # running, and the wait flag through the environment (see bootstrap.js).
      $webImage = az containerapp show -n 'cortex-web' -g $CortexResourceGroup --query 'properties.template.containers[0].image' -o tsv 2>$null
      $jobImage = az containerapp job show -n $job -g $CortexResourceGroup --query 'properties.template.containers[0].image' -o tsv 2>$null
      $flag = if ($NoScanWait) { '--no-wait' } else { '--wait' }
      if ($webImage -and $webImage -notmatch 'k8se/quickstart') {
        $jobArgs = @('containerapp','job','update','-n',$job,'-g',$CortexResourceGroup,'--set-env-vars',"BOOTSTRAP_ARGS=$flag",'--only-show-errors','-o','none')
        if ($jobImage -ne $webImage) { $jobArgs += @('--image',$webImage) }
        az @jobArgs 2>$null
        if ($LASTEXITCODE -eq 0) { Ok "Job runs $(($webImage -split '/')[-1])" } else { Warn2 'Could not update the job definition; starting it as it is.' }
      } else {
        Warn2 'cortex-web is still on the placeholder image, so the job has no code to run. Deploy first (-AppOnly), then re-run.'
      }

      $started = Get-AzJson @('containerapp','job','start','-n',$job,'-g',$CortexResourceGroup,'-o','json')
      $execName = $started.name
      if (-not $execName) {
        Fail 'The job could not be started.'
        $problems += 'bootstrap job could not be started (step 11b)'
      } else {
        Info "Execution $execName — waiting (the Data Map scan is the slow part; 3–10 minutes, $(if ($NoScanWait) { 'not waited for' } else { 'waited for' }))"
        $deadline = (Get-Date).AddMinutes(25)
        $status = ''
        while ((Get-Date) -lt $deadline) {
          Start-Sleep -Seconds 15
          $status = az containerapp job execution show -n $job -g $CortexResourceGroup --job-execution-name $execName --query properties.status -o tsv 2>$null
          if ($status -in @('Succeeded','Failed','Stopped')) { break }
        }
        # The job's own log is the record of what happened to the data chain.
        # `job logs show` is an extension command (installed on demand, step 1);
        # if it still returns nothing, the same lines are in Log Analytics a few
        # minutes later, so that is asked as well.
        $prevEap3 = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $jobLog = @(az containerapp job logs show -n $job -g $CortexResourceGroup --execution $execName --container bootstrap --tail 300 --only-show-errors 2>$null)
        $ErrorActionPreference = $prevEap3
        $lines = @()
        foreach ($l in $jobLog) {
          $text = $l
          try { $o = $l | ConvertFrom-Json; $text = "$($o.Log)" } catch { }
          if ($text -and $text -notmatch 'requires the extension') { $lines += $text }
        }
        if ($lines.Count -eq 0) {
          $lawId = az monitor log-analytics workspace show -n $LogAnalyticsName -g $MonitoringResourceGroup --query customerId -o tsv 2>$null
          if ($lawId) {
            $kql = "ContainerAppConsoleLogs_CL | where ContainerJobName_s == '$job' and TimeGenerated > ago(45m) | project TimeGenerated, Log_s | order by TimeGenerated asc | take 300"
            $rows = Get-AzJson @('monitor','log-analytics','query','-w',$lawId,'--analytics-query',$kql,'-o','json')
            foreach ($r in @($rows)) { if ($r.Log_s) { $lines += "$($r.Log_s)" } }
            if ($lines.Count -eq 0) { Info 'The job log has not reached Log Analytics yet (it takes a few minutes). Read it later with:' }
          }
        }
        foreach ($l in $lines) { Write-Host "    | $l" -ForegroundColor DarkGray }
        if ($lines.Count -eq 0) {
          Info "    az containerapp job logs show -n $job -g $CortexResourceGroup --execution $execName --container bootstrap --tail 300"
        }
        if ($status -eq 'Succeeded') { $jobOk = $true; Ok "Job $execName succeeded — the sample files are in storage and the products carry their assets" }
        elseif ($status) {
          $problems += "bootstrap job $status (step 11b) — see its log above"
          Fail "Job $execName finished as $status. The log above names the cause; the common ones:"
          Info '  403 AuthorizationFailure — the perimeter did not admit the Cortex identity: check the subscription rule and that the account is SecuredByPerimeter (step 7b)'
          Info '  Missing required configuration — the APIM key is not on the job yet (step 9); re-run this script'
          Info '  scan Failed — the Purview account identity is refused: it needs Storage Blob Data Reader (Bicep) and the perimeter rule'
          Info "  Re-run the job on its own:  az containerapp job start -n $job -g $CortexResourceGroup   then   az containerapp job logs show -n $job -g $CortexResourceGroup --container bootstrap --tail 200"
        } else {
          $problems += 'bootstrap job did not finish within 25 minutes (step 11b)'
          Warn2 "Job $execName was still running after 25 minutes. It carries on in Azure; check it with:  az containerapp job execution list -n $job -g $CortexResourceGroup -o table"
        }
      }

      Step '11c' 'Building the AI Search indexes'
      # A job that failed on the scan or the linking still uploaded the files;
      # the indexes only need the files. The web app can see the container
      # from inside the perimeter, so ask it how many files are there.
      $filesInStorage = 0
      if (-not $jobOk) {
        $st = Get-CortexJson -Uri "$webUrl/api/health/storage"
        if ($st.json -and $st.json.files) { $filesInStorage = [int]$st.json.files }
        if ($filesInStorage -gt 0) { Info "$filesInStorage sample file(s) are in storage despite the job's failure, so the indexes are built anyway." }
      }
      if ($jobOk -or $NoScanWait -or $filesInStorage -gt 0) {
        node scripts/bootstrap.js --only=search @noWaitArg
        if ($LASTEXITCODE -ne 0) {
          $problems += 'AI Search indexes reported failures (step 11c)'
          Warn2 'One or more indexes did not build. An indexer refused with "not authorized" means the perimeter is not admitting the search service.'
          Info  'Re-run on its own:  . .\scripts\Set-CortexEnv.ps1;  node scripts/bootstrap.js --only=search'
        } else { Ok 'Indexes built and verified' }
      } else {
        Warn2 'Skipped: the sample files are not in storage yet. When the job succeeds:  . .\scripts\Set-CortexEnv.ps1;  node scripts/bootstrap.js --only=search'
      }
    }
    if ($NoScanWait) { Info 'When the Data Map scan has finished:  . .\scripts\Set-CortexEnv.ps1; node scripts/bootstrap.js --only=link   (or re-run the job without -NoScanWait)' }

    # The app refreshes its register every 15 minutes. Ask it to do so now, so
    # the Marketplace shows the content the moment this script finishes. The
    # identity's new roles can take a minute to propagate, so a refresh that
    # still reports Purview errors is retried by the health check below.
    $refresh = Get-CortexJson -Uri "$webUrl/api/index/refresh" -Method Post
    if ($refresh.behindSignIn) {
      Warn2 'The register could not be refreshed: sign-in is intercepting /api/index/refresh.'
      Info  'Set-CortexAuth.ps1 excludes the machine paths from sign-in — run it, then: curl -X POST <web url>/api/index/refresh'
      Info  'Otherwise the app refreshes itself within 15 minutes.'
    } elseif ($refresh.notServing) {
      Warn2 "The register could not be refreshed: cortex-web is not answering ($($refresh.error)). See step 8."
    } elseif ($refresh.json) { Ok "Register refreshed ($($refresh.json.entries) entries)" }
    else { Warn2 "Could not refresh the register now — it refreshes itself within 15 minutes ($($refresh.error))" }
  }

  # ------------------------------------------------------------- 13 check
  if (-not $SkipHealthCheck) {
    Step 12 'Checking the deployment'
    # Steps 9 and 10 write secrets and settings onto cortex-web, and each write
    # is a new revision. Make sure the newest one is serving before reading
    # its health endpoints, or a revision still starting reads as a broken app.
    $rv = Wait-CortexRevision -App 'cortex-web' -Rg $CortexResourceGroup -TimeoutSeconds 150 -RestartIfFailed
    if (-not $rv.ok -and -not $SkipAuth -and (Test-CortexAuthSidecarBroken -App 'cortex-web' -Rg $CortexResourceGroup -Revision $rv.revision)) {
      # The secret updates in step 9 produced a revision whose sign-in sidecar
      # has no client secret. Re-minting it is the cure, and it is safe to do
      # here: the running revision keeps serving until the new one is ready.
      Warn2 "cortex-web revision $($rv.revision): the sign-in sidecar has no client secret. Re-minting it."
      & (Join-Path $root 'scripts/Set-CortexAuth.ps1') -EnvironmentName $EnvironmentName -DefaultGroups $DefaultGroups -RotateSecret -Quiet
      $rv = Wait-CortexRevision -App 'cortex-web' -Rg $CortexResourceGroup -TimeoutSeconds 180
    }
    if ($rv.ok) { Ok "cortex-web revision $($rv.revision) is serving" }
    else {
      Show-CortexRevisionFailure -App 'cortex-web' -Rg $CortexResourceGroup -Result $rv
      $problems += "cortex-web is not serving (revision $($rv.revision): $($rv.running), $($rv.health))"
    }
    # A container app that has just taken a new revision needs a moment. Three
    # attempts with a short back-off turns a spurious red into a real signal.
    $behindSignIn = $false
    $notServing = $false
    $healthFailures = @()
    foreach ($p in @('/api/health','/api/health/keyvault','/api/health/purview','/api/health/apim','/api/health/foundry','/api/health/search','/api/health/storage','/api/health/datamap','/api/health/state')) {
      $passed = $false
      $lastError = ''
      foreach ($attempt in 1..3) {
        $r = Get-CortexJson -Uri "$webUrl$p"
        if ($r.behindSignIn) { $behindSignIn = $true; $lastError = 'redirected to sign-in'; break }
        if ($r.notServing) { $notServing = $true; $lastError = $r.error; break }
        if ($r.ok) { $passed = $true; break }
        $lastError = if ($r.error) { $r.error } else {
          $detail = if ($r.json.error) { $r.json.error } elseif ($r.json.sourceErrors) { ($r.json.sourceErrors | ConvertTo-Json -Compress) } elseif ($r.json.missingRequired) { "missing: $($r.json.missingRequired -join ', ')" } else { 'returned ok=false' }
          "$detail"
        }
        if ($attempt -lt 3) { Start-Sleep -Seconds 10 }
      }
      if ($passed) { Ok $p } else { $healthFailures += $p; Warn2 "$p — $($lastError.ToString().Substring(0, [Math]::Min(300, $lastError.ToString().Length)))" }
    }
    if ($behindSignIn) {
      Warn2 'Sign-in is guarding the health endpoints, so nothing above could be checked from here.'
      Info  'Set-CortexAuth.ps1 excludes /api/health*, /api/index/refresh and /shim/* from sign-in. Run it and check again with Test-Cortex.ps1.'
    }
    if ($notServing) {
      Warn2 'cortex-web is not answering at all — the platform is replying for a revision that is not running.'
      Info  'Step 8 above shows the revision state and the platform log. A revision that still mounts the old state'
      Info  'share (round 4) needs a re-provision; anything else is named in the log lines.'
    }
    if ($healthFailures.Count -gt 0) { $problems += "health checks failing: $($healthFailures -join ', ')" }

    if ($mcpUrl) {
      try {
        $m = Invoke-RestMethod -Uri "$mcpUrl/health" -TimeoutSec 30
        if ($m.ok) { Ok "/health (MCP server, $($m.tools) tools)" } else { Warn2 'MCP server returned ok=false'; $problems += 'MCP server returned ok=false' }
      } catch { Warn2 "MCP server — $($_.Exception.Message)"; $problems += 'MCP server not answering' }
    }
  }

  if ($problems.Count -eq 0) {
    Write-Host "`n===========================================================" -ForegroundColor Green
    Write-Host " Cortex is deployed and every check passed." -ForegroundColor Green
    Write-Host "===========================================================" -ForegroundColor Green
  } else {
    Write-Host "`n===========================================================" -ForegroundColor Red
    Write-Host " Cortex is deployed, but it is NOT fully working." -ForegroundColor Red
    Write-Host "===========================================================" -ForegroundColor Red
    foreach ($pr in $problems) { Write-Host "  - $pr" -ForegroundColor Yellow }
    Write-Host ''
    Write-Host '  Fix the causes named above and run this script again — every step is safe to repeat.' -ForegroundColor Yellow
    Write-Host '  For a paste-able diagnosis:  .\scripts\Test-Cortex.ps1 -Diagnose' -ForegroundColor Yellow
  }
  Write-Host "`n  Web : $webUrl"
  if ($mcpUrl) { Write-Host "  MCP : $mcpUrl/mcp" }
  Write-Host "  Model: $effectiveDeploymentName ($ModelName $effectiveVersion)"
  Write-Host "  Config: $configSource`n"
  if ($configSource -eq 'direct') {
    Write-Host " Configuration is held on the container apps, not in Key Vault." -ForegroundColor Yellow
    Write-Host " The vault refuses data-plane reads, and Container Apps is not a trusted service," -ForegroundColor Yellow
    Write-Host " so it could not have been read at runtime. The three sensitive values are" -ForegroundColor Yellow
    Write-Host " Container Apps secrets: encrypted at rest, but readable by anyone with" -ForegroundColor Yellow
    Write-Host " Contributor on the app. Fine for a sandbox, not for production." -ForegroundColor Yellow
    Write-Host " docs/DEPLOY.md section 5 has the route back to Key Vault.`n" -ForegroundColor Yellow
  }
  Write-Host " What was automated this run:"
  Write-Host "  - Purview: the Cortex identity ($($v['CORTEX_IDENTITY_PRINCIPAL_ID'])) holds its Unified Catalog roles"
  Write-Host "    (granted by bootstrap). If the Help page still shows Purview as unavailable, wait a minute and reload."
  if ($v['SEARCH_SERVICE_NAME']) { Write-Host "  - AI Search: $($v['SEARCH_SERVICE_NAME']) — one index per data product, built from the sample files." }
  if ($v['DATA_STORAGE_ACCOUNT']) { Write-Host "  - Sample data: $($v['DATA_STORAGE_ACCOUNT'])/$($v['DATA_CONTAINER']) — scanned by the Data Map and attached to the products." }
  if ($v['STATE_STORAGE_ACCOUNT']) { Write-Host "  - State: requests, chats and automations persist as blobs on $($v['STATE_STORAGE_ACCOUNT']), read with the managed identity." }
  if ($perimeter) { Write-Host "  - Perimeter: $perimeter secures the storage accounts (SecuredByPerimeter); the AI Search service is a member in $SearchAccessMode mode." }
  if ($v['CORTEX_BOOTSTRAP_JOB']) { Write-Host "  - Bootstrap job: $($v['CORTEX_BOOTSTRAP_JOB']) runs the sample-data section inside the perimeter as the Cortex identity." }
  if ($storageRepaired) { Write-Host "  - Storage: the accounts had been changed by the tenant policy and were repaired (step 7b)." }
  Write-Host "  - Foundry: a project connection per MCP server carries the API Management key, so agents can call their tools."
  Write-Host "  - Chat: every member of staff can open a chat window with every agent (policy: $ChatPolicy)."
  Write-Host "  - Sign-in: Entra, with the groups claim. Every signed-in user is treated as: $DefaultGroups"
  if ($DemoIdentities) {
    Write-Host "  - Demo identities: you are in $($DemoGroupMap.Count) demo groups; demo users are in: $($DemoUserGroups -join ', ')."
  } elseif ($GroupMap.Count -eq 0) {
    Write-Host "    To map real Entra groups onto access-rule names:  .\scripts\Set-CortexAuth.ps1 -GroupMap 'operations=<group name>'"
    Write-Host "    For the two-account demo set-up:  .\scripts\Deploy-Cortex.ps1 -SkipProvision -SkipBootstrap -DemoIdentities -DemoUserEmail <address>"
  }
  Write-Host ""
  Write-Host " Check it:  .\scripts\Test-Cortex.ps1   then open $webUrl/profile"
  Write-Host ""
  Write-Host " Re-running this script is safe. For a code-only change use -AppOnly.`n" -ForegroundColor DarkGray
  if ($problems.Count -gt 0) { exit 1 }
}
catch { Fail $_.Exception.Message; exit 1 }
finally { Pop-Location }
