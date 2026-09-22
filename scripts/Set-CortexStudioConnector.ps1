#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess,ConfirmImpact='High')]
param(
  [Parameter(Mandatory)][string]$ResourceGroup,
  [Parameter(Mandatory)][string]$EnvironmentId,
  [string]$AgentSchema='cortex_SyntheticCatalogueGuide',
  [string[]]$Apps=@('cortex-web','cortex-web-microsoft','cortex-web-novo')
)
$ErrorActionPreference='Stop'
function AzureJson([string[]]$Arguments) {
  $text=& az @Arguments --only-show-errors -o json
  if($LASTEXITCODE -ne 0){throw "Azure operation failed: $($Arguments[0..1] -join ' ')"}
  if($text){$text|ConvertFrom-Json -Depth 100}
}
function Rest([string]$Method,[string]$Url,$Body) {
  $file=$null
  try{
    $args2=@('rest','--method',$Method,'--url',$Url)
    if($null -ne $Body){
      $file=Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
      $Body|ConvertTo-Json -Depth 80|Set-Content -LiteralPath $file -Encoding utf8NoBOM
      $args2+=@('--body',"@$file")
    }
    AzureJson $args2
  }finally{if($file){Remove-Item -LiteralPath $file -Force}}
}
if($EnvironmentId -notmatch '^(Default-)?[0-9a-f-]{36}$' -or $AgentSchema -notmatch '^[A-Za-z][A-Za-z0-9_]{1,100}$'){throw 'Invalid environment ID or published agent schema.'}
$account=AzureJson @('account','show')
$resource=@(AzureJson @('ad','sp','list','--filter',"appId eq '8578e004-a5c6-46e7-913e-12f58912df43'"))[0]
$role=$resource.appRoles|Where-Object { $_.id -eq '38c13204-7d79-4d83-bdbb-b770e28400df' -and $_.isEnabled -and $_.allowedMemberTypes -contains 'Application' }
if(!$role){throw 'The Copilot Studio application-invoke permission is not available in this tenant.'}
if(!$PSCmdlet.ShouldProcess('Dedicated Cortex Studio connector','Create a dedicated application, grant its approved invoke permission, and configure the three apps')){return}
$name='Data Cortex Studio connector'
$matches=@(AzureJson @('ad','app','list','--filter',"displayName eq '$name'"))
if($matches.Count -gt 1){throw 'Multiple Studio connector registrations exist.'}
$app=if($matches.Count){$matches[0]}else{AzureJson @('ad','app','create','--display-name',$name,'--sign-in-audience','AzureADMyOrg')}
$principals=@(AzureJson @('ad','sp','list','--filter',"appId eq '$($app.appId)'"))
$principal=if($principals.Count){$principals[0]}else{AzureJson @('ad','sp','create','--id',$app.appId)}
$existing=@($app.requiredResourceAccess|Where-Object {$_})
if($existing | Where-Object {$_.resourceAppId -ne $resource.appId}){throw 'This registration has unrelated permissions. Refusing to change it.'}
if($existing.resourceAccess | Where-Object {$_.id -ne $role.id -or $_.type -ne 'Role'}){throw 'This registration has additional Power Platform permissions. Refusing to replace them.'}
Rest 'PATCH' "https://graph.microsoft.com/v1.0/applications/$($app.id)" @{
  requiredResourceAccess=@(@{resourceAppId=$resource.appId;resourceAccess=@(@{id=$role.id;type='Role'})})
}|Out-Null
$assignments=Rest 'GET' "https://graph.microsoft.com/v1.0/servicePrincipals/$($principal.id)/appRoleAssignments" $null
if(!($assignments.value|Where-Object {$_.resourceId -eq $resource.id -and $_.appRoleId -eq $role.id})){
  Rest 'POST' "https://graph.microsoft.com/v1.0/servicePrincipals/$($principal.id)/appRoleAssignments" @{
    principalId=$principal.id;resourceId=$resource.id;appRoleId=$role.id
  }|Out-Null
}
$secrets=@(AzureJson @('containerapp','secret','list','-g',$ResourceGroup,'-n',$Apps[0],'--show-values'))
$secret=($secrets|Where-Object name -eq 'studio-connector-secret').value
if(!$secret){$secret=(AzureJson @('ad','app','credential','reset','--id',$app.appId,'--append','--display-name','Data Cortex Studio connector','--years','1')).password}
$normalized=$EnvironmentId.ToLower().Replace('-','')
$hostName=$normalized.Substring(0,$normalized.Length-2)+'.'+$normalized.Substring($normalized.Length-2)+'.environment.api.powerplatform.com'
$connector=@{id='studio';name='Synthetic Copilot Studio guide';provider='m365';protocol='direct-engine';agentId=$AgentSchema
  baseUrl="https://$hostName";scope='https://api.powerplatform.com/.default';clientId=$app.appId;tenantId=$account.tenantId;secretEnv='CORTEX_STUDIO_SECRET'}
foreach($name in $Apps){
  $id="/subscriptions/$($account.id)/resourceGroups/$ResourceGroup/providers/Microsoft.App/containerApps/$name"
  $web=Rest 'GET' "https://management.azure.com$id`?api-version=2024-03-01" $null
  $envVars=$web.properties.template.containers[0].env
  $current=($envVars|Where-Object name -eq 'CORTEX_CONNECTORS').value|ConvertFrom-Json
  $configured=@($current|Where-Object id -ne 'studio')+@($connector)
  AzureJson @('containerapp','secret','set','-g',$ResourceGroup,'-n',$name,'--secrets',"studio-connector-secret=$secret")|Out-Null
  $template=$web.properties.template|ConvertTo-Json -Depth 80|ConvertFrom-Json -AsHashtable
  $template.Remove('revisionSuffix')
  $template.containers[0].env=@($envVars|Where-Object {$_.name -notin @('CORTEX_CONNECTORS','CORTEX_STUDIO_SECRET')})+@(
    @{name='CORTEX_CONNECTORS';value=(ConvertTo-Json -InputObject $configured -Depth 15 -Compress)},
    @{name='CORTEX_STUDIO_SECRET';secretRef='studio-connector-secret'}
  )
  Rest 'PATCH' "https://management.azure.com$id`?api-version=2024-03-01" @{properties=@{template=$template}}|Out-Null
}
Write-Host "Studio connector configured. Application: $($app.appId). Source: $AgentSchema. No existing agent or tenant-wide installation changed."
