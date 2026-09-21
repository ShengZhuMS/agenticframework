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
    3. checks that this tenant TRUSTS MFA FROM THE GUEST'S HOME TENANT, and
       fixes it with -TrustHomeMfa. This tenant's baseline Conditional Access
       requires MFA of guests AND blocks them from registering a method here —
       so a guest can only sign in if their home tenant's MFA is accepted;
    4. says what they will see next, and what to do if their home tenant
       refuses.

  Needs: Guest Inviter, User Administrator or Global Administrator in this
  tenant. Adding to a group needs ownership of it or Groups Administrator.

.EXAMPLE
  .\scripts\Add-CortexUser.ps1 -Email shengzhu@microsoft.com
  Invite your corporate account. It arrives as a guest, is treated as all-staff
  like every signed-in user, and sees the "Open to all staff" entries.

.EXAMPLE
  .\scripts\Add-CortexUser.ps1 -Email colleague@example.com -Groups 'Cortex Operations'
  Invite, and put them in an Entra group that an access rule reads — the
  "same page through different eyes" demo.

.EXAMPLE
  .\scripts\Add-CortexUser.ps1 -Email shengzhu@microsoft.com -NoEmail
  Create the invitation without Microsoft's email; the redemption link is
  printed for you to pass on yourself.

.EXAMPLE
  .\scripts\Add-CortexUser.ps1 -Email shengzhu@microsoft.com -Resend
  They never got, or lost, the invitation. Sends it again.

