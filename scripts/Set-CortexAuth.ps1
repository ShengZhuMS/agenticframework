<#
.SYNOPSIS
  Switch on Microsoft Entra sign-in for cortex-web — WITH the groups claim.
  Safe to run repeatedly.

.DESCRIPTION
  Everything the deployment guide used to ask you to do by hand for sign-in,
  in one idempotent script:

    1. An app registration called "Cortex" (created if absent, reused if not),
       with the web app's Easy Auth callback as its redirect URI and ID token
       issuance turned on.
    2. THE GROUPS CLAIM. groupMembershipClaims = SecurityGroup on that app.
       Without it every signed-in person appears to be in no groups and the
       Marketplace looks broken for reasons that are not obvious.
    3. A service principal for the app, if it has none.
    4. Container Apps built-in authentication on cortex-web, pointed at the app,
       with unauthenticated visitors redirected to sign in. A client secret is
       minted only when authentication is first set up (or with -RotateSecret),
       so re-running does not pile up credentials.
    5. Optional: a mapping of Entra group object ids to the names Cortex's
       access rules use (CORTEX_GROUP_NAMES), written to the azd environment so
       the Bicep keeps it, and onto the live app so it takes effect now.
    6. The default group every signed-in user receives (CORTEX_DEFAULT_GROUPS),
       written the same two places.

  Deploy-Cortex.ps1 runs this after provisioning unless -SkipAuth is given.
  Run it by hand when you change the group mapping.

  Needs: Application Administrator (or Cloud Application Administrator) in
  Entra, and Contributor on the Cortex resource group.

.EXAMPLE
  .\scripts\Set-CortexAuth.ps1
  Sign-in on, groups claim on, every signed-in user treated as all-staff.

.EXAMPLE
  .\scripts\Set-CortexAuth.ps1 -GroupMap 'waste-crime=Waste Crime Observatory','analysts=Data Analysts'
  Also map two Entra groups onto the names the access rules use.

.EXAMPLE
  .\scripts\Set-CortexAuth.ps1 -GroupMap 'waste-crime=Cortex Waste Crime' -CreateGroups
  Create the Entra group if it does not exist and add you to it — for the
  "same page, different eyes" demo moment.

.EXAMPLE
  .\scripts\Set-CortexAuth.ps1 -DefaultGroups ''
  Strict mode: only groups Entra sends count.
