#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$ResourceGroup,
  [string]$SourceApp = 'cortex-web',
  [string[]]$Apps = @('cortex-web','cortex-web-microsoft','cortex-web-novo'),
  [Parameter(Mandatory)][string]$DatabricksHost,
  [string]$DatabricksEndpoint = 'databricks-gpt-oss-20b',
  [Parameter(Mandatory)][string]$FabricCapacityId,
  [string]$FabricWorkspaceName = 'Data Cortex synthetic',
  [string]$FabricApplicationName = 'Data Cortex Fabric connector'
)
$ErrorActionPreference = 'Stop'
function AzureJson([string[]]$Arguments) {
  $output = & az @Arguments --only-show-errors -o json
  if ($LASTEXITCODE -ne 0) { throw "Azure operation failed: $($Arguments[0..1] -join ' ')" }
  if ($output) { return $output | ConvertFrom-Json -Depth 100 }
}
function Rest([string]$Method,[string]$Url,$Body,[string]$Resource = '') {
  $file = $null
  try {
    $args2 = @('rest','--method',$Method,'--url',$Url)
    if ($Resource) { $args2 += @('--resource',$Resource) }
    if ($null -ne $Body) {
      $file = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
      $Body | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $file -Encoding utf8NoBOM
      $args2 += @('--body',"@$file")
    }
    return AzureJson $args2
  } finally { if ($file) { Remove-Item -LiteralPath $file -Force } }
}
if ($DatabricksHost -notmatch '^adb-[a-z0-9.-]+\.azuredatabricks\.net$') { throw 'Provide the discovered Azure Databricks workspace hostname.' }
$account = AzureJson @('account','show')
$source = Rest 'GET' "https://management.azure.com/subscriptions/$($account.id)/resourceGroups/$ResourceGroup/providers/Microsoft.App/containerApps/$SourceApp`?api-version=2024-03-01" $null
$identity = $source.identity.userAssignedIdentities.PSObject.Properties.Value | Select-Object -First 1
if (!$identity.clientId) { throw 'The source app must have a user-assigned managed identity.' }
if (!$PSCmdlet.ShouldProcess($ResourceGroup,'Configure dedicated source identities, synthetic Fabric workspace and app connectors')) { return }
$foundryGroup=($source.properties.template.containers[0].env|Where-Object name -eq 'FOUNDRY_RESOURCE_GROUP').value
if(!$foundryGroup){throw 'Source app is missing FOUNDRY_RESOURCE_GROUP.'}
AzureJson @('role','assignment','create','--assignee-object-id',$identity.principalId,'--assignee-principal-type','ServicePrincipal',
  '--role','9fc6112f-f48e-4e27-8b09-72a5c94e4ae9','--scope',"/subscriptions/$($account.id)/resourceGroups/$foundryGroup")|Out-Null

