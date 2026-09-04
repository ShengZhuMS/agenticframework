<#
.SYNOPSIS
  Give somebody access to Cortex — a colleague, or your own account from
  another tenant. Safe to run repeatedly.

.DESCRIPTION
  Cortex signs people in through THIS tenant's Entra ID, and its app
  registration is single-tenant ("Accounts in this organizational directory
  only"). Anyone whose account lives elsewhere — a Defra colleague, a partner,
  your own corporate account — is brought in as a GUEST (Entra B2B). They keep
  their own password and MFA; this tenant only holds a guest object for them,
  and Cortex sees them exactly as it sees a member: by the groups they are in.

  This script:
    1. finds the person in the tenant (member or existing guest), or sends a
       B2B invitation by email with Cortex's own address as the landing page;
    2. optionally adds them to Entra groups Cortex's access rules read (-Groups);
    3. says what they will see next, and what to do if their home tenant
       refuses.

  Needs: Guest Inviter, User Administrator or Global Administrator in this
  tenant. Adding to a group needs ownership of it or Groups Administrator.

.EXAMPLE
  .\scripts\Add-CortexUser.ps1 -Email shengzhu@microsoft.com
  Invite your corporate account. It arrives as a guest, is treated as all-staff
  like every signed-in user, and sees the "Open to all staff" entries.

.EXAMPLE
  .\scripts\Add-CortexUser.ps1 -Email colleague@defra.gov.uk -Groups 'Waste Crime Observatory'
  Invite, and put them in an Entra group that an access rule reads — the
  "same page through different eyes" demo.

.EXAMPLE
  .\scripts\Add-CortexUser.ps1 -Email shengzhu@microsoft.com -NoEmail
  Create the invitation without Microsoft's email; the redemption link is
  printed for you to pass on yourself.

.EXAMPLE
  .\scripts\Add-CortexUser.ps1 -Email shengzhu@microsoft.com -Resend
  They never got, or lost, the invitation. Sends it again.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Email,
  [string]$DisplayName,
  # Entra group DISPLAY names, as they appear in the portal.
  [string[]]$Groups = @(),
  [switch]$NoEmail,
  [switch]$Resend,
  [string]$EnvironmentName
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Ok($t)    { Write-Host "  OK      $t" -ForegroundColor Green }
function Keep($t)  { Write-Host "  KEEP    $t" -ForegroundColor DarkGray }
function Warn2($t) { Write-Host "  WARN    $t" -ForegroundColor Yellow }
function Info($t)  { Write-Host "          $t" -ForegroundColor DarkGray }

# Directory calls made with a token cached before your directory roles changed
# are refused by continuous access evaluation, and the refusal reads like a
# missing permission. Same handling as Set-CortexAuth.ps1: clear, sign in
# again, and fall back to the device-code flow, which always re-authenticates.
$script:CaePattern = 'TokenCreatedWithOutdatedPolicies|InteractionRequired|AADSTS50173|AADSTS53003|AADSTS50076|claims challenge'
function Reset-AzSignIn {
  param([switch]$DeviceCode)
  if ($DeviceCode) {
    Info 'Device-code sign-in: open the address shown, enter the code, and pick the SAME account you use for this subscription.'
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
      Warn2 "Entra refused the CLI's cached token while $What. Signing you in again."
      Reset-AzSignIn
      $out = (& $Command 2>&1 | Out-String)
      if ($LASTEXITCODE -ne 0 -and $out -match $script:CaePattern) {
        Warn2 'Still refused. Using the device-code flow instead.'
        Reset-AzSignIn -DeviceCode
        $out = (& $Command 2>&1 | Out-String)
      }
    }
    if ($LASTEXITCODE -ne 0) { throw "$What failed: $($out.Trim())" }
    if ($Json) {
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
  $webUrl = $v['CORTEX_WEB_URL']
  if (-not $webUrl) { throw 'No deployment found in the azd environment. Run .\scripts\Deploy-Cortex.ps1 first.' }

  $acct = az account show | ConvertFrom-Json
  $script:subscriptionId = $acct.id

  Write-Host "`nAccess to Cortex for $Email`n" -ForegroundColor Cyan

  # The tenant's name, for the message — and a cheap pre-flight of the
  # directory token, so a stale one is refreshed here rather than mid-way.
  $org = Invoke-AzDirectory { az rest --method get --url 'https://graph.microsoft.com/v1.0/organization?$select=displayName' --only-show-errors } 'reading the tenant' -Json | ConvertFrom-Json
  $tenantName = if ($org.value) { $org.value[0].displayName } else { $acct.tenantId }

  # ------------------------------------------------------ 1 already here?
  # A member has the address as UPN; a guest has it as `mail` and a UPN of the
  # form name_domain.com#EXT#@tenant. Both are checked, the latter by prefix.
  $safe = $Email.Replace("'", "''")
  $select = '&$select=id,displayName,userPrincipalName,userType,externalUserState,mail'
  $url1 = 'https://graph.microsoft.com/v1.0/users?$filter=' + [uri]::EscapeDataString("mail eq '$safe' or userPrincipalName eq '$safe'") + $select
  $found = @((Invoke-AzDirectory { az rest --method get --url $url1 --only-show-errors } 'looking the person up in the directory' -Json | ConvertFrom-Json).value)
  if ($found.Count -eq 0) {
    $prefix = (($Email -replace '@', '_') + '#EXT#').Replace("'", "''")
    $url2 = 'https://graph.microsoft.com/v1.0/users?$filter=' + [uri]::EscapeDataString("startswith(userPrincipalName,'$prefix')") + $select
    $found = @((Invoke-AzDirectory { az rest --method get --url $url2 --only-show-errors } 'looking the guest up in the directory' -Json | ConvertFrom-Json).value)
  }
  $user = if ($found.Count -gt 0) { $found[0] } else { $null }
  $userId = $null

  # ------------------------------------------------------ 2 invite if not
  $needsInvite = (-not $user) -or ($Resend -and $user.userType -eq 'Guest')
  if ($user) {
    $userId = $user.id
    $state = if ($user.externalUserState) { " — invitation $($user.externalUserState)" } else { '' }
    Keep "$($user.displayName) is already in this tenant as a $($user.userType.ToLower())$state"
    if ($user.userType -eq 'Guest' -and $user.externalUserState -eq 'PendingAcceptance' -and -not $Resend) {
      Warn2 'They have not accepted their invitation yet. Nothing to do here; -Resend sends it again.'
    }
  }

  if ($needsInvite) {
    $body = @{
      invitedUserEmailAddress = $Email
      inviteRedirectUrl       = $webUrl
      sendInvitationMessage   = [bool](-not $NoEmail)
      invitedUserMessageInfo  = @{
        customizedMessageBody = "You have been given access to Cortex, the Defra data front door (proof of concept). Accept this invitation, then sign in at $webUrl with this email address."
      }
    }
    if ($DisplayName) { $body.invitedUserDisplayName = $DisplayName }
    if ($user) { $body.invitedUser = @{ id = $user.id }; $body.resetRedemption = $true }

    $tmp = New-TemporaryFile
    try {
      ($body | ConvertTo-Json -Depth 5 -Compress) | Set-Content -Path $tmp -Encoding utf8
      $inv = Invoke-AzDirectory {
        az rest --method post --url 'https://graph.microsoft.com/v1.0/invitations' --headers 'Content-Type=application/json' --body "@$tmp" --only-show-errors
      } 'sending the invitation' -Json | ConvertFrom-Json
    }
    catch {
      if ("$_" -match '403|Authorization_RequestDenied|Insufficient privileges') {
        throw ("Entra refused to create the invitation: you need Guest Inviter, User Administrator or Global Administrator in this tenant.`n" +
               "    By hand: Entra admin center → Users → New user → Invite external user → $Email, redirect to $webUrl")
      }
      throw
    }
    finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }

    $userId = $inv.invitedUser.id
    if ($user) { Ok "Invitation sent again to $Email" } else { Ok "Invitation created for $Email (guest object $userId)" }
    if ($NoEmail) {
      Info 'No email was sent. Pass this link on yourself — it works only for that address:'
      Info $inv.inviteRedeemUrl
    } else {
      Info "Microsoft has emailed an invitation from 'Microsoft Invitations on behalf of $tenantName'."
      Info 'Accepting it lands them on Cortex, where they sign in with that same address.'
    }
  }

  # ------------------------------------------------------ 3 groups
  # Membership decides what they see. Adding a guest to a group before they
  # have accepted the invitation is fine — it is in their token from the first
  # sign-in. The group must ALSO be mapped to a name Cortex's rules read
  # (CORTEX_GROUP_NAMES), or it is just an id in the token.
  $mapped = $v['CORTEX_GROUP_NAMES']
  foreach ($g in $Groups) {
    $gid = az ad group list --display-name $g --query '[0].id' -o tsv 2>$null
    if (-not $gid) {
      Warn2 "Entra group '$g' does not exist. Create it and map it in one go:  .\scripts\Set-CortexAuth.ps1 -GroupMap '<alias>=$g' -CreateGroups"
      continue
    }
    $isMember = az ad group member check --group $gid --member-id $userId --query value -o tsv 2>$null
    if ("$isMember" -eq 'true') {
      Keep "already in '$g'"
    } else {
      az ad group member add --group $gid --member-id $userId --only-show-errors
      if ($LASTEXITCODE -eq 0) { Ok "added to '$g'" }
      else { Warn2 "could not add to '$g' — you need to own the group or hold Groups Administrator" }
    }
    if (-not $mapped -or $mapped -notmatch [regex]::Escape($gid)) {
      Warn2 "'$g' is not yet mapped to a name Cortex reads, so it grants nothing yet:  .\scripts\Set-CortexAuth.ps1 -GroupMap '<alias>=$g'"
    }
  }

  # ------------------------------------------------------ 4 what next
  Write-Host ''
  Write-Host '  What happens next' -ForegroundColor Green
  Write-Host "   1. $Email accepts the invitation, or simply opens $webUrl and picks that account."
  Write-Host "      Use a private browser window if this computer is already signed in to Cortex as someone else."
  Write-Host "   2. First sign-in only: Entra asks them to accept $tenantName's terms, and may ask for MFA."
  Write-Host "   3. $webUrl/profile shows what they can see. Every signed-in person is treated as all-staff;"
  Write-Host '      anything more comes from the Entra groups above.'
  Write-Host ''
  Write-Host '  If redemption stops with an AADSTS error, the invitee''s HOME tenant blocks guest access to this' -ForegroundColor DarkGray
  Write-Host '  one (cross-tenant access settings). Nothing here can change that — use an account that lives in' -ForegroundColor DarkGray
  Write-Host '  this tenant for the demo instead.' -ForegroundColor DarkGray
  Write-Host ''
}
catch { Write-Host "  FAIL    $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
finally { Pop-Location }
