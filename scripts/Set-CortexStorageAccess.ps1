<#
.SYNOPSIS
  Check — and repair — network access to the storage accounts Cortex created,
  when a tenant Azure Policy has changed them after provisioning. Safe to
  run repeatedly.

.DESCRIPTION
  THE FAILURE THIS SCRIPT EXISTS FOR

    FAIL  storage — Storage PUT /products failed 403:
          <Code>AuthorizationFailure</Code>
          <Message>This request is not authorized to perform this operation.

  That is not a missing role. Storage answers two different 403s and the
  difference is the whole diagnosis:

    AuthorizationFailure             the account's NETWORK RULES refused the
                                     caller — public network access is off or
                                     the default action is Deny
    AuthorizationPermissionMismatch  the caller holds no data-plane ROLE

  infra/modules/data.bicep creates both accounts with public network access
  Enabled and the default action Allow. When they later read otherwise,
  something changed them after the deployment — in a managed sandbox that is
  a tenant Azure Policy with a Modify or DeployIfNotExists effect, the same
  family that disabled public access on the Key Vault. The effects for Cortex:

    sample-data account   bootstrap cannot upload, the Data Map scan finds
                          nothing, every AI Search indexer fails
    state account         the Azure Files share cannot be mounted, so the
                          cortex-web container never starts and every path on
                          it answers 404 — from the platform, not the app

  WHAT IT DOES, IN ORDER
    1. Reads both accounts: publicNetworkAccess, networkAcls.defaultAction,
       allowSharedKeyAccess (the state share is mounted with the account key).
    2. Finds the policy assignments that evaluated those accounts with an
       effect that can change or block them (modify, deployIfNotExists, deny,
       append) and whose rule touches those three properties.
    3. Creates a policy EXEMPTION (category Waiver) on the Cortex resource
       group for each such assignment — narrowed to the offending definitions
       when the assignment is an initiative — so the settings stay put.
       Skipped with -NoExemption; nothing is written with -ReportOnly.
    4. Puts the settings back to what the Bicep intended.
    5. Verifies from this machine with a data-plane call using your sign-in,
       and grants you Storage Blob Data Contributor if that is what is missing.

  Exemptions need Microsoft.Authorization/policyExemptions/write on the
  resource group (Owner or Resource Policy Contributor). Without it the exact
  command is printed for whoever has it, and the settings are still repaired —
  a Modify policy may then put them back within about 24 hours, which is why
  Deploy-Cortex.ps1 runs this on every deployment.

.EXAMPLE
  .\scripts\Set-CortexStorageAccess.ps1
  Report, exempt, repair, verify. Reads the account names from the azd environment.

.EXAMPLE
  .\scripts\Set-CortexStorageAccess.ps1 -ReportOnly
  Say what is wrong and which policy did it. Change nothing.

.EXAMPLE
  .\scripts\Set-CortexStorageAccess.ps1 -NoExemption
  Repair the settings without touching Azure Policy.