#>
[CmdletBinding()]
param(
  [string]$EnvironmentName,
  [string]$AppDisplayName = 'Cortex',
  # "alias=Entra group display name", one per entry.
  [string[]]$GroupMap = @(),
  [switch]$CreateGroups,
  [string]$DefaultGroups = 'all-staff',
  [switch]$RotateSecret,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Ok($t)    { Write-Host "  OK      $t" -ForegroundColor Green }
function Keep($t)  { Write-Host "  KEEP    $t" -ForegroundColor DarkGray }
function Warn2($t) { Write-Host "  WARN    $t" -ForegroundColor Yellow }
function Info($t)  { Write-Host "          $t" -ForegroundColor DarkGray }

# Run az and return parsed JSON or $null. Probes are allowed to answer "no".
function Get-AzJson {
  param([string[]]$Arguments)
  $out = & az @Arguments 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  try { return ($out | ConvertFrom-Json) } catch { return $null }
}

try {
  if ($EnvironmentName) { azd env select $EnvironmentName | Out-Null }

  $v = @{}
  azd env get-values 2>$null | ForEach-Object {
    if ($_ -match '^(\w+)="?([^"]*)"?$') { $v[$Matches[1]] = $Matches[2] }
  }
  $webUrl  = $v['CORTEX_WEB_URL']
  $rg      = $v['AZURE_RESOURCE_GROUP']
  $webApp  = if ($v['CORTEX_WEB_APP_NAME']) { $v['CORTEX_WEB_APP_NAME'] } else { 'cortex-web' }
  if (-not $webUrl -or -not $rg) {
    throw 'No deployment found in the azd environment. Run .\scripts\Deploy-Cortex.ps1 first.'
  }

  $acct = az account show | ConvertFrom-Json
  $tenant = $acct.tenantId
  $callback = "$webUrl/.auth/login/aad/callback"

  Write-Host "`nSign-in for $webApp ($webUrl)`n" -ForegroundColor Cyan

  # ------------------------------------------------------ 1 app registration
  $app = Get-AzJson @('ad','app','list','--display-name',$AppDisplayName,'--query','[0]')
  if (-not $app) {
    $app = az ad app create --display-name $AppDisplayName `
             --sign-in-audience AzureADMyOrg `
             --web-redirect-uris $callback `
             --enable-id-token-issuance true | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $app) { throw "Could not create the app registration '$AppDisplayName'. You need Application Administrator." }
    Ok "App registration '$AppDisplayName' created ($($app.appId))"
  } else {
    Keep "App registration '$AppDisplayName' exists ($($app.appId))"
    # A second environment, or a rebuilt container app, has a new callback URL.
    $uris = @($app.web.redirectUris)
    if ($uris -notcontains $callback) {
      $uris += $callback
      az ad app update --id $app.appId --web-redirect-uris @uris --enable-id-token-issuance true --only-show-errors
      if ($LASTEXITCODE -eq 0) { Ok "Redirect URI added: $callback" } else { Warn2 "Could not add the redirect URI $callback" }
    } else {
      Keep "Redirect URI present"
    }
  }

  # ------------------------------------------------------ 2 THE GROUPS CLAIM
  # This is the step that, when missed, makes a working deployment look broken.
  $current = az ad app show --id $app.appId --query groupMembershipClaims -o tsv 2>$null
  if ($current -in @('SecurityGroup','All')) {
    Keep "Groups claim already on ($current)"
  } else {
    az ad app update --id $app.appId --set groupMembershipClaims=SecurityGroup --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Could not set groupMembershipClaims on the app registration.' }
    Ok 'Groups claim on (SecurityGroup) — tokens now carry the group object ids'
  }

  # ------------------------------------------------------ 3 service principal
  $sp = Get-AzJson @('ad','sp','show','--id',$app.appId)
  if (-not $sp) {
    az ad sp create --id $app.appId --only-show-errors | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok 'Service principal created' } else { Warn2 'Could not create the service principal; sign-in may still work if it appears later.' }
  } else {
    Keep 'Service principal exists'
  }

  # ------------------------------------------------------ 4 container app auth
  $auth = Get-AzJson @('containerapp','auth','show','-n',$webApp,'-g',$rg)
  $aad = $auth.identityProviders.azureActiveDirectory
  $configuredFor = $aad.registration.clientId
  $needsSecret = $RotateSecret -or (-not $aad) -or ($configuredFor -ne $app.appId)

  if ($needsSecret) {
    # Minted only now. Every reset adds a credential to the app, so this is
    # not done on every run.
    $secret = az ad app credential reset --id $app.appId --append --display-name "cortex-easyauth-$(Get-Date -Format yyyyMMdd)" --years 1 --query password -o tsv --only-show-errors
    if ($LASTEXITCODE -ne 0 -or -not $secret) { throw 'Could not create a client secret on the app registration.' }

    az containerapp auth microsoft update -n $webApp -g $rg `
      --client-id $app.appId --client-secret $secret --tenant-id $tenant --yes --only-show-errors | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not configure Microsoft sign-in on $webApp." }
    Ok "Microsoft sign-in configured on $webApp (client $($app.appId))"
    Remove-Variable secret
  } else {
    Keep "Microsoft sign-in already configured for $($app.appId)"
  }

  $action = $auth.globalValidation.unauthenticatedClientAction
  if ($action -ne 'RedirectToLoginPage' -or -not $auth.platform.enabled) {
    az containerapp auth update -n $webApp -g $rg --enabled true `
      --unauthenticated-client-action RedirectToLoginPage --redirect-provider azureactivedirectory --only-show-errors | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not turn on authentication for $webApp." }
    Ok 'Unauthenticated visitors are redirected to sign in'
  } else {
    Keep 'Redirect to sign-in already on'
  }

  # ------------------------------------------------------ 4b machine paths
  # Sign-in must not sit in front of the paths machines call: the health
  # endpoints the deploy and test scripts read, the register refresh bootstrap
  # triggers, and the invocation shim API Management calls on behalf of a
  # published agent. Everything else stays behind sign-in. The shim is reached
  # through API Management with a subscription key; this is a proof of concept
  # and the shim itself does not re-check that key — noted in HANDOVER.md.
  $excluded = @('/api/health', '/api/health/*', '/api/index/refresh', '/shim/*')
  $live = Get-AzJson @('containerapp','auth','show','-n',$webApp,'-g',$rg)
  $props = if ($live.properties) { $live.properties } else { $live }
  $have = @($props.globalValidation.excludedPaths)
  $missing = @($excluded | Where-Object { $have -notcontains $_ })
  if ($missing.Count -gt 0) {
    if (-not $props.globalValidation) { $props | Add-Member -NotePropertyName globalValidation -NotePropertyValue @{} -Force }
    $props.globalValidation | Add-Member -NotePropertyName excludedPaths -NotePropertyValue @($have + $missing) -Force
    $appId = az containerapp show -n $webApp -g $rg --query id -o tsv
    $body = @{ properties = $props } | ConvertTo-Json -Depth 20 -Compress
    $tmp = New-TemporaryFile
    Set-Content -Path $tmp -Value $body -Encoding utf8
    az rest --method put --url "https://management.azure.com$appId/authConfigs/current?api-version=2024-03-01" --body "@$tmp" --only-show-errors | Out-Null
    $rc = $LASTEXITCODE
    Remove-Item $tmp -Force
    if ($rc -eq 0) { Ok "Health, refresh and shim paths excluded from sign-in ($($excluded -join ', '))" }
    else { Warn2 'Could not exclude the machine paths from sign-in. Test-Cortex.ps1 and published agents will be redirected to the sign-in page until this is fixed.' }
  } else {
    Keep 'Machine paths already excluded from sign-in'
  }

  # Recorded so a later `azd provision` passes the client id through Bicep.
  azd env set ENTRA_CLIENT_ID $app.appId | Out-Null

  # ------------------------------------------------------ 5 group mapping
  $envVars = @()
  if ($GroupMap.Count -gt 0) {
    $me = az ad signed-in-user show --query id -o tsv 2>$null
    $pairs = @()
    foreach ($entry in $GroupMap) {
      if ($entry -notmatch '^([^=]+)=(.+)$') { Warn2 "Ignoring '$entry' — expected alias=Entra group display name"; continue }
      $alias = $Matches[1].Trim(); $display = $Matches[2].Trim()
      $gid = az ad group list --display-name $display --query '[0].id' -o tsv 2>$null
      if (-not $gid -and $CreateGroups) {
        $nick = ($alias -replace '[^a-zA-Z0-9]', '')
        $gid = az ad group create --display-name $display --mail-nickname $nick --query id -o tsv --only-show-errors
        if ($LASTEXITCODE -eq 0 -and $gid) {
          Ok "Entra group '$display' created"
          if ($me) { az ad group member add --group $gid --member-id $me --only-show-errors 2>$null; Ok "You were added to '$display'" }
        } else { $gid = $null }
      }
      if ($gid) { $pairs += "$gid=$alias"; Ok "$alias ← '$display' ($gid)" }
      else { Warn2 "Entra group '$display' not found. Create it, or pass -CreateGroups." }
    }
    if ($pairs.Count -gt 0) {
      $map = $pairs -join ','
      azd env set CORTEX_GROUP_NAMES $map | Out-Null
      $envVars += "CORTEX_GROUP_NAMES=$map"
    }
  }

  # ------------------------------------------------------ 6 default groups
  azd env set CORTEX_DEFAULT_GROUPS $DefaultGroups | Out-Null
  $envVars += "CORTEX_DEFAULT_GROUPS=$DefaultGroups"

  # Onto the live app now, so nobody waits for the next provision. The same
  # values are in the azd environment, so a provision writes the same thing.
  az containerapp update -n $webApp -g $rg --set-env-vars @envVars --only-show-errors | Out-Null
  if ($LASTEXITCODE -eq 0) {
    if ($DefaultGroups) { Ok "Every signed-in user is treated as: $DefaultGroups" } else { Ok 'Strict mode: only Entra groups count' }
  } else {
    Warn2 'Could not update the live app; the values will apply on the next provision.'
  }

  if (-not $Quiet) {
    Write-Host ''
    Write-Host '  Sign-in is on.' -ForegroundColor Green
    Write-Host "  Open $webUrl/profile — it lists your groups and what each state contains."
    Write-Host '  If it says you are in no named groups, sign out and in again (a token minted'
    Write-Host '  before the groups claim was switched on does not carry it).'
    Write-Host ''
  }
}
catch { Write-Host "  FAIL    $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
finally { Pop-Location }
