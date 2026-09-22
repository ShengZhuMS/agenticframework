#Requires -Version 7.0
<#
.SYNOPSIS
Deploy additional themed web apps without changing the existing web app.
.DESCRIPTION
Uses the source app's current image, direct configuration, managed identity and
Entra registration. Adds redirect URLs, never replaces existing ones. Each app
has a separate state container. Does not provision or bootstrap shared services.
Run -WhatIf first. Azure changes require your explicit execution approval.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory)][string]$SubscriptionId,
  [Parameter(Mandatory)][string]$ResourceGroup,
  [Parameter(Mandatory)][string]$SourceApp,
  [string]$MicrosoftApp = 'cortex-web-microsoft',
  [string]$NovoApp = 'cortex-web-novo',
  [string]$Image,
  [ValidateSet('microsoft','novo','both')][string]$Only = 'both'
)
$ErrorActionPreference = 'Stop'
function AzJson([string[]]$Arguments) {
  $scopeArgs = if ($Arguments[0] -eq 'ad') { @() } else { @('--subscription', $SubscriptionId) }
  $text = & az @Arguments @scopeArgs --only-show-errors -o json
  if ($LASTEXITCODE -ne 0) { throw "Azure command failed: $($Arguments[0..1] -join ' ')" }
  if ($text) { return ($text | ConvertFrom-Json -Depth 100) }
}
function Rest([string]$Method, [string]$Url, $Body) {
  $args2 = @('rest','--method',$Method,'--url',$Url)
  $file = $null
  try {
    if ($null -ne $Body) {
      $file = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
      $Body | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $file -Encoding utf8NoBOM
      $args2 += @('--body',"@$file")
    }
    return AzJson $args2
  } finally {
    if ($file) { Remove-Item -LiteralPath $file -Force }
  }
}
foreach ($name in @($SourceApp,$MicrosoftApp,$NovoApp)) {
  if ($name -notmatch '^[a-z][a-z0-9-]{0,30}[a-z0-9]$' -or $name.Contains('--')) { throw "Invalid Container App name: $name" }
}
if (@(@($SourceApp,$MicrosoftApp,$NovoApp) | Sort-Object -Unique).Count -ne 3) { throw 'Source and variant app names must all differ.' }
$arm = 'https://management.azure.com'
$version = '2024-03-01'
$source = Rest 'GET' "$arm/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.App/containerApps/$SourceApp`?api-version=$version" $null
if ($source.properties.template.containers.Count -ne 1) { throw 'Expected one application container in source; sidecars require a reviewed template.' }
$envVars = $source.properties.template.containers[0].env
if (($envVars | Where-Object name -eq 'KEYVAULT_NAME').value) { throw 'Use a direct-configuration source app; a shared Key Vault can overwrite variant URLs.' }
$stateAccount = ($envVars | Where-Object name -eq 'STATE_STORAGE_ACCOUNT').value
if (!$stateAccount) { throw 'Source must have STATE_STORAGE_ACCOUNT configured for isolated persistent state.' }
$sourceId = $source.id
$environment = Rest 'GET' "$arm$($source.properties.managedEnvironmentId)?api-version=$version" $null
$auth = Rest 'GET' "$arm$sourceId/authConfigs/current?api-version=$version" $null
if (!$auth.properties.platform.enabled -or !$auth.properties.identityProviders.azureActiveDirectory.registration.clientId) { throw 'Source app must have working Entra authentication.' }
$clientId = $auth.properties.identityProviders.azureActiveDirectory.registration.clientId
$apps = AzJson @('ad','app','list','--filter',"appId eq '$clientId'")
if (@($apps).Count -ne 1) { throw 'Could not resolve the source Entra registration.' }
$registration = $apps[0]
$existingApps = @(AzJson @('containerapp','list','-g',$ResourceGroup))
$storage = AzJson @('storage','account','show','-n',$stateAccount)
$targets = @{ microsoft = $MicrosoftApp; novo = $NovoApp }
function Wait-App([string]$Id) {
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    $app = Rest 'GET' "$arm$Id`?api-version=$version" $null
    if ($app.properties.provisioningState -in @('Failed','Canceled')) { throw "App provisioning failed: $Id" }
    if ($app.properties.provisioningState -eq 'Succeeded' -and
        $app.properties.latestReadyRevisionName -and
        $app.properties.latestReadyRevisionName -eq $app.properties.latestRevisionName) { return }
    Start-Sleep -Seconds 10
  }
  throw "App did not reach a ready revision within 15 minutes: $Id"
}
foreach ($theme in @('microsoft','novo')) {
  if ($Only -ne 'both' -and $Only -ne $theme) { continue }
  $name = $targets[$theme]
  $existing = $existingApps | Where-Object name -eq $name
  if ($existing -and $existing.tags.'cortex-variant-of' -ne $sourceId) { throw "Refusing to overwrite unrelated app $name." }
  $stateContainer = "state-$name"
  $baseUrl = "https://$name.$($environment.properties.defaultDomain)"
  $targetId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.App/containerApps/$name"
  if (!$PSCmdlet.ShouldProcess("$ResourceGroup/$name", "Deploy $theme variant with state container $stateContainer and add Entra redirect $baseUrl")) { continue }
  $secrets = Rest 'POST' "$arm$sourceId/listSecrets?api-version=$version" @{}
  $configuration = $source.properties.configuration | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
  $configuration.secrets = @($secrets.value | ForEach-Object {
    if ($_.keyVaultUrl) { @{ name=$_.name; keyVaultUrl=$_.keyVaultUrl; identity=$_.identity } }
    elseif ($null -ne $_.value) { @{ name=$_.name; value=$_.value } }
    else { throw "Source secret '$($_.name)' could not be resolved." }
  })
  $configuration.activeRevisionsMode = 'Single'
  $configuration.ingress.external = $false
  $configuration.ingress.Remove('fqdn')
  $configuration.ingress.Remove('customDomains')
  $configuration.ingress.traffic = @(@{latestRevision=$true;weight=100})
  $template = $source.properties.template | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
  $template.Remove('revisionSuffix')
  if ($Image) { $template.containers[0].image = $Image }
  $template.scale.minReplicas = 1
  $template.scale.maxReplicas = 1
  $template.containers[0].env = @($envVars | Where-Object { $_.name -notin @('CORTEX_THEME','PUBLIC_BASE_URL','STATE_CONTAINER','ALLOW_UNAUTHENTICATED','CORTEX_STATE_DIR') }) + @(
    @{name='CORTEX_THEME';value=$theme}, @{name='PUBLIC_BASE_URL';value=$baseUrl},
    @{name='STATE_CONTAINER';value=$stateContainer}, @{name='ALLOW_UNAUTHENTICATED';value='false'}
  )
  $identity = @{type=$source.identity.type}
  if ($source.identity.userAssignedIdentities) {
    $identity.userAssignedIdentities = @{}
    foreach ($property in $source.identity.userAssignedIdentities.PSObject.Properties) { $identity.userAssignedIdentities[$property.Name] = @{} }
  }
  if (!$identity.userAssignedIdentities.Count) { throw 'A user-assigned source identity is required; system identities cannot be cloned.' }
  $identity.type = 'UserAssigned'
  $body = @{
    location=$source.location; identity=$identity
    tags=@{'cortex-variant-of'=$sourceId;'cortex-theme'=$theme}
    properties=@{managedEnvironmentId=$source.properties.managedEnvironmentId; configuration=$configuration; template=$template}
  }
  Rest 'PUT' "$arm$($storage.id)/blobServices/default/containers/$stateContainer`?api-version=2023-05-01" @{properties=@{publicAccess='None'}} | Out-Null
  Rest 'PUT' "$arm$targetId`?api-version=$version" $body | Out-Null
  Wait-App $targetId
  $redirect = "$baseUrl/.auth/login/aad/callback"
  $registration = Rest 'GET' "https://graph.microsoft.com/v1.0/applications/$($registration.id)" $null
  $web = $registration.web | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
  $web.redirectUris = @(@($web.redirectUris) + $redirect | Sort-Object -Unique)
  Rest 'PATCH' "https://graph.microsoft.com/v1.0/applications/$($registration.id)" @{web=$web} | Out-Null
  $registration.web = $web
  Rest 'PUT' "$arm$targetId/authConfigs/current?api-version=$version" @{properties=$auth.properties} | Out-Null
  $authCheck = Rest 'GET' "$arm$targetId/authConfigs/current?api-version=$version" $null
  if (!$authCheck.properties.platform.enabled) { throw "Authentication did not enable on $name. Ingress remains internal." }
  $configuration.ingress.external = $true
  Rest 'PUT' "$arm$targetId`?api-version=$version" $body | Out-Null
  Wait-App $targetId
  Write-Host "$name deployed: $baseUrl. Shared backend catalogue; isolated state: $stateContainer."
  Write-Host 'Check revision health and sign in before using this demo.'
}