.EXAMPLE
  .\scripts\Add-CortexUser.ps1 -Email shengzhu@microsoft.com -TrustHomeMfa
  The guest is stopped at sign-in by "Require multifactor authentication" and
  is never offered the set-up screen. Turn on "Trust multifactor authentication
  from Microsoft Entra tenants" in this tenant's inbound cross-tenant access
  defaults, so the MFA they already did at home is accepted here.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Email,
  [string]$DisplayName,
  # Entra group DISPLAY names, as they appear in the portal.
  [string[]]$Groups = @(),
  [switch]$NoEmail,
  [switch]$Resend,
  [switch]$TrustHomeMfa,
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
      # Warnings can precede the JSON and a stray line can follow it; keep the
      # span from the first opening bracket to the last closing one.
      $i = $out.IndexOf('{'); $j = $out.IndexOf('[')
      $start = @($i, $j) | Where-Object { $_ -ge 0 } | Sort-Object | Select-Object -First 1
      $end = [Math]::Max($out.LastIndexOf('}'), $out.LastIndexOf(']'))
      if ($null -ne $start -and $end -ge $start) { return $out.Substring($start, $end - $start + 1) }
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

  if ($Email -notmatch '^[^\s"''<>&|()]+@[^\s"''<>&|()]+$') {
    throw "'$Email' does not look like an email address this script can look up safely."
  }

  Write-Host "`nAccess to Cortex for $Email`n" -ForegroundColor Cyan

  # GRAPH QUERIES AND THE WINDOWS CLI. On Windows `az` is a .cmd wrapper, so
  # its arguments pass through cmd.exe, which treats an unquoted `&` as a
  # command separator and an unquoted `)` as the end of a block. A URL such as
  # users?$filter=...&$select=... therefore ran as TWO commands — the second
  # being "'$select' is not recognized as an internal or external command" —
  # and a startswith(...) filter can end az.cmd's own IF block early. So no
  # query string is ever written into --url here. Parameters go through
  # `az rest --uri-parameters`, one argument each; the CLI URL-encodes them.
  # Nor is the `%26` trick an answer: an encoded ampersand is data, not a
  # separator, and Graph would read it as part of the filter.
  function GraphArgs([string]$path, [string[]]$params) {
    $a = @('rest', '--method', 'get', '--url', "https://graph.microsoft.com/v1.0/$path", '--only-show-errors')
    if ($params -and $params.Count -gt 0) { $a += '--uri-parameters'; $a += $params }
    return $a
  }

  # The tenant's name and its initial *.onmicrosoft.com domain (a guest's UPN is
  # built on it) — and a cheap pre-flight of the directory token, so a stale one
  # is refreshed here rather than mid-way.
  $orgArgs = GraphArgs 'organization' @('$select=displayName,verifiedDomains')
  $org = Invoke-AzDirectory { az @orgArgs } 'reading the tenant' -Json | ConvertFrom-Json
  $tenantName = if ($org.value) { $org.value[0].displayName } else { $acct.tenantId }
  $initialDomain = if ($org.value) { ($org.value[0].verifiedDomains | Where-Object { $_.isInitial }).name } else { $null }

  # ------------------------------------------------------ 1 already here?
  # A member has the address as UPN; an invited guest has it as `mail` and a
  # UPN of the form name_domain.com#EXT#@<initial domain>. Both are tried.
  # (No startswith(): parentheses are the other thing cmd.exe acts on.)
  $safe = $Email.Replace("'", "''")
  $select = '$select=id,displayName,userPrincipalName,userType,externalUserState,mail'
  $lookup = GraphArgs 'users' @("`$filter=mail eq '$safe' or userPrincipalName eq '$safe'", $select)
  $found = @((Invoke-AzDirectory { az @lookup } 'looking the person up in the directory' -Json | ConvertFrom-Json).value)
  if ($found.Count -eq 0 -and $initialDomain) {
    $extUpn = ((($Email -replace '@', '_') + "#EXT#@$initialDomain")).Replace("'", "''")
    $lookup = GraphArgs 'users' @("`$filter=userPrincipalName eq '$extUpn'", $select)
    $found = @((Invoke-AzDirectory { az @lookup } 'looking the guest up in the directory' -Json | ConvertFrom-Json).value)
  }
  $user = if ($found.Count -gt 0) { $found[0] } else { $null }
  $userId = $null

  # ------------------------------------------------------ 2 invite if not
  $needsInvite = (-not $user) -or ($Resend -and $user.userType -eq 'Guest')
  if ($user) {
    $userId = $user.id
    $type = if ($user.userType) { $user.userType.ToLower() } else { 'user' }
    $state = if ($user.externalUserState) { " — invitation $($user.externalUserState)" } else { '' }
    Keep "$($user.displayName) is already in this tenant as a $type$state"
    if ($user.userType -eq 'Guest' -and $user.externalUserState -eq 'PendingAcceptance' -and -not $Resend) {
      Warn2 'They have not accepted their invitation yet. Nothing to do here; -Resend sends it again.'
    } elseif ($user.userType -eq 'Guest' -and -not $Resend) {
      Ok "Nothing to invite. $Email can sign in to Cortex now — open $webUrl in a private window and pick that account."
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

  # ------------------------------------------------------ 4 MFA for guests
  #
  # THE DEADLOCK. This tenant's baseline Conditional Access has two policies
  # for "Microsoft partners and vendors" — its name for external users:
  #   "Multifactor authentication for ..."     Require MFA
  #   "Security info registration for ..."     BLOCK
  # A guest must do MFA, and may not register a method here to do it with. The
  # sign-in log shows both as Failure and the person is never offered the
  # set-up screen. The intended answer is not to weaken either policy but to
  # ACCEPT THE MFA THE GUEST ALREADY DID AT HOME: inbound trust in cross-tenant
  # access settings. Read-only unless -TrustHomeMfa is given.
  $trustArgs = GraphArgs 'policies/crossTenantAccessPolicy/default' @('$select=inboundTrust')
  $trust = $null
  try { $trust = Invoke-AzDirectory { az @trustArgs } 'reading the cross-tenant access defaults' -Json | ConvertFrom-Json } catch { $trust = $null }
  $mfaTrusted = $trust -and $trust.inboundTrust -and $trust.inboundTrust.isMfaAccepted -eq $true
  $portalPath = 'Entra admin center -> External Identities -> Cross-tenant access settings -> Default settings -> Inbound access settings -> Edit inbound defaults -> Trust settings -> tick "Trust multifactor authentication from Microsoft Entra tenants"'

  if ($mfaTrusted) {
    Keep 'This tenant trusts MFA from the guest''s home tenant (inbound cross-tenant access)'
  } elseif ($TrustHomeMfa) {
    $tmp = New-TemporaryFile
    try {
      '{"inboundTrust":{"isMfaAccepted":true}}' | Set-Content -Path $tmp -Encoding utf8
      $null = Invoke-AzDirectory {
        az rest --method patch --url 'https://graph.microsoft.com/v1.0/policies/crossTenantAccessPolicy/default' --headers 'Content-Type=application/json' --body "@$tmp" --only-show-errors
      } 'turning on inbound MFA trust'
      Ok 'This tenant now trusts MFA from the guest''s home tenant. They must sign out fully and sign in again.'
      $mfaTrusted = $true
    } catch {
      Warn2 "Could not change the cross-tenant access defaults from here: $($_.Exception.Message)"
      Info  'You need Security Administrator or Global Administrator. By hand (two minutes):'
      Info  $portalPath
    } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  } else {
    Warn2 'This tenant does NOT trust MFA from other tenants, and its Conditional Access requires MFA of guests'
    Warn2 'while blocking them from registering a method here. A guest will be stopped at sign-in and never'
    Warn2 'offered the set-up screen. Fix:  .\scripts\Add-CortexUser.ps1 -Email <address> -TrustHomeMfa'
    Info  "or by hand: $portalPath"
  }

  # ------------------------------------------------------ 5 what next
  Write-Host ''
  Write-Host '  What happens next' -ForegroundColor Green
  Write-Host "   1. $Email accepts the invitation, or simply opens $webUrl and picks that account."
  Write-Host "      Use a private browser window if this computer is already signed in to Cortex as someone else."
  Write-Host "   2. First sign-in only: Entra asks them to accept $tenantName's terms. The MFA they did at home is"
  Write-Host '      accepted here — they are not asked to set anything up in this tenant.'
  Write-Host "   3. $webUrl/profile shows what they can see. Every signed-in person is treated as all-staff;"
  Write-Host '      anything more comes from the Entra groups above.'
  Write-Host ''
  Write-Host '  Still stopped by "Require multifactor authentication"? Their HOME tenant did not perform MFA for' -ForegroundColor DarkGray
  Write-Host '  that sign-in, so there is nothing to trust. Either exclude a "Cortex testers" group from the two' -ForegroundColor DarkGray
  Write-Host '  "partners and vendors" policies, or give them a member account in this tenant — members are not' -ForegroundColor DarkGray
  Write-Host '  targeted by those policies and may register MFA normally. The latter is the safer demo.' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '  If redemption stops with an AADSTS error instead, the invitee''s HOME tenant blocks guest access to' -ForegroundColor DarkGray
  Write-Host '  this one (its own cross-tenant settings). Nothing here can change that.' -ForegroundColor DarkGray
  Write-Host ''
}
catch { Write-Host "  FAIL    $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
finally { Pop-Location }
