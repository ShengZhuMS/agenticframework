<#
.SYNOPSIS
  Check — and repair — how the Cortex storage accounts are reached, in a
  tenant whose policy closes every storage account's public endpoint. Safe to
  run repeatedly.

.DESCRIPTION
  THE POLICY
  Management-group assignment "MCAPSGovDeployPolicies" applies, with a Modify
  effect, "SFI - Disable public network access on Storage accounts (excluding
  NSP configured resources)" and "disable local auth". It rewrites any update
  that leaves the public endpoint open, and switches account keys off. The
  first live run of round 4 showed both:

    FAIL  storage — 403 AuthorizationFailure       (the firewall code)
    FailedMount ... mount error(13): Permission denied   (keys are off)

  THE ANSWER THE POLICY ITSELF NAMES
  A storage account inside a Network Security Perimeter, with public network
  access set to SecuredByPerimeter, is excluded from the policy and governed by
  the perimeter's rules instead. infra/modules/nsp.bicep creates the perimeter
  and associates both accounts; the perimeter admits Entra-authenticated
  traffic from managed identities in this subscription and nothing else. No
  keys are used anywhere any more (state moved from a file share to blobs).

  WHAT THIS SCRIPT DOES, IN ORDER
    1. Reads both accounts: publicNetworkAccess, default action, key access.
    2. Reads the perimeter's associations and checks both accounts are in it.
    3. Finds the policy assignments that touched the accounts (Policy
       Insights), and — belt and braces — creates a policy EXEMPTION for them
       on the Cortex resource group (Waiver, -ExpiresInDays, default 90).
       -NoExemption skips it.
    4. Puts publicNetworkAccess to SecuredByPerimeter (perimeter mode) or
       Enabled (no perimeter), reads it back, and retries while the policy is
       still winning — a Modify effect rewrites an update on the way in, so a
       successful update proves nothing until it is read back.
    5. Records SecuredByPerimeter in the azd environment so the next provision
       writes it directly.

  Your laptop is outside the perimeter by design, so there is no data-plane
  check from here in perimeter mode: the bootstrap job (Deploy-Cortex.ps1 step
  11) is the proof, from inside Azure as the Cortex identity.

  Exit codes: 0 nothing was wrong · 2 drift found and repaired · 1 drift found
  and not repaired (or -ReportOnly).

.EXAMPLE
  .\scripts\Set-CortexStorageAccess.ps1
  Check, exempt, repair. Reads names from the azd environment.

.EXAMPLE
  .\scripts\Set-CortexStorageAccess.ps1 -ReportOnly
  Say what is wrong and which policy did it. Change nothing.
