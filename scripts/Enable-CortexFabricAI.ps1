#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess, ConfirmImpact='High')]
param(
  [Parameter(Mandatory)][string]$ApplicationId,
  [switch]$AllowCrossRegionProcessing
)
$ErrorActionPreference='Stop'
function AzureJson([string[]]$Arguments) {
  $value=& az @Arguments --only-show-errors -o json
  if($LASTEXITCODE -ne 0){throw "Azure operation failed: $($Arguments[0..1] -join ' ')"}
  if($value){$value|ConvertFrom-Json -Depth 60}
}
$url='https://api.fabric.microsoft.com/v1/admin/tenantsettings'
$settings=AzureJson @('rest','--method','get','--url',$url,'--resource','https://api.fabric.microsoft.com')
$setting=$settings.tenantSettings | Where-Object settingName -eq 'EnableAOAI'
$crossRegion=$settings.tenantSettings | Where-Object settingName -eq 'AllowSendAOAIDataToOtherRegions'
if(!$setting -or !$setting.canSpecifySecurityGroups){throw 'The required AI setting cannot be scoped to a security group.'}
$principal=AzureJson @('ad','sp','show','--id',$ApplicationId)
$action='Add the dedicated Cortex connector group to Azure OpenAI access, preserving existing groups'
if($AllowCrossRegionProcessing){$action+=' and explicitly allow cross-region processing for this group'}
if(!$PSCmdlet.ShouldProcess('Fabric tenant policy',$action)){return}
$name='Cortex Fabric AI Connector'
$groups=@(AzureJson @('ad','group','list','--filter',"displayName eq '$name'"))
if($groups.Count -gt 1){throw 'Multiple matching connector groups exist.'}
$group=if($groups.Count){$groups[0]}else{AzureJson @('ad','group','create','--display-name',$name,'--mail-nickname','cortex-fabric-ai')}
$expanded=AzureJson @('rest','--method','get','--url',"https://graph.microsoft.com/v1.0/groups/$($group.id)?`$expand=members")
$members=@($expanded.members)
if($members | Where-Object id -ne $principal.id){throw 'The dedicated connector group contains other identities. No policy change was applied.'}
if(!($members | Where-Object id -eq $principal.id)){AzureJson @('ad','group','member','add','--group',$group.id,'--member-id',$principal.id)|Out-Null}
if($crossRegion.enabled -and (!@($crossRegion.enabledSecurityGroups).Count -or (!$AllowCrossRegionProcessing -and ($crossRegion.enabledSecurityGroups|Where-Object graphId -eq $group.id)))){
  throw 'The connector would have cross-region processing access. Review the policy separately.'
}
if($setting.enabled -and !@($setting.enabledSecurityGroups).Count){throw 'Azure OpenAI is now enabled tenant-wide. Review the policy instead of replacing its scope.'}
$allowed=@($setting.enabledSecurityGroups|Where-Object {$_ -and $_.graphId -ne $group.id}) + @(@{graphId=$group.id;name=$name})
$body=@{enabled=$true;enabledSecurityGroups=$allowed;excludedSecurityGroups=@($setting.excludedSecurityGroups|Where-Object {$_});properties=$setting.properties}
foreach($key in @('delegateToCapacity','delegateToDomain','delegateToWorkspace')){if($null -ne $setting.$key){$body[$key]=$setting.$key}}
$file=Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
try{
  $body|ConvertTo-Json -Depth 30|Set-Content -LiteralPath $file -Encoding utf8NoBOM
  AzureJson @('rest','--method','post','--url',"$url/EnableAOAI/update",'--resource','https://api.fabric.microsoft.com','--body',"@$file")|Out-Null
  if($AllowCrossRegionProcessing){
    if($crossRegion.excludedSecurityGroups|Where-Object graphId -eq $group.id){throw 'The connector group is explicitly excluded from cross-region processing. Review that exclusion before changing it.'}
    $crossBody=@{
      enabled=$true
      enabledSecurityGroups=@($crossRegion.enabledSecurityGroups|Where-Object {$_ -and $_.graphId -ne $group.id}) + @(@{graphId=$group.id;name=$name})
      excludedSecurityGroups=@($crossRegion.excludedSecurityGroups|Where-Object {$_})
      properties=$crossRegion.properties
    }
    foreach($key in @('delegateToCapacity','delegateToDomain','delegateToWorkspace')){if($null -ne $crossRegion.$key){$crossBody[$key]=$crossRegion.$key}}
    $crossBody|ConvertTo-Json -Depth 30|Set-Content -LiteralPath $file -Encoding utf8NoBOM
    AzureJson @('rest','--method','post','--url',"$url/AllowSendAOAIDataToOtherRegions/update",'--resource','https://api.fabric.microsoft.com','--body',"@$file")|Out-Null
  }
  $unused=$settings.tenantSettings|Where-Object settingName -eq 'EnableOpenAISubprocessor'
  if($unused.enabled -and @($unused.enabledSecurityGroups).Count -eq 1 -and $unused.enabledSecurityGroups[0].graphId -eq $group.id){
    @{enabled=$false;enabledSecurityGroups=@();properties=$unused.properties}|ConvertTo-Json -Depth 30|Set-Content -LiteralPath $file -Encoding utf8NoBOM
    AzureJson @('rest','--method','post','--url',"$url/EnableOpenAISubprocessor/update",'--resource','https://api.fabric.microsoft.com','--body',"@$file")|Out-Null
  }
}finally{Remove-Item -LiteralPath $file -Force}
$updated=AzureJson @('rest','--method','get','--url',$url,'--resource','https://api.fabric.microsoft.com')
$ai=$updated.tenantSettings|Where-Object settingName -eq 'EnableAOAI'
$cross=$updated.tenantSettings|Where-Object settingName -eq 'AllowSendAOAIDataToOtherRegions'
$hasCrossRegion=[bool]($cross.enabled -and ($cross.enabledSecurityGroups|Where-Object graphId -eq $group.id))
if(!$ai.enabled -or !($ai.enabledSecurityGroups|Where-Object graphId -eq $group.id) -or $hasCrossRegion -ne [bool]$AllowCrossRegionProcessing){throw 'The expected scoped policy was not confirmed. Inspect the Fabric admin settings.'}
Write-Host "Azure OpenAI access confirmed for connector group $($group.id), preserving existing groups. Cross-region processing for this group: $hasCrossRegion."