#>
[CmdletBinding()]
param(
  [string]$EnvironmentName,
  [string]$ResourceGroup,
  [string]$DataAccount,
  [string]$StateAccount,
  [switch]$ReportOnly,
  [switch]$NoExemption,
  [int]$ExpiresInDays = 90,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Ok($t)    { Write-Host "  OK      $t" -ForegroundColor Green }
function Keep($t)  { Write-Host "  KEEP    $t" -ForegroundColor DarkGray }
function Warn2($t) { Write-Host "  WARN    $t" -ForegroundColor Yellow }
function Fail($t)  { Write-Host "  FAIL    $t" -ForegroundColor Red }
function Info($t)  { Write-Host "          $t" -ForegroundColor DarkGray }

# Run az and return parsed JSON or $null. Probes are allowed to answer "no".
function Get-AzJson {
  param([string[]]$Arguments)
  $out = & az @Arguments 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  try { return ($out | ConvertFrom-Json) } catch { return $null }
}

# Exit codes, so Deploy-Cortex.ps1 can tell the three outcomes apart:
#   0  nothing was wrong          2  drift found and repaired
#   1  drift found and NOT repaired (report-only, or the repair was refused)
$script:exit = 0

try {
  # ------------------------------------------------------------ 1 names
  if (-not $ResourceGroup -or -not $DataAccount -or -not $StateAccount) {
    if ($EnvironmentName) { azd env select $EnvironmentName 2>$null | Out-Null }
    azd env get-values 2>$null | ForEach-Object {
      if (-not $ResourceGroup -and $_ -match '^AZURE_RESOURCE_GROUP="?([^"]*)"?$')     { $ResourceGroup = $Matches[1] }
      if (-not $DataAccount   -and $_ -match '^DATA_STORAGE_ACCOUNT="?([^"]*)"?$')    { $DataAccount   = $Matches[1] }
      if (-not $StateAccount  -and $_ -match '^STATE_STORAGE_ACCOUNT="?([^"]*)"?$')   { $StateAccount  = $Matches[1] }
    }
  }
  if (-not $ResourceGroup) { throw 'No resource group. Pass -ResourceGroup, or run from a folder with an azd environment.' }
  $accounts = @()
  if ($DataAccount)  { $accounts += @{ Name = $DataAccount;  Role = 'sample data'; SharedKey = $null } }
  if ($StateAccount) { $accounts += @{ Name = $StateAccount; Role = 'state share'; SharedKey = $true } }
  if ($accounts.Count -eq 0) {
    Keep 'No storage accounts in this environment (deployed with -NoData). Nothing to check.'
    exit 0
  }

  $sub  = az account show --query id -o tsv 2>$null
  $rgId = "/subscriptions/$sub/resourceGroups/$ResourceGroup"

  if (-not $Quiet) { Write-Host "`nStorage network access in $ResourceGroup`n" }

  # ----------------------------------------------------------- 2 read
  # What the Bicep set, and what is live. Drift in any of the three is the
  # signal; which of them drifted says what broke.
  $drifted = @()
  foreach ($a in $accounts) {
    $live = Get-AzJson @('storage','account','show','-n',$a.Name,'-g',$ResourceGroup,'-o','json')
    if (-not $live) { Fail "$($a.Name) not found in $ResourceGroup"; $script:exit = 1; continue }
    $a.Id        = $live.id
    $a.Pna       = $live.publicNetworkAccess
    $a.Action    = $live.networkRuleSet.defaultAction
    $a.Bypass    = $live.networkRuleSet.bypass
    $a.KeyAccess = $live.allowSharedKeyAccess
    $problems = @()
    # Unset means the Azure default, which is open; only an explicit value can be drift.
    if ($a.Pna -and $a.Pna -ne 'Enabled')     { $problems += "public network access is $($a.Pna)" }
    if ($a.Action -and $a.Action -ne 'Allow') { $problems += "default action is $($a.Action)" }
    if ($a.SharedKey -eq $true -and $a.KeyAccess -eq $false) { $problems += 'shared-key access is off (the share is mounted with the account key)' }
    if ($problems.Count -eq 0) {
      Ok "$($a.Name) ($($a.Role)) — public endpoint open, default action Allow"
    } else {
      Fail "$($a.Name) ($($a.Role)) — $($problems -join '; ')"
      $a.Problems = $problems
      $drifted += $a
    }
  }

  if ($drifted.Count -eq 0) {
    if (-not $Quiet) { Write-Host '' }
    exit 0
  }

  Info 'infra/modules/data.bicep created these with public access Enabled and default action Allow.'
  Info 'Something changed them after provisioning — in a managed sandbox that is a tenant Azure Policy.'

  # -------------------------------------------------- 3 which policy did it
  # Policy Insights records every assignment that evaluated a resource, with
  # the effect it applied. Only effects that can CHANGE or BLOCK a resource
  # matter here; audit and auditIfNotExists only report.
  $culprits = @{}   # assignmentId -> @{ Name; Refs = [set of definition reference ids]; Effects }
  $changing = @('modify','deployifnotexists','deny','append')
  $fields = 'publicNetworkAccess|networkAcls|defaultAction|allowSharedKeyAccess'
  $definitionCache = @{}
  foreach ($a in $drifted) {
    $states = Get-AzJson @('policy','state','list','--resource',$a.Id,'-o','json')
    if (-not $states) { continue }
    foreach ($s in @($states)) {
      $effect = "$($s.policyDefinitionAction)".ToLower()
      if ($effect -notin $changing) { continue }
      $defId = $s.policyDefinitionId
      if (-not $definitionCache.ContainsKey($defId)) {
        # Works for built-in, subscription and management-group definitions alike.
        $def = Get-AzJson @('rest','--method','get','--url',"https://management.azure.com${defId}?api-version=2023-04-01")
        $rule = if ($def) { ($def.properties.policyRule | ConvertTo-Json -Depth 30 -Compress) } else { '' }
        $definitionCache[$defId] = @{ Touches = ($rule -match 'Microsoft.Storage/storageAccounts' -and $rule -match $fields); Name = $def.properties.displayName }
      }
      if (-not $definitionCache[$defId].Touches) { continue }
      $key = $s.policyAssignmentId
      if (-not $culprits.ContainsKey($key)) {
        $culprits[$key] = @{ Name = $s.policyAssignmentName; Display = $definitionCache[$defId].Name; Refs = @(); Effects = @(); Initiative = [bool]$s.policySetDefinitionId }
      }
      if ($s.policyDefinitionReferenceId -and $culprits[$key].Refs -notcontains $s.policyDefinitionReferenceId) { $culprits[$key].Refs += $s.policyDefinitionReferenceId }
      if ($culprits[$key].Effects -notcontains $effect) { $culprits[$key].Effects += $effect }
    }
  }

  if ($culprits.Count -gt 0) {
    foreach ($k in $culprits.Keys) {
      $c = $culprits[$k]
      Warn2 "Policy assignment '$($c.Name)' ($($c.Effects -join ', ')) — $($c.Display)"
      Info  $k
    }
  } else {
    Warn2 'No policy assignment with a changing effect could be attributed to these accounts.'
    # The Activity Log names whoever wrote the account. A policy remediation
    # shows the assignment's managed identity as the caller.
    foreach ($a in $drifted) {
      # No `&&` or `|` in the query: on Windows `az` is a .cmd and its arguments
      # pass through cmd.exe. The status is filtered here instead.
      $log = Get-AzJson @('monitor','activity-log','list','--resource-id',$a.Id,'--offset','3d','--query',"[?operationName.value=='Microsoft.Storage/storageAccounts/write'].{time:eventTimestamp, caller:caller, status:status.value}",'-o','json')
      foreach ($e in (@($log) | Where-Object { $_.status -eq 'Succeeded' } | Select-Object -First 5)) { Info "$($a.Name) written $($e.time) by $($e.caller)" }
    }
    Info 'If the settings come back after this repair, that caller is what to exempt.'
  }

  if ($ReportOnly) {
    Write-Host ''
    Warn2 'Report only — nothing was changed. Run without -ReportOnly to repair.'
    exit 1
  }

  # ---------------------------------------------------------- 4 exempt
  # An exemption is scoped to the Cortex resource group and, for an
  # initiative, to the definitions that actually touch these settings — the
  # rest of the initiative keeps applying. Waiver, because the sandbox has no
  # private endpoints or VNet for a compliant alternative; the expiry keeps
  # it honest.
  $expires = (Get-Date).ToUniversalTime().AddDays($ExpiresInDays).ToString('yyyy-MM-ddTHH:mm:ssZ')
  if ($culprits.Count -gt 0 -and -not $NoExemption) {
    foreach ($k in $culprits.Keys) {
      $c = $culprits[$k]
      $hash = [BitConverter]::ToString([System.Security.Cryptography.SHA1]::HashData([Text.Encoding]::UTF8.GetBytes($k))).Replace('-','').Substring(0,10).ToLower()
      $exName = "cortex-storage-$hash"
      $have = Get-AzJson @('policy','exemption','show','--name',$exName,'--scope',$rgId,'-o','json')
      if ($have) { Keep "Exemption $exName already covers '$($c.Name)'"; continue }
      $exArgs = @('policy','exemption','create','--name',$exName,'--policy-assignment',$k,'--scope',$rgId,
                '--exemption-category','Waiver','--expires-on',$expires,
                '--display-name',"Cortex PoC — storage public endpoint ($($c.Name))",
                '--description','Cortex proof of concept: the sample-data and state storage accounts are reached over the public endpoint with Entra authentication. No VNet or private endpoints exist in this phase. Remove when the full build adds them.',
                '--only-show-errors','-o','none')
      if ($c.Initiative -and $c.Refs.Count -gt 0) { $exArgs += '--policy-definition-reference-ids'; $exArgs += $c.Refs }
      $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      $err = (& az @exArgs 2>&1 | Out-String)
      $rc = $LASTEXITCODE
      $ErrorActionPreference = $prev
      if ($rc -eq 0) {
        Ok "Exemption $exName created for '$($c.Name)' (expires $($expires.Substring(0,10)))"
      } else {
        Warn2 "Could not create the exemption for '$($c.Name)'."
        if ($err -match 'AuthorizationFailed|does not have authorization') {
          Info 'You lack Microsoft.Authorization/policyExemptions/write on the resource group. Ask an Owner to run:'
        } else {
          Info ((($err.Trim() -split "`n") | Select-Object -First 2) -join ' ')
          Info 'Command to run by hand:'
        }
        $refs = if ($c.Initiative -and $c.Refs.Count -gt 0) { " --policy-definition-reference-ids $($c.Refs -join ' ')" } else { '' }
        Write-Host "    az policy exemption create --name $exName --policy-assignment '$k' --scope '$rgId' --exemption-category Waiver --expires-on $expires --display-name 'Cortex PoC storage'$refs"
        Info 'Without it a Modify policy can put the settings back within about a day; re-running this script repairs them again.'
      }
    }
  } elseif ($NoExemption -and $culprits.Count -gt 0) {
    Warn2 'Exemptions skipped (-NoExemption). The policy may revert the settings within about a day.'
  }

  # ---------------------------------------------------------- 5 repair
  # Two ways a policy fights back, both handled by waiting for the exemption:
  #   Deny    — the update is refused outright (RequestDisallowedByPolicy).
  #   Modify  — the update "succeeds" but the effect rewrites the properties
  #             on the way in, so the account reads exactly as before. That is
  #             why every update is read back rather than trusted.
  # Exemptions take a minute or two to apply, hence the pauses.
  $repaired = 0
  foreach ($a in $drifted) {
    $update = @('storage','account','update','-n',$a.Name,'-g',$ResourceGroup,
                '--public-network-access','Enabled','--default-action','Allow','--bypass','AzureServices','--only-show-errors','-o','none')
    if ($a.SharedKey -eq $true) { $update += @('--allow-shared-key-access','true') }
    $done = $false
    $err = ''
    foreach ($attempt in 1..5) {
      $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      $err = (& az @update 2>&1 | Out-String)
      $rc = $LASTEXITCODE
      $ErrorActionPreference = $prev
      if ($rc -eq 0) {
        $after = Get-AzJson @('storage','account','show','-n',$a.Name,'-g',$ResourceGroup,'-o','json')
        $stillLocked = ($after.publicNetworkAccess -and $after.publicNetworkAccess -ne 'Enabled') -or
                       ($after.networkRuleSet.defaultAction -and $after.networkRuleSet.defaultAction -ne 'Allow') -or
                       ($a.SharedKey -eq $true -and $after.allowSharedKeyAccess -eq $false)
        if (-not $stillLocked) { $done = $true; break }
        $err = 'a Modify policy rewrote the settings on the way in'
        if ($attempt -lt 5) { Info "The update went through but a Modify policy put the lock straight back — waiting 30 seconds for the exemption to take effect (attempt $attempt of 5)"; Start-Sleep -Seconds 30 }
      } elseif ($err -match 'RequestDisallowedByPolicy') {
        if ($attempt -lt 5) { Info "A Deny policy still refuses the change — waiting 30 seconds for the exemption to apply (attempt $attempt of 5)"; Start-Sleep -Seconds 30 }
      } else {
        Fail "$($a.Name) — $((($err.Trim()) -split "`n" | Select-Object -First 1))"
        break
      }
    }
    if ($done) {
      $repaired++
      Ok "$($a.Name) — public endpoint re-enabled, default action Allow$(if ($a.SharedKey) { ', shared-key access on' })"
    } else {
      $script:exit = 1
      Fail "$($a.Name) could not be repaired ($((($err.Trim()) -split "`n" | Select-Object -First 1)))."
      if ($err -match 'RequestDisallowedByPolicy|Modify policy') {
        Info 'The policy is still winning. An exemption can take several minutes to take effect: wait, then run this again.'
        Info 'If no exemption could be created, an Owner needs to create it (command above), or deploy without the share:'
        Info '    .\scripts\Deploy-Cortex.ps1 -NoStateShare   (state in memory; the data chain still needs the sample-data account open)'
      }
    }
  }

  # ---------------------------------------------------------- 6 verify
  # The proof is a data-plane call from here with your own sign-in — the same
  # thing bootstrap does. Network rules take a few seconds to apply.
  if ($DataAccount -and ($drifted | Where-Object { $_.Name -eq $DataAccount })) {
    $me = az ad signed-in-user show --query id -o tsv 2>$null
    $verified = $false
    foreach ($attempt in 1..4) {
      $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      $err = (az storage container list --account-name $DataAccount --auth-mode login --only-show-errors -o none 2>&1 | Out-String)
      $rc = $LASTEXITCODE
      $ErrorActionPreference = $prev
      if ($rc -eq 0) { $verified = $true; break }
      if ($err -match 'AuthorizationPermissionMismatch|required permissions|does not have permission') {
        # Network is fine; the role is what is missing. Grant it and try once more.
        if ($me) {
          Warn2 'The network answers; your account holds no data-plane role on it. Granting Storage Blob Data Contributor.'
          $dataId = ($drifted | Where-Object { $_.Name -eq $DataAccount }).Id
          az role assignment create --assignee-object-id $me --assignee-principal-type User --role 'Storage Blob Data Contributor' --scope $dataId --only-show-errors -o none 2>$null
          Info 'A new role assignment can take up to five minutes to apply — trying again in 20 seconds.'
          Start-Sleep -Seconds 20
        }
      } elseif ($err -match 'AuthorizationFailure|blocked by network rules|network rule' -and $attempt -lt 4) {
        Info "Network rules not applied yet — retrying in 15 seconds (attempt $attempt of 4)"
        Start-Sleep -Seconds 15
      } else { break }
    }
    if ($verified) { Ok "$DataAccount answers a data-plane call from this machine" }
    elseif ($err -match 'AuthorizationPermissionMismatch|required permissions|does not have permission') { Warn2 "$DataAccount is reachable; the role grant is still propagating. Re-run bootstrap in a few minutes." }
    else { $script:exit = 1; Fail "$DataAccount still refuses this machine — $((($err.Trim()) -split "`n" | Select-Object -First 1))" }
  }

  if ($repaired -gt 0 -and $script:exit -eq 0) { $script:exit = 2 }
  Write-Host ''
  if ($script:exit -eq 2) {
    Ok 'Repaired. If cortex-web was down, restart its revision (Deploy-Cortex.ps1 does this) and re-run bootstrap:'
    Info '    . .\scripts\Set-CortexEnv.ps1'
    Info '    node scripts/bootstrap.js --only=data'
    Info '    node scripts/bootstrap.js --only=search'
  }
  exit $script:exit
}
catch { Fail $_.Exception.Message; exit 1 }
finally { Pop-Location }
