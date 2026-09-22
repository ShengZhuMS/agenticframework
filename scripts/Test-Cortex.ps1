<#
.SYNOPSIS
  Check a deployed Cortex, or run the local test suite.

.DESCRIPTION
  Three layers, checked in the order a fault actually propagates:

    1. The platform — is each container app on a real image, on port 3000,
       and is its newest REVISION serving? A revision that never came up
       makes the platform answer 404 on every path, which an HTTP check alone
       reports as "the app is broken" when the app never started.
    2. The storage accounts — are they inside the Network Security Perimeter
       with public access SecuredByPerimeter (the state the tenant's policy
       leaves alone)? And did the bootstrap job's last run succeed?
    3. The app — the nine /api/health endpoints and the MCP server.

  -Diagnose adds everything a second pair of eyes needs, between two marker
  lines, so the whole thing can be pasted into a chat or an issue: revision
  states, replica container states, the platform and console logs, the storage
  settings, and the policy assignments that evaluated the storage accounts.
  Nothing between the markers is secret — names, states and log lines only.

.EXAMPLE
  .\scripts\Test-Cortex.ps1
  Health-check the deployed app.

.EXAMPLE
  .\scripts\Test-Cortex.ps1 -Diagnose
  The same, plus a paste-able diagnosis block at the end.

.EXAMPLE
  .\scripts\Test-Cortex.ps1 -Local
  Run the unit tests instead.
#>
[CmdletBinding()]
param([switch]$Local, [switch]$Diagnose, [string]$Url, [string]$McpUrl, [string]$ResourceGroup)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
# Extension commands (az containerapp job logs …) install themselves rather than prompting. Process scope only.
$env:AZURE_EXTENSION_USE_DYNAMIC_INSTALL = 'yes_without_prompt'
$env:AZURE_EXTENSION_RUN_AFTER_DYNAMIC_INSTALL = 'true'

# Run az and return parsed JSON, or $null when it fails. Never throws.
function Get-AzJson {
  param([string[]]$Arguments)
  $out = & az @Arguments 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  try { return ($out | ConvertFrom-Json) } catch { return $null }
}

# GET a JSON endpoint WITHOUT following redirects. When sign-in guards a
# machine path, Easy Auth answers 302 to login.microsoftonline.com; following
# it returns an HTML page that reads as "ok=false" for every check at once.
# A 404 or 5xx with a non-JSON body did not come from Cortex either: it is the
# platform answering for a revision that is not running.
function Get-CortexJson {
  param([string]$Uri)
  try {
    $r = Invoke-WebRequest -Uri $Uri -MaximumRedirection 0 -SkipHttpErrorCheck -TimeoutSec 60 -ErrorAction Stop
  } catch { return @{ ok = $false; error = $_.Exception.Message } }
  if ($r.StatusCode -in 301,302,303,307,308,401) { return @{ ok = $false; behindSignIn = $true } }
  if ($r.StatusCode -in 404,502,503,504) { return @{ ok = $false; notServing = $true; error = "HTTP $($r.StatusCode) from the platform — the app is not answering" } }
  try { $j = $r.Content | ConvertFrom-Json } catch { return @{ ok = $false; error = "not JSON (HTTP $($r.StatusCode))" } }
  return @{ ok = [bool]$j.ok; json = $j }
}