$dbxResource = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d'
$dbx = "https://$DatabricksHost"
$filter = [uri]::EscapeDataString("applicationId eq `"$($identity.clientId)`"")
$principals = Rest 'GET' "$dbx/api/2.0/preview/scim/v2/ServicePrincipals?filter=$filter" $null $dbxResource
if (!$principals.totalResults) {
  Rest 'POST' "$dbx/api/2.0/preview/scim/v2/ServicePrincipals" @{
    schemas=@('urn:ietf:params:scim:schemas:core:2.0:ServicePrincipal')
    applicationId=$identity.clientId; displayName='Data Cortex managed connector'; active=$true
  } $dbxResource | Out-Null
}
$endpoint = Rest 'GET' "$dbx/api/2.0/serving-endpoints/$DatabricksEndpoint" $null $dbxResource
if ($endpoint.endpoint_type -eq 'FOUNDATION_MODEL_API') {
  Write-Host 'Using a built-in Foundation Model endpoint with workspace entitlements; no custom endpoint ACL is changed.'
} elseif ($endpoint.id) {
  Rest 'PATCH' "$dbx/api/2.0/permissions/serving-endpoints/$($endpoint.id)" @{
    access_control_list=@(@{service_principal_name=$identity.clientId;permission_level='CAN_QUERY'})
  } $dbxResource | Out-Null
} else { throw 'The Databricks endpoint returned neither a custom endpoint ID nor a Foundation Model type.' }

$fabric = 'https://api.fabric.microsoft.com'
$registrations = @(AzureJson @('ad','app','list','--filter',"displayName eq '$FabricApplicationName'"))
if ($registrations.Count -gt 1) { throw 'More than one Fabric connector registration has this name.' }
if (!$registrations.Count) {
  $registration = AzureJson @('ad','app','create','--display-name',$FabricApplicationName,'--sign-in-audience','AzureADMyOrg')
} else { $registration = $registrations[0] }
$principals = @(AzureJson @('ad','sp','list','--filter',"appId eq '$($registration.appId)'"))
$principal = if ($principals.Count) { $principals[0] } else { AzureJson @('ad','sp','create','--id',$registration.appId) }
$workspaces = Rest 'GET' "$fabric/v1/workspaces" $null $fabric
$workspace = $workspaces.value | Where-Object displayName -eq $FabricWorkspaceName | Select-Object -First 1
if (!$workspace) {
  $workspace = Rest 'POST' "$fabric/v1/workspaces" @{displayName=$FabricWorkspaceName;description='Data Cortex synthetic-only integration demonstrations';capacityId=$FabricCapacityId} $fabric
}
$roles = Rest 'GET' "$fabric/v1/workspaces/$($workspace.id)/roleAssignments" $null $fabric
if (!($roles.value | Where-Object { $_.principal.id -eq $principal.id })) {
  Rest 'POST' "$fabric/v1/workspaces/$($workspace.id)/roleAssignments" @{
    principal=@{id=$principal.id;type='ServicePrincipal'};role='Contributor'
  } $fabric | Out-Null
}
$secrets = @(AzureJson @('containerapp','secret','list','-g',$ResourceGroup,'-n',$SourceApp,'--show-values'))
$secret = ($secrets | Where-Object name -eq 'fabric-connector-secret').value
if (!$secret) {
  $credential = AzureJson @('ad','app','credential','reset','--id',$registration.appId,'--append','--display-name','Data Cortex Fabric connector','--years','1')
  $secret = $credential.password
}
$connectors = @(
  @{id='databricks';name='Sandbox Databricks';provider='databricks';baseUrl=$dbx;scope="$dbxResource/.default"},
  @{id='fabric';name='Synthetic Fabric workspace';provider='fabric';baseUrl=$fabric;scope="$fabric/.default";clientId=$registration.appId;tenantId=$account.tenantId;secretEnv='CORTEX_FABRIC_SECRET';workspaceId=$workspace.id},
  @{id='cortex-demo-api';name='Synthetic Cortex catalogue API';provider='openapi';baseUrl="https://$($source.properties.configuration.ingress.fqdn)/api/health";auth='anonymous'}
)
foreach ($name in $Apps) {
  $app = Rest 'GET' "https://management.azure.com/subscriptions/$($account.id)/resourceGroups/$ResourceGroup/providers/Microsoft.App/containerApps/$name`?api-version=2024-03-01" $null
  $existingJson=($app.properties.template.containers[0].env|Where-Object name -eq 'CORTEX_CONNECTORS').value
  $existingConnectors=if($existingJson){@($existingJson|ConvertFrom-Json)}else{@()}
  $managedIds=@($connectors|ForEach-Object {$_.id})
  $mergedConnectors=@($existingConnectors|Where-Object {$_.id -notin $managedIds})+@($connectors)
  $connectorJson=ConvertTo-Json -InputObject $mergedConnectors -Depth 15 -Compress
  $secretArgs = @('containerapp','secret','set','-g',$ResourceGroup,'-n',$name,'--secrets',"fabric-connector-secret=$secret")
  AzureJson $secretArgs | Out-Null
  $body = @{properties=@{template=($app.properties.template | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable)}}
  $body.properties.template.Remove('revisionSuffix')
  $body.properties.template.containers[0].env = @($body.properties.template.containers[0].env | Where-Object { $_.name -notin @('CORTEX_CONNECTORS','CORTEX_FABRIC_SECRET','AZURE_TENANT_ID') }) + @(
    @{name='CORTEX_CONNECTORS';value=$connectorJson},
    @{name='CORTEX_FABRIC_SECRET';secretRef='fabric-connector-secret'},
    @{name='AZURE_TENANT_ID';value=$account.tenantId}
  )
  Rest 'PATCH' "https://management.azure.com$($app.id)?api-version=2024-03-01" $body | Out-Null
}
Write-Host "Configured connectors in $($Apps -join ', '). Fabric workspace: $($workspace.id)."
Write-Host 'No tenant-wide settings were changed. Fabric source agents must be published before registration.'
