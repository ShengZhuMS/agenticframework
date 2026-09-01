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

  [switch]$WhatIfResources,
  [switch]$SkipProvision,
  [switch]$SkipBootstrap,
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

  $signedInId = az ad signed-in-user show --query id -o tsv 2>$null
  if (-not $signedInId) { $signedInId = $acct.user.name }

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
    Write-Host ''
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

  # A vault on the legacy access-policy model silently ignores RBAC.
  $seedKeyVault = $true
  if ($found.KeyVault) {
    $vault = Get-AzJson @('keyvault','show','-n',$KeyVaultName,'-g',$KeyVaultResourceGroup)
    if ($vault -and $vault.properties.enableRbacAuthorization -ne $true) {
      Warn2 "$KeyVaultName uses ACCESS POLICIES, not RBAC."
      Warn2 'The role assignment will be ignored. Either switch it to RBAC:'
      Write-Host "    az keyvault update -n $KeyVaultName -g $KeyVaultResourceGroup --enable-rbac-authorization true"
      Warn2 'or add an access policy for the Cortex identity after deployment.'
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
    # one provisioned quietly owns every value in it.
    $owner = az keyvault secret show --vault-name $KeyVaultName --name cortex-environment-name --query value -o tsv 2>$null
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
      REGISTRY_NAME                 = $RegistryName
      REGISTRY_RG                   = $RegistryResourceGroup
      CREATE_REGISTRY               = (-not $found.Registry).ToString().ToLower()
      LOG_ANALYTICS_NAME            = $LogAnalyticsName
      APP_INSIGHTS_NAME             = $AppInsightsName
      MONITORING_RG                 = $MonitoringResourceGroup
      CREATE_MONITORING             = (-not $found.Monitoring).ToString().ToLower()
      APIM_PUBLISHER_EMAIL          = $acct.user.name
    }
    foreach ($k in $settings.Keys) { azd env set $k $settings[$k] | Out-Null }

    azd up --no-prompt
    if ($LASTEXITCODE -ne 0) {
      Fail 'azd up failed.'
      Write-Host ''
      Write-Host '  Most likely causes, in the order worth checking:' -ForegroundColor Yellow
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

  # A partly-finished provision leaves the outputs absent. Saying so plainly
  # beats five confusing failures in the steps that follow.
  if (-not $webUrl) {
    Warn2 'Provisioning did not publish its outputs, so the deployment is incomplete.'
    Info  'Everything above this point succeeded and is safe to re-run.'
    Info  "Run:  .\scripts\Deploy-Cortex.ps1"
    throw 'Incomplete deployment — no web URL was published.'
  }

  # ------------------------------------------------------------ 11 secrets
  Step 8 'Onboarding the APIM subscription key'
  if (-not $kv) {
    Warn2 'No Key Vault name in the environment. Skipping.'
  } else {
    $existing = az keyvault secret show --vault-name $kv --name apim-subscription-key --query value -o tsv 2>$null
    if ($existing) {
      Ok 'apim-subscription-key already onboarded'
    } else {
      $key = az rest --method POST --url ("https://management.azure.com/subscriptions/{0}/resourceGroups/{1}/providers/Microsoft.ApiManagement/service/{2}/subscriptions/master/listSecrets?api-version=2024-05-01" -f $acct.id, $apimRg, $apim) `
               --query primaryKey -o tsv 2>$null
      if ($key) {
        az keyvault secret set --vault-name $kv --name apim-subscription-key --value $key --only-show-errors | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok 'Onboarded from API Management' }
        else {
          Warn2 'Could not write the key to the vault — you likely lack Key Vault Secrets Officer.'
          Write-Host "    az keyvault secret set --vault-name $kv --name apim-subscription-key --value '<key>'"
        }
      } else {
        Warn2 'Could not read the APIM key. Set it by hand:'
        Write-Host "    az keyvault secret set --vault-name $kv --name apim-subscription-key --value '<key>'"
      }
    }
  }

  # ---------------------------------------------------------- 12 bootstrap
  if (-not $SkipBootstrap) {
    Step 9 'Creating the Defra content in Purview and API Management'
    Warn2 'Needs the Purview roles from the deployment guide, section 6.'
    npm run bootstrap
    if ($LASTEXITCODE -ne 0) {
      Warn2 'Bootstrap reported failures. It is idempotent — fix the roles and re-run: npm run bootstrap'
    } else { Ok 'Domains and data products created' }
  }

  # ------------------------------------------------------------- 13 check
  if (-not $SkipHealthCheck) {
    Step 10 'Checking the deployment'
    # A container app that has just taken a new revision needs a moment. Three
    # attempts with a short back-off turns a spurious red into a real signal.
    foreach ($p in @('/api/health','/api/health/keyvault','/api/health/purview','/api/health/apim','/api/health/foundry')) {
      $passed = $false
      $lastError = ''
      foreach ($attempt in 1..3) {
        try {
          $r = Invoke-RestMethod -Uri "$webUrl$p" -TimeoutSec 30
          if ($r.ok) { $passed = $true; break }
          $lastError = 'returned ok=false'
        } catch { $lastError = $_.Exception.Message }
        if ($attempt -lt 3) { Start-Sleep -Seconds 10 }
      }
      if ($passed) { Ok $p } else { Warn2 "$p — $lastError" }
    }

    if ($mcpUrl) {
      try {
        $m = Invoke-RestMethod -Uri "$mcpUrl/health" -TimeoutSec 30
        if ($m.ok) { Ok "/health (MCP server, $($m.tools) tools)" } else { Warn2 'MCP server returned ok=false' }
      } catch { Warn2 "MCP server — $($_.Exception.Message)" }
    }
  }

  Write-Host "`n===========================================================" -ForegroundColor Green
  Write-Host " Cortex is deployed." -ForegroundColor Green
  Write-Host "===========================================================" -ForegroundColor Green
  Write-Host "`n  Web : $webUrl"
  if ($mcpUrl) { Write-Host "  MCP : $mcpUrl/mcp" }
  Write-Host "  Model: $effectiveDeploymentName ($ModelName $effectiveVersion)`n"
  Write-Host " Two steps remain. Neither can be automated.`n"
  Write-Host "  1. Purview roles — BOTH planes. Identity: $($v['CORTEX_IDENTITY_PRINCIPAL_ID'])"
  Write-Host "     Deployment guide, section 6."
  Write-Host "  2. Entra sign-in, WITH the groups claim."
  Write-Host "     Without it everyone appears to be in no groups and sees almost nothing."
  Write-Host "     Deployment guide, section 5.`n"
  Write-Host " Re-running this script is safe. For a code-only change use -AppOnly.`n" -ForegroundColor DarkGray
}
catch { Fail $_.Exception.Message; exit 1 }
finally { Pop-Location }