try {
  if ($Local) {
    npm test
    exit $LASTEXITCODE
  }

  $values = @{}
  azd env get-values 2>$null | ForEach-Object { if ($_ -match '^(\w+)="?([^"]*)"?$') { $values[$Matches[1]] = $Matches[2] } }
  if (-not $Url)           { $Url = $values['CORTEX_WEB_URL'] }
  if (-not $McpUrl)        { $McpUrl = $values['CORTEX_MCP_URL'] }
  if (-not $ResourceGroup) { $ResourceGroup = $values['AZURE_RESOURCE_GROUP'] }
  if (-not $Url) { throw 'No URL. Pass -Url, or run from a folder with an azd environment.' }

  $failed = 0
  $revisionDown = @()
  $haveAz = [bool](Get-Command az -ErrorAction SilentlyContinue)

  # ------------------------------------------------------- 1 the platform
  # Checked first, because the failures that look like an application fault
  # are not one. A placeholder image means the code was never pushed; a wrong
  # ingress port means nothing can reach it; a revision that is not running
  # means the platform answers 404 for the app. None is visible from HTTP.
  if ($ResourceGroup -and $haveAz) {
    Write-Host "Container apps in $ResourceGroup`n"
    foreach ($app in @('cortex-web','cortex-purview-mcp')) {
      $c = Get-AzJson @('containerapp','show','-n',$app,'-g',$ResourceGroup,'-o','json')
      if (-not $c) {
        $failed++
        Write-Host ("  FAIL  {0} not found" -f $app) -ForegroundColor Red
        continue
      }
      $image = $c.properties.template.containers[0].image
      $port  = $c.properties.configuration.ingress.targetPort
      $rev   = $c.properties.latestRevisionName

      if ($image -match 'k8se/quickstart') {
        $failed++
        Write-Host ("  FAIL  {0} is running the PLACEHOLDER image" -f $app) -ForegroundColor Red
        Write-Host '        Its code was never pushed. Run: .\scripts\Deploy-Cortex.ps1 -AppOnly' -ForegroundColor Yellow
      } else {
        Write-Host ("  OK    {0}  {1}" -f $app, ($image -split '/')[-1]) -ForegroundColor Green
      }
      if ($port -ne 3000) {
        $failed++
        Write-Host ("  FAIL  {0} ingress targets port {1}; Cortex listens on 3000" -f $app, $port) -ForegroundColor Red
        Write-Host ("        Fix: az containerapp ingress update -n {0} -g {1} --target-port 3000" -f $app, $ResourceGroup) -ForegroundColor Yellow
      }

      $r = Get-AzJson @('containerapp','revision','show','-n',$app,'-g',$ResourceGroup,'--revision',$rev,'-o','json')
      $health = "$($r.properties.healthState)"; $running = "$($r.properties.runningState)"; $prov = "$($r.properties.provisioningState)"
      if ($running -in @('Running','RunningAtMaxScale','ScaledToZero') -and $health -ne 'Unhealthy' -and $prov -ne 'Failed') {
        Write-Host ("  OK    {0} revision {1} is serving ({2}, {3})" -f $app, $rev, $running, $health) -ForegroundColor Green
      } else {
        $failed++; $revisionDown += $app
        Write-Host ("  FAIL  {0} revision {1} is NOT serving — provisioning {2}, running {3}, health {4}" -f $app, $rev, $prov, $running, $health) -ForegroundColor Red
        $replicas = Get-AzJson @('containerapp','replica','list','-n',$app,'-g',$ResourceGroup,'--revision',$rev,'-o','json')
        foreach ($rp in @($replicas)) {
          foreach ($ct in @($rp.properties.containers)) {
            Write-Host ("        replica {0}: {1} is {2} (restarts {3}) {4}" -f $rp.name, $ct.name, $ct.runningState, $ct.restartCount, $ct.runningStateDetails) -ForegroundColor Yellow
          }
        }
        $raw = @(az containerapp logs show -n $app -g $ResourceGroup --type system --tail 40 --only-show-errors 2>$null)
        $lines = @()
        foreach ($l in $raw) {
          $t = $l
          try { $o = $l | ConvertFrom-Json; $t = "$($o.Reason) $($o.Msg)$($o.Log)".Trim() } catch { }
          if ($t) { $lines += $t }
        }
        $telling = @($lines | Where-Object { $_ -match 'error|fail|mount|volume|unhealthy|backoff|pull|exit|denied|timeout|unauthori' })
        if ($telling.Count -eq 0) { $telling = @($lines | Select-Object -Last 5) }
        foreach ($l in ($telling | Select-Object -Last 8)) { Write-Host "        log: $l" -ForegroundColor Yellow }
        if (($telling -join ' ') -match 'mount|volume|azurefile|cifs|smb') {
          Write-Host '        The state share is not mounting. Repair the state storage account and restart:' -ForegroundColor Yellow
          Write-Host '            .\scripts\Set-CortexStorageAccess.ps1' -ForegroundColor Yellow
          Write-Host ("            az containerapp revision restart -n {0} -g {1} --revision {2}" -f $app, $ResourceGroup, $rev) -ForegroundColor Yellow
          Write-Host '        or deploy without the share:  .\scripts\Deploy-Cortex.ps1 -NoStateShare' -ForegroundColor Yellow
        } else {
          Write-Host ("        Restart it:  az containerapp revision restart -n {0} -g {1} --revision {2}" -f $app, $ResourceGroup, $rev) -ForegroundColor Yellow
        }
      }
    }
    Write-Host ''
  }

  # ------------------------------------------------ 2 the storage accounts
  # Inside the perimeter, the state the tenant's policy leaves alone is
  # publicNetworkAccess = SecuredByPerimeter with an association in the
  # perimeter. Anything else means the policy has been at work (Disabled) or
  # the association is missing — and then the bootstrap job cannot write and
  # the web app's state blobs cannot be read.
  $storageLocked = @()
  $perimeter = $values['NSP_NAME']
  if ($ResourceGroup -and $haveAz -and ($values['DATA_STORAGE_ACCOUNT'] -or $values['STATE_STORAGE_ACCOUNT'])) {
    Write-Host $(if ($perimeter) { "Storage accounts (perimeter $perimeter)`n" } else { "Storage accounts`n" })
    $associated = @{}
    if ($perimeter) {
      $sub = az account show --query id -o tsv 2>$null
      $assoc = Get-AzJson @('rest','--method','get','--url',"https://management.azure.com/subscriptions/$sub/resourceGroups/$ResourceGroup/providers/Microsoft.Network/networkSecurityPerimeters/$perimeter/resourceAssociations?api-version=2024-07-01")
      if (-not $assoc) { $failed++; Write-Host ("  FAIL  perimeter {0} not found in {1} — provision with .\scripts\Deploy-Cortex.ps1" -f $perimeter, $ResourceGroup) -ForegroundColor Red }
      foreach ($a in @($assoc.value)) { $associated["$($a.properties.privateLinkResource.id)".ToLower()] = "$($a.properties.accessMode)" }
    }
    $accounts = @(
      @{ Name = $values['DATA_STORAGE_ACCOUNT'];  Role = 'sample data' },
      @{ Name = $values['STATE_STORAGE_ACCOUNT']; Role = 'state blobs' }
    )
    foreach ($acct in $accounts) {
      if (-not $acct.Name) { continue }
      $s = Get-AzJson @('storage','account','show','-n',$acct.Name,'-g',$ResourceGroup,'-o','json')
      if (-not $s) { $failed++; Write-Host ("  FAIL  {0} not found" -f $acct.Name) -ForegroundColor Red; continue }
      $issues = @()
      if ($perimeter) {
        $mode = $associated["$($s.id)".ToLower()]
        if ($assoc -and -not $mode) { $issues += "not associated with $perimeter" }
        if ("$($s.publicNetworkAccess)" -ne 'SecuredByPerimeter') { $issues += "public network access $($s.publicNetworkAccess) (wanted SecuredByPerimeter)" }
      } else {
        if ($s.publicNetworkAccess -and $s.publicNetworkAccess -ne 'Enabled')        { $issues += "public network access $($s.publicNetworkAccess)" }
        if ($s.networkRuleSet.defaultAction -and $s.networkRuleSet.defaultAction -ne 'Allow') { $issues += "default action $($s.networkRuleSet.defaultAction)" }
      }
      if ($issues.Count -eq 0) {
        $how = if ($perimeter) { "SecuredByPerimeter, $($associated["$($s.id)".ToLower()]) mode" } else { 'public endpoint open' }
        Write-Host ("  OK    {0} ({1}) — {2}, keyless" -f $acct.Name, $acct.Role, $how) -ForegroundColor Green
      } else {
        $failed++; $storageLocked += $acct.Name
        Write-Host ("  FAIL  {0} ({1}) — {2}" -f $acct.Name, $acct.Role, ($issues -join '; ')) -ForegroundColor Red
      }
    }
    if ($storageLocked.Count -gt 0) {
      Write-Host '        Repair:  .\scripts\Set-CortexStorageAccess.ps1   then re-run the deploy script (-SkipProvision -SkipAuth).' -ForegroundColor Yellow
    }

    # The bootstrap job is the only thing that writes the sample data. Its
    # last execution is the record of whether the data chain is in place.
    $job = $values['CORTEX_BOOTSTRAP_JOB']
    if ($job) {
      $execs = Get-AzJson @('containerapp','job','execution','list','-n',$job,'-g',$ResourceGroup,'-o','json')
      $last = @($execs | Sort-Object { $_.properties.startTime } -Descending | Select-Object -First 1)
      if ($last.Count -eq 0) {
        Write-Host ("  WARN  bootstrap job {0} has never run — the sample data is not in storage yet (Deploy-Cortex.ps1 step 11b)" -f $job) -ForegroundColor Yellow
      } elseif ($last[0].properties.status -eq 'Succeeded') {
        Write-Host ("  OK    bootstrap job {0} — last run {1} succeeded ({2})" -f $job, $last[0].name, $last[0].properties.startTime) -ForegroundColor Green
      } else {
        $failed++
        Write-Host ("  FAIL  bootstrap job {0} — last run {1} is {2}" -f $job, $last[0].name, $last[0].properties.status) -ForegroundColor Red
        Write-Host ("        Its log:  az containerapp job logs show -n {0} -g {1} --execution {2} --container bootstrap --tail 200" -f $job, $ResourceGroup, $last[0].name) -ForegroundColor Yellow
      }
    }
    Write-Host ''
  }

  # ---------------------------------------------------------- 3 the app
  Write-Host "Checking $Url`n"
  $checks = @(
    @{ Path = '/api/health';          Name = 'App and register' },
    @{ Path = '/api/health/keyvault'; Name = 'Key Vault' },
    @{ Path = '/api/health/purview';  Name = 'Purview' },
    @{ Path = '/api/health/apim';     Name = 'API Management' },
    @{ Path = '/api/health/foundry';  Name = 'Foundry' },
    @{ Path = '/api/health/search';   Name = 'Azure AI Search (data indexes)' },
    @{ Path = '/api/health/storage';  Name = 'Sample-data storage' },
    @{ Path = '/api/health/datamap';  Name = 'Purview Data Map' },
    @{ Path = '/api/health/state';    Name = 'Application state (blobs)' }
  )

  $behindSignIn = $false
  $notServing = $false
  foreach ($c in $checks) {
    try {
      $probe = Get-CortexJson -Uri "$Url$($c.Path)"
      if ($probe.behindSignIn) {
        $failed++; $behindSignIn = $true
        Write-Host ("  FAIL  {0} — redirected to sign-in" -f $c.Name) -ForegroundColor Red
        continue
      }
      if ($probe.notServing) {
        $failed++; $notServing = $true
        Write-Host ("  FAIL  {0} — {1}" -f $c.Name, $probe.error) -ForegroundColor Red
        continue
      }
      if ($probe.error) { throw $probe.error }
      $r = $probe.json
      if ($r.ok) {
        Write-Host ("  OK    {0}" -f $c.Name) -ForegroundColor Green
        if ($c.Path -eq '/api/health/purview') {
          Write-Host ("        {0} domains, {1} data products ({2} published)" -f $r.domains, $r.dataProducts, $r.published)
        }
        if ($c.Path -eq '/api/health/state') {
          $where = if ($r.directory) { " ($($r.directory))" } else { '' }
          Write-Host ("        mode: {0}{1}" -f $r.mode, $where)
          if ($r.mode -eq 'memory' -and $values['STATE_STORAGE_ACCOUNT']) {
            Write-Host '        The app could not read its state blobs at start-up, so nothing is being persisted. Restart the' -ForegroundColor Yellow
            Write-Host '        revision once storage is repaired:  az containerapp revision restart -n cortex-web -g <rg> --revision <name>' -ForegroundColor Yellow
          }
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
        if ($text -match 'AuthorizationFailure') {
          Write-Host '        The storage account refuses the app: the perimeter is not admitting the Cortex identity, or the' -ForegroundColor Yellow
          Write-Host '        account is not SecuredByPerimeter. Repair:  .\scripts\Set-CortexStorageAccess.ps1' -ForegroundColor Yellow
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
  if ($notServing) {
    Write-Host '        cortex-web is not answering: the platform replies 404 for a revision that is not running.' -ForegroundColor Yellow
    if ($revisionDown -contains 'cortex-web') { Write-Host '        The revision check above says why.' -ForegroundColor Yellow }
    else { Write-Host '        Run with -Diagnose for the revision and platform log.' -ForegroundColor Yellow }
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

  # ------------------------------------------------------------ diagnose
  # Everything between the markers is safe to paste: no keys, no secrets, no
  # connection strings — names, states and log lines only.
  if ($Diagnose -and $haveAz -and $ResourceGroup) {
    Write-Host "`n===== CORTEX DIAGNOSTICS — paste everything between the markers =====`n"
    Write-Host "web: $Url"
    Write-Host "mcp: $McpUrl"
    Write-Host "rg:  $ResourceGroup"
    foreach ($k in @('CORTEX_CONFIG_SOURCE','DATA_STORAGE_ACCOUNT','STATE_STORAGE_ACCOUNT','STATE_CONTAINER','SEARCH_SERVICE_NAME','NSP_NAME','STORAGE_ACCESS_MODE','SEARCH_ACCESS_MODE','STORAGE_PUBLIC_NETWORK_ACCESS','CREATE_PERIMETER','CREATE_DATA','CREATE_SEARCH','CORTEX_BOOTSTRAP_JOB','SERVICE_WEB_IMAGE_NAME','SERVICE_PURVIEW_MCP_IMAGE_NAME','CORTEX_DEFAULT_GROUPS')) {
      if ($values.ContainsKey($k)) { Write-Host ("{0}={1}" -f $k, $values[$k]) }
    }
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    Write-Host "`n--- cortex-web secrets (names only) and sign-in registration ---"
    az containerapp secret list -n cortex-web -g $ResourceGroup --query "[].name" -o json 2>&1
    az containerapp auth show -n cortex-web -g $ResourceGroup --query "{enabled:platform.enabled, action:globalValidation.unauthenticatedClientAction, excluded:globalValidation.excludedPaths, clientId:identityProviders.azureActiveDirectory.registration.clientId, secretSetting:identityProviders.azureActiveDirectory.registration.clientSecretSettingName}" -o json 2>&1
    foreach ($app in @('cortex-web','cortex-purview-mcp')) {
      Write-Host "`n--- $app revisions ---"
      az containerapp revision list -n $app -g $ResourceGroup --query "[].{name:name, active:properties.active, traffic:properties.trafficWeight, provisioning:properties.provisioningState, running:properties.runningState, health:properties.healthState, created:properties.createdTime}" -o table 2>&1
      Write-Host "`n--- $app replicas (latest revision) ---"
      az containerapp replica list -n $app -g $ResourceGroup --query "[].{replica:name, containers:properties.containers[].{name:name, state:runningState, restarts:restartCount, detail:runningStateDetails}}" -o json 2>&1
      Write-Host "`n--- $app system log (last 40) ---"
      az containerapp logs show -n $app -g $ResourceGroup --type system --tail 40 2>&1
      Write-Host "`n--- $app console log (last 30) ---"
      az containerapp logs show -n $app -g $ResourceGroup --type console --tail 30 2>&1
    }
    if ($perimeter) {
      Write-Host "`n--- perimeter $perimeter associations ---"
      az rest --method get --url "https://management.azure.com/subscriptions/$sub/resourceGroups/$ResourceGroup/providers/Microsoft.Network/networkSecurityPerimeters/$perimeter/resourceAssociations?api-version=2024-07-01" --query "value[].{name:name, mode:properties.accessMode, state:properties.provisioningState, resource:properties.privateLinkResource.id}" -o table 2>&1
      Write-Host "`n--- perimeter $perimeter access rules ---"
      az rest --method get --url "https://management.azure.com/subscriptions/$sub/resourceGroups/$ResourceGroup/providers/Microsoft.Network/networkSecurityPerimeters/$perimeter/profiles/cortex/accessRules?api-version=2024-07-01" --query "value[].{name:name, direction:properties.direction, subscriptions:properties.subscriptions[].id, prefixes:properties.addressPrefixes}" -o json 2>&1
    }
    if ($job) {
      Write-Host "`n--- bootstrap job $job executions ---"
      az containerapp job execution list -n $job -g $ResourceGroup --query "[].{name:name, status:properties.status, start:properties.startTime, end:properties.endTime}" -o table 2>&1
    }
    foreach ($name in @($values['DATA_STORAGE_ACCOUNT'], $values['STATE_STORAGE_ACCOUNT'])) {
      if (-not $name) { continue }
      Write-Host "`n--- storage $name ---"
      az storage account show -n $name -g $ResourceGroup --query "{publicNetworkAccess:publicNetworkAccess, defaultAction:networkRuleSet.defaultAction, bypass:networkRuleSet.bypass, ipRules:networkRuleSet.ipRules, sharedKey:allowSharedKeyAccess, hns:isHnsEnabled}" -o json 2>&1
      $id = az storage account show -n $name -g $ResourceGroup --query id -o tsv 2>$null
      if ($id) {
        Write-Host "--- policies that evaluated $name with a changing effect ---"
        az policy state list --resource $id --query "[?contains('modify deployifnotexists deny append', policyDefinitionAction)].{assignment:policyAssignmentName, effect:policyDefinitionAction, definition:policyDefinitionName, compliant:complianceState}" -o table 2>&1
        Write-Host "--- writes to $name in the last 3 days ---"
        az monitor activity-log list --resource-id $id --offset 3d --query "[?operationName.value=='Microsoft.Storage/storageAccounts/write'].{time:eventTimestamp, caller:caller, status:status.value}" -o table 2>&1
      }
    }
    $ErrorActionPreference = $prev
    Write-Host "`n===== END CORTEX DIAGNOSTICS =====`n"
  }

  Write-Host ''
  if ($failed) {
    Write-Host "$failed check(s) failed." -ForegroundColor Red
    if (-not $Diagnose) { Write-Host 'For a paste-able diagnosis:  .\scripts\Test-Cortex.ps1 -Diagnose' -ForegroundColor Yellow }
    exit 1
  }
  Write-Host 'All checks passed. The golden path will run.' -ForegroundColor Green
}
finally { Pop-Location }
