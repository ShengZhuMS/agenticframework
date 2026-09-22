#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess,ConfirmImpact='High')]
param(
  [Parameter(Mandatory)][string]$EnvironmentUrl,
  [string]$PacPath='pac'
)
$ErrorActionPreference='Stop'
if($EnvironmentUrl -notmatch '^https://[a-z0-9-]+\.crm[0-9]*\.dynamics\.com/?$'){throw 'Provide the reviewed Dataverse environment URL.'}
$source=Join-Path (Split-Path $PSScriptRoot -Parent) 'bootstrap\copilot-studio'
if(!(Test-Path (Join-Path $source 'settings.mcs.yml'))){throw 'The synthetic Studio source pack is missing.'}
Get-Command $PacPath -ErrorAction Stop|Out-Null
if(!$PSCmdlet.ShouldProcess($EnvironmentUrl,'Import and publish only the cortex_SyntheticCatalogueGuide solution using the current authenticated PAC profile')){return}
$output=Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
try{
  & $PacPath copilot pack --publisher-prefix cortex --project-dir $source --solution-name cortex_SyntheticCatalogueGuide --output-path $output
  if($LASTEXITCODE -ne 0){throw 'Studio source packaging failed.'}
  & $PacPath solution import --path (Join-Path $output 'cortex_SyntheticCatalogueGuide.zip') --environment $EnvironmentUrl --async --max-async-wait-time 10
  if($LASTEXITCODE -ne 0){throw 'Studio solution import failed; inspect the environment operation before retrying.'}
  & $PacPath copilot publish --bot cortex_SyntheticCatalogueGuide --environment $EnvironmentUrl
  if($LASTEXITCODE -ne 0){throw 'Studio source publication failed.'}
  Write-Host 'Synthetic Studio guide published. Source authentication is preserved; this does not enable the environment S2S preview or distribute a Teams app.'
}finally{
  if(Test-Path -LiteralPath $output){Remove-Item -LiteralPath $output -Recurse -Force}
}
