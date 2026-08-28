<#
.SYNOPSIS
  Run Cortex locally against your real Azure resources.

.DESCRIPTION
  There is no offline mode: Cortex reads Purview, API Management and Foundry
  through their real APIs. This runs the app on your machine, signed in as you
  through the Azure CLI, against the same Azure resources the deployed app uses.

  Because there is no Easy Auth in front of a local process, sign-in is
  simulated with the groups you pass. That is why ALLOW_UNAUTHENTICATED exists
  and why it must never be set on a deployed environment.

.EXAMPLE
  .\scripts\Start-Local.ps1 -Groups all-staff,waste-crime,analysts
#>
[CmdletBinding()]
param(
  [string[]]$Groups = @('all-staff'),
  [string]$UserName = 'Local developer',
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
  if (-not (az account show 2>$null)) { az login | Out-Null }

  $kv = $null
  azd env get-values 2>$null | ForEach-Object {
    if ($_ -match '^KEYVAULT_NAME="?([^"]*)"?$') { $kv = $Matches[1] }
  }
  if (-not $kv) { throw 'No Key Vault found. Deploy first, or set KEYVAULT_NAME by hand.' }

  Write-Host "Key Vault : $kv"
  Write-Host "Signed in : $UserName"
  Write-Host "Groups    : $($Groups -join ', ')"
  Write-Host "URL       : http://localhost:$Port`n"
  Write-Host 'Running against REAL Azure resources. Anything you publish is real.' -ForegroundColor Yellow
  Write-Host ''

  $env:KEYVAULT_NAME        = $kv
  $env:PORT                 = $Port
  $env:ALLOW_UNAUTHENTICATED = 'true'
  $env:LOCAL_DEV_USER       = $UserName
  $env:LOCAL_DEV_GROUPS     = ($Groups -join ',')

  npm start
}
finally { Pop-Location }
