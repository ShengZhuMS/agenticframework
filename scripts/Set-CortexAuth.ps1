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
       -GroupMap names specific groups; -MapMyGroups names every group YOU are
       in after its Entra display name, so /profile shows names, not ids.
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
  .\scripts\Set-CortexAuth.ps1 -MapMyGroups
  /profile listed "8 unmapped group ids": name every group you are a member of
  after its Entra display name. Cosmetic unless a name matches an access rule.

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
  [switch]$MapMyGroups,
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

# THE STALE-TOKEN TRAP. You add yourself to a directory role (Application
# Administrator, say) and re-run. Every Graph call the CLI makes still carries
# the token it cached BEFORE the role changed, and Entra's continuous access
# evaluation refuses it:
#
#   Continuous access evaluation resulted in challenge with result:
#   InteractionRequired and code: TokenCreatedWithOutdatedPolicies
#
# The CLI cannot satisfy that challenge silently, so it surfaces as a failure
# that reads like a missing permission. The only cure is a sign-in that really
# re-authenticates. On Windows a plain `az login` often does NOT: the Web
# Account Manager broker completes it silently with the account already signed
# into Windows and hands back the same revoked token — which is exactly what
# happened here on the first attempt. So: clear the CLI's cache, try the broker
# once, and if the challenge persists fall back to the device-code flow, which
# always asks and never reuses a cached token.
$script:CaePattern = 'TokenCreatedWithOutdatedPolicies|InteractionRequired|AADSTS50173|AADSTS53003|AADSTS50076|claims challenge'
function Reset-AzSignIn {
  param([switch]$DeviceCode)
  if ($DeviceCode) {
    Info 'Device-code sign-in: open the address shown, enter the code, and pick the SAME account you use for this subscription.'
    # No --only-show-errors here: the code itself is printed as a warning.
    az login --use-device-code --scope 'https://graph.microsoft.com//.default'
  } else {
    az account clear --only-show-errors 2>$null | Out-Null
    az login --scope 'https://graph.microsoft.com//.default' --only-show-errors | Out-Null
  }
  if ($script:subscriptionId) { az account set --subscription $script:subscriptionId --only-show-errors | Out-Null }
}
function Invoke-AzDirectory {
  param([scriptblock]$Command, [string]$What, [switch]$Json)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = (& $Command 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -and $out -match $script:CaePattern) {
      Warn2 "Entra refused the CLI's cached token while $What."
      Info  'It was issued before your directory role changed, and Entra will not renew it silently.'
      Info  'Clearing the cached sign-in and signing you in again — pick your account in the window that opens.'
      Reset-AzSignIn
      $out = (& $Command 2>&1 | Out-String)
      if ($LASTEXITCODE -ne 0 -and $out -match $script:CaePattern) {
        Warn2 'Still refused: Windows signed you in silently and returned the same token. Using the device-code flow instead.'
        Reset-AzSignIn -DeviceCode
        $out = (& $Command 2>&1 | Out-String)
      }
    }
    if ($LASTEXITCODE -ne 0) {
      if ($out -match $script:CaePattern) {
        throw ("$What failed: Entra keeps refusing the CLI's token. In a NEW terminal run:`n" +
               "      az account clear`n      az login --use-device-code`n      az account set --subscription $($script:subscriptionId)`n" +
               '    then run this script again.')
      }
      throw "$What failed: $($out.Trim())"
    }
    if ($Json) {
      # Warnings can precede the JSON on the same stream; keep from the first brace.
      $i = $out.IndexOf('{'); $j = $out.IndexOf('[')
      $start = @($i, $j) | Where-Object { $_ -ge 0 } | Sort-Object | Select-Object -First 1
      if ($null -ne $start) { return $out.Substring($start) }
    }
    return $out
  }
  finally { $ErrorActionPreference = $prev }
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
  $script:subscriptionId = $acct.id
  $callback = "$webUrl/.auth/login/aad/callback"

  Write-Host "`nSign-in for $webApp ($webUrl)`n" -ForegroundColor Cyan

  # Pre-flight the directory token once, cheaply, so a stale token is refreshed
  # here rather than half-way through creating things.
  $null = Invoke-AzDirectory { az ad signed-in-user show --query id -o tsv --only-show-errors } 'reading your directory account'

  # ------------------------------------------------------ 1 app registration
  # If sign-in is already configured on the app — by hand in the portal, or by
  # an earlier run under another display name — keep THAT registration. Creating
  # a second one and switching the app over to it would work, and would also
  # leave you with two registrations and a sign-out for everyone.
  $auth = Get-AzJson @('containerapp','auth','show','-n',$webApp,'-g',$rg)
  $authProps = if ($auth.properties) { $auth.properties } else { $auth }
  $liveClientId = $authProps.identityProviders.azureActiveDirectory.registration.clientId
  $app = $null
  if ($liveClientId) {
    $app = Get-AzJson @('ad','app','show','--id',$liveClientId)
    if ($app) { Keep "Sign-in already uses app registration '$($app.displayName)' ($($app.appId)) — keeping it" }
    else {
      Warn2 "Sign-in points at client $liveClientId, which no longer exists (deleted?). Nobody can sign in until it is replaced."
      Info  "Replacing it with '$AppDisplayName'."
    }
  }
  if (-not $app) { $app = Get-AzJson @('ad','app','list','--display-name',$AppDisplayName,'--query','[0]') }
  if (-not $app) {
    $created = Invoke-AzDirectory {
      az ad app create --display-name $AppDisplayName `
        --sign-in-audience AzureADMyOrg `
        --web-redirect-uris $callback `
        --enable-id-token-issuance true --only-show-errors
    } "creating the app registration '$AppDisplayName'" -Json
    $app = $created | ConvertFrom-Json
    if (-not $app.appId) { throw "Could not create the app registration '$AppDisplayName'. You need Application Administrator (and a fresh sign-in if you were just given it)." }
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
    $null = Invoke-AzDirectory { az ad app update --id $app.appId --set groupMembershipClaims=SecurityGroup --only-show-errors } 'switching on the groups claim'
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
  $aad = $authProps.identityProviders.azureActiveDirectory
  $configuredFor = $aad.registration.clientId
  $needsSecret = $RotateSecret -or (-not $aad) -or ($configuredFor -ne $app.appId)

  if ($needsSecret) {
    # Minted only now. Every reset adds a credential to the app, so this is
    # not done on every run.
    $secret = (Invoke-AzDirectory {
      az ad app credential reset --id $app.appId --append --display-name "cortex-easyauth-$(Get-Date -Format yyyyMMdd)" --years 1 --query password -o tsv --only-show-errors
    } 'creating a client secret').Trim()
    if (-not $secret) { throw 'Could not create a client secret on the app registration.' }

    az containerapp auth microsoft update -n $webApp -g $rg `
      --client-id $app.appId --client-secret $secret --tenant-id $tenant --yes --only-show-errors | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not configure Microsoft sign-in on $webApp." }
    Ok "Microsoft sign-in configured on $webApp (client $($app.appId))"
    Remove-Variable secret
  } else {
    Keep "Microsoft sign-in already configured for $($app.appId)"
  }

  $action = $authProps.globalValidation.unauthenticatedClientAction
  if ($action -ne 'RedirectToLoginPage' -or -not $authProps.platform.enabled) {
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
  #
  # Entra puts group OBJECT IDS in the token; Cortex's access rules read NAMES.
  # The mapping is additive across runs: what is already in the azd environment
  # is kept, an explicit alias for a group always wins over an automatic one,
  # and nothing is ever removed here.
  $envVars = @()
  $existingMap = @{}
  foreach ($pair in ($v['CORTEX_GROUP_NAMES'] -split ',')) {
    if ($pair -match '^([0-9a-fA-F-]{36})=(.+)$') { $existingMap[$Matches[1].ToLower()] = $Matches[2] }
  }
  $pairs = @{}   # id -> alias, for this run
  $me = az ad signed-in-user show --query id -o tsv 2>$null

  if ($MapMyGroups) {
    # Every group the signed-in person is in, named after its display name —
    # lower-case, spaces to hyphens — so /profile stops showing raw ids. Access
    # changes only where a derived name happens to match a rule (all-staff,
    # analysts, waste-crime, cortex-official-sensitive, cortex-commercial-licence).
    $raw = az rest --method get --url 'https://graph.microsoft.com/v1.0/me/memberOf?$select=id,displayName&$top=999' --only-show-errors 2>$null
    $mine = @()
    if ($LASTEXITCODE -eq 0 -and $raw) {
      $mine = @(($raw | ConvertFrom-Json).value | Where-Object { $_.'@odata.type' -eq '#microsoft.graph.group' })
    }
    if ($mine.Count -eq 0) {
      Warn2 'Could not read your group memberships from Microsoft Graph (or you are in none).'
    } else {
      foreach ($g in $mine) {
        $slug = ($g.displayName.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
        if (-not $slug) { continue }
        $pairs[$g.id.ToLower()] = $slug
      }
      Ok "Mapped $($pairs.Count) group(s) you are a member of, by display name"
      foreach ($g in ($mine | Sort-Object displayName)) { Info ("{0}  ->  {1}" -f $g.id, $pairs[$g.id.ToLower()]) }
    }
  }

  if ($GroupMap.Count -gt 0) {
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
      if ($gid) { $pairs[$gid.ToLower()] = $alias; Ok "$alias ← '$display' ($gid)" }
      else { Warn2 "Entra group '$display' not found. Create it, or pass -CreateGroups." }
    }
  }

  if ($pairs.Count -gt 0) {
    # Explicit and new mappings overlay what was there. Nothing is dropped.
    foreach ($k in $pairs.Keys) { $existingMap[$k] = $pairs[$k] }
    $map = ($existingMap.Keys | Sort-Object | ForEach-Object { "$_=$($existingMap[$_])" }) -join ','
    azd env set CORTEX_GROUP_NAMES $map | Out-Null
    $envVars += "CORTEX_GROUP_NAMES=$map"
    Ok "$($existingMap.Count) group id(s) now carry a name"
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
    if (-not $MapMyGroups -and $GroupMap.Count -eq 0) {
      Write-Host '  If it lists unmapped group ids:  .\scripts\Set-CortexAuth.ps1 -MapMyGroups' -ForegroundColor DarkGray
    }
    Write-Host ''
  }
}
catch { Write-Host "  FAIL    $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
finally { Pop-Location }