#>
[CmdletBinding()]
param(
  [string]$EnvironmentName,
  [string]$ResourceGroup,
  [string]$DataAccount,
  [string]$StateAccount,
  # The perimeter name. Empty = read NSP_NAME from the azd environment; if that
  # is empty too, the accounts are expected on their own rules (public Enabled).
  [string]$Perimeter,
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

# Run az, capturing stderr as text, without tripping $ErrorActionPreference.
function Invoke-AzText {
  param([string[]]$Arguments)
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $text = (& az @Arguments 2>&1 | Out-String)
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $prev
  return @{ rc = $rc; text = $text }
}

$script:exit = 0

try {
  # ------------------------------------------------------------ 1 names
  $envValues = @{}
  if (-not $ResourceGroup -or -not $DataAccount -or -not $StateAccount -or -not $PSBoundParameters.ContainsKey('Perimeter')) {
    if ($EnvironmentName) { azd env select $EnvironmentName 2>$null | Out-Null }
    azd env get-values 2>$null | ForEach-Object { if ($_ -match '^(\w+)="?([^"]*)"?$') { $envValues[$Matches[1]] = $Matches[2] } }
    if (-not $ResourceGroup) { $ResourceGroup = $envValues['AZURE_RESOURCE_GROUP'] }
    if (-not $DataAccount)   { $DataAccount   = $envValues['DATA_STORAGE_ACCOUNT'] }
    if (-not $StateAccount)  { $StateAccount  = $envValues['STATE_STORAGE_ACCOUNT'] }
    if (-not $PSBoundParameters.ContainsKey('Perimeter')) { $Perimeter = $envValues['NSP_NAME'] }
  }
  if (-not $ResourceGroup) { throw 'No resource group. Pass -ResourceGroup, or run from a folder with an azd environment.' }
  $accounts = @()
  if ($DataAccount)  { $accounts += @{ Name = $DataAccount;  Role = 'sample data' } }
  if ($StateAccount) { $accounts += @{ Name = $StateAccount; Role = 'state blobs' } }
  if ($accounts.Count -eq 0) {
    Keep 'No storage accounts in this environment (deployed with -NoData). Nothing to check.'
    exit 0
  }

  $sub  = az account show --query id -o tsv 2>$null
  $rgId = "/subscriptions/$sub/resourceGroups/$ResourceGroup"
  $perimeterMode = [bool]$Perimeter
  $wantPna = if ($perimeterMode) { 'SecuredByPerimeter' } else { 'Enabled' }

  if (-not $Quiet) {
    Write-Host "`nStorage network access in $ResourceGroup" -NoNewline
    Write-Host $(if ($perimeterMode) { " — perimeter $Perimeter`n" } else { " — no perimeter`n" })
  }

  # -------------------------------------------------- 2 the perimeter
  # Associations are read from ARM directly: no CLI extension needed, and the
  # same call works whether or not `az network perimeter` is installed.
  $associated = @{}
  if ($perimeterMode) {
    $assoc = Get-AzJson @('rest','--method','get','--url',"https://management.azure.com$rgId/providers/Microsoft.Network/networkSecurityPerimeters/$Perimeter/resourceAssociations?api-version=2024-07-01")
    if (-not $assoc) {
      Fail "Perimeter $Perimeter was not found in $ResourceGroup (or could not be read). Provision first: .\scripts\Deploy-Cortex.ps1"
      $script:exit = 1
    } else {
      foreach ($a in @($assoc.value)) {
        $rid = "$($a.properties.privateLinkResource.id)".ToLower()
        $associated[$rid] = @{ mode = $a.properties.accessMode; state = $a.properties.provisioningState; name = $a.name }
      }
    }
  }

  # ----------------------------------------------------------- 3 read
  $drifted = @()
  foreach ($a in $accounts) {
    $live = Get-AzJson @('storage','account','show','-n',$a.Name,'-g',$ResourceGroup,'-o','json')
    if (-not $live) { Fail "$($a.Name) not found in $ResourceGroup"; $script:exit = 1; continue }
    $a.Id        = $live.id
    $a.Pna       = "$($live.publicNetworkAccess)"
    $a.Action    = "$($live.networkRuleSet.defaultAction)"
    $a.KeyAccess = $live.allowSharedKeyAccess
    $problems = @()
    if ($perimeterMode) {
      $assocInfo = $associated["$($a.Id)".ToLower()]
      if ($assoc -and -not $assocInfo) { $problems += "not associated with perimeter $Perimeter" }
      elseif ($assocInfo -and $assocInfo.state -and $assocInfo.state -ne 'Succeeded') { $problems += "association is $($assocInfo.state)" }
      if ($a.Pna -ne 'SecuredByPerimeter') { $problems += "public network access is $($a.Pna) (wanted SecuredByPerimeter)" }
      $a.Repairable = [bool]$assocInfo   # the value is only accepted once the association exists
    } else {
      if ($a.Pna -and $a.Pna -ne 'Enabled')     { $problems += "public network access is $($a.Pna)" }
      if ($a.Action -and $a.Action -ne 'Allow') { $problems += "default action is $($a.Action)" }
      $a.Repairable = $true
    }
    if ($problems.Count -eq 0) {
      $how = if ($perimeterMode) { "SecuredByPerimeter, $($associated["$($a.Id)".ToLower()].mode) in $Perimeter" } else { 'public endpoint open, default action Allow' }
      Ok "$($a.Name) ($($a.Role)) — $how$(if ($a.KeyAccess -eq $false) { ', keyless' })"
    } else {
      Fail "$($a.Name) ($($a.Role)) — $($problems -join '; ')"
      $a.Problems = $problems
      $drifted += $a
    }
  }

  # ------------------------------------------------ 4 which policy, exemption
  # Policy Insights records every assignment that evaluated a resource and the
  # effect it applied. Run every time — the exemption is insurance for demo
  # day, not only a repair — but only against assignments whose rule touches
  # the network or key settings of storage accounts.
  $culprits = @{}
  if (-not $NoExemption -or $drifted.Count -gt 0) {
    $changing = @('modify','deployifnotexists','deny','append')
    $fields = 'publicNetworkAccess|networkAcls|defaultAction|allowSharedKeyAccess'
    $definitionCache = @{}
    foreach ($a in $accounts) {
      if (-not $a.Id) { continue }
      $states = Get-AzJson @('policy','state','list','--resource',$a.Id,'-o','json')
      foreach ($s in @($states)) {
        $effect = "$($s.policyDefinitionAction)".ToLower()
        if ($effect -notin $changing) { continue }
        $defId = $s.policyDefinitionId
        if (-not $definitionCache.ContainsKey($defId)) {
          $def = Get-AzJson @('rest','--method','get','--url',"https://management.azure.com${defId}?api-version=2023-04-01")
          $rule = if ($def) { ($def.properties.policyRule | ConvertTo-Json -Depth 30 -Compress) } else { '' }
          $definitionCache[$defId] = @{ Touches = ($rule -match 'Microsoft.Storage/storageAccounts' -and $rule -match $fields); Name = "$($def.properties.displayName)" }
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
    foreach ($k in $culprits.Keys) {
      $c = $culprits[$k]
      Info "Policy '$($c.Name)' ($($c.Effects -join ', ')) applies to these accounts — $($c.Display)"
    }
  }

  if ($ReportOnly) {
    Write-Host ''
    if ($drifted.Count -gt 0) { Warn2 'Report only — nothing was changed. Run without -ReportOnly to repair.'; exit 1 }
    exit 0
  }

  if ($culprits.Count -gt 0 -and -not $NoExemption) {
    # The timestamp is formatted with the invariant culture ON PURPOSE. ':' in
    # a .NET format string is the time-separator placeholder, and a Danish
    # Windows renders it as '.', which the CLI then refuses to parse. That is
    # the bug that stopped the first exemption being created.
    $expires = (Get-Date).ToUniversalTime().AddDays($ExpiresInDays).ToString('yyyy-MM-ddTHH:mm:ssZ', [System.Globalization.CultureInfo]::InvariantCulture)
    foreach ($k in $culprits.Keys) {
      $c = $culprits[$k]
      $hash = [BitConverter]::ToString([System.Security.Cryptography.SHA1]::HashData([Text.Encoding]::UTF8.GetBytes($k))).Replace('-','').Substring(0,10).ToLower()
      $exName = "cortex-storage-$hash"
      $have = Get-AzJson @('policy','exemption','show','--name',$exName,'--scope',$rgId,'-o','json')
      if ($have) { Keep "Exemption $exName already covers '$($c.Name)' (expires $("$($have.expiresOn)".Substring(0, [Math]::Min(10, "$($have.expiresOn)".Length))))"; continue }
      $exArgs = @('policy','exemption','create','--name',$exName,'--policy-assignment',$k,'--scope',$rgId,
                  '--exemption-category','Waiver','--expires-on',$expires,
                  '--display-name',"Cortex PoC — storage accounts inside perimeter ($($c.Name))",
                  '--description','Cortex proof of concept: the sample-data and state storage accounts are reached with Entra tokens through a Network Security Perimeter. Insurance against the policy changing under a demo. Remove when the full build lands.',
                  '--only-show-errors','-o','none')
      if ($c.Initiative -and $c.Refs.Count -gt 0) { $exArgs += '--policy-definition-reference-ids'; $exArgs += $c.Refs }
      $r = Invoke-AzText $exArgs
      if ($r.rc -eq 0) {
        Ok "Exemption $exName created for '$($c.Name)' (expires $($expires.Substring(0,10)))"
      } else {
        Warn2 "Could not create the exemption for '$($c.Name)'."
        if ($r.text -match 'AuthorizationFailed|does not have authorization') {
          Info 'You lack Microsoft.Authorization/policyExemptions/write on the resource group. An Owner can run:'
        } else {
          Info ((($r.text.Trim() -split "`n") | Select-Object -First 2) -join ' ')
          Info 'Command to run by hand:'
        }
        $refs = if ($c.Initiative -and $c.Refs.Count -gt 0) { " --policy-definition-reference-ids $($c.Refs -join ' ')" } else { '' }
        Write-Host "    az policy exemption create --name $exName --policy-assignment '$k' --scope '$rgId' --exemption-category Waiver --expires-on $expires --display-name 'Cortex PoC storage'$refs"
      }
    }
  }

  if ($drifted.Count -eq 0) {
    if (-not $Quiet) { Write-Host '' }
    exit $script:exit
  }

  # ---------------------------------------------------------- 5 repair
  # Two ways a policy fights back, both handled by reading the result back:
  #   Deny    — the update is refused outright (RequestDisallowedByPolicy).
  #   Modify  — the update "succeeds" but the effect rewrites the properties
  #             on the way in, so the account reads exactly as before.
  # In perimeter mode SecuredByPerimeter is the value the policy excludes, so
  # the first attempt should stick; the retries cover an exemption that is
  # still propagating when the perimeter is not enough.
  $repaired = 0
  foreach ($a in $drifted) {
    if ($perimeterMode -and -not $a.Repairable) {
      Fail "$($a.Name) is not associated with $Perimeter, so SecuredByPerimeter cannot be set. Provision first: .\scripts\Deploy-Cortex.ps1"
      $script:exit = 1
      continue
    }
    $update = @('storage','account','update','-n',$a.Name,'-g',$ResourceGroup,'--public-network-access',$wantPna,'--only-show-errors','-o','none')
    if (-not $perimeterMode) { $update += @('--default-action','Allow','--bypass','AzureServices') }
    $done = $false
    $last = ''
    foreach ($attempt in 1..5) {
      $r = Invoke-AzText $update
      $last = $r.text
      if ($r.rc -eq 0) {
        $after = Get-AzJson @('storage','account','show','-n',$a.Name,'-g',$ResourceGroup,'-o','json')
        $stillWrong = ("$($after.publicNetworkAccess)" -ne $wantPna) -or
                      (-not $perimeterMode -and $after.networkRuleSet.defaultAction -and $after.networkRuleSet.defaultAction -ne 'Allow')
        if (-not $stillWrong) { $done = $true; break }
        $last = "a Modify policy rewrote publicNetworkAccess to $($after.publicNetworkAccess) on the way in"
        if ($attempt -lt 5) { Info "The update went through but the policy put it back — waiting 30 seconds for the exemption to take effect (attempt $attempt of 5)"; Start-Sleep -Seconds 30 }
      } elseif ($r.text -match 'RequestDisallowedByPolicy') {
        if ($attempt -lt 5) { Info "A Deny policy refuses the change — waiting 30 seconds for the exemption to apply (attempt $attempt of 5)"; Start-Sleep -Seconds 30 }
      } else {
        Fail "$($a.Name) — $((($r.text.Trim()) -split "`n" | Select-Object -First 1))"
        break
      }
    }
    if ($done) {
      $repaired++
      Ok "$($a.Name) — public network access is now $wantPna"
    } else {
      $script:exit = 1
      Fail "$($a.Name) could not be repaired ($((($last.Trim()) -split "`n" | Select-Object -First 1)))."
      if ($perimeterMode) {
        Info 'SecuredByPerimeter should be excluded from the policy by name. If it is still being rewritten, paste the'
        Info 'policy rule (docs/DEPLOY.md §6 has the command) — the exclusion may key on something other than this value.'
      }
    }
  }

  # ------------------------------------------------ 6 remember the choice
  # Bicep writes publicNetworkAccess on every provision. Once the perimeter
  # holds, the template should write SecuredByPerimeter itself rather than
  # Enabled-then-repair on every run.
  if ($perimeterMode -and $repaired -gt 0 -and $script:exit -eq 0 -and (Get-Command azd -ErrorAction SilentlyContinue)) {
    azd env set STORAGE_PUBLIC_NETWORK_ACCESS SecuredByPerimeter 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok 'Recorded STORAGE_PUBLIC_NETWORK_ACCESS=SecuredByPerimeter for the next provision' }
  }

  if ($repaired -gt 0 -and $script:exit -eq 0) { $script:exit = 2 }
  Write-Host ''
  if ($script:exit -eq 2) {
    if ($perimeterMode) {
      Ok 'Repaired. Your laptop is outside the perimeter by design; the bootstrap job is the proof from inside Azure:'
      Info '    .\scripts\Deploy-Cortex.ps1 -SkipProvision -SkipAuth   (runs the job and the rest of bootstrap)'
    } else {
      Ok 'Repaired. Re-run bootstrap:  . .\scripts\Set-CortexEnv.ps1;  node scripts/bootstrap.js --only=data;  node scripts/bootstrap.js --only=search'
    }
  }
  exit $script:exit
}
catch { Fail $_.Exception.Message; exit 1 }
finally { Pop-Location }
