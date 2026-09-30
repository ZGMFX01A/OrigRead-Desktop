param(
  [Parameter(Mandatory = $true)]
  [string]$DataDirectory,
  [Parameter(Mandatory = $true)]
  [string]$OutputFile,
  [switch]$ServiceStopped
)

$ErrorActionPreference = 'Stop'
if (-not $ServiceStopped) { throw 'Stop the Sync Server before backup, then pass -ServiceStopped.' }
$data = (Resolve-Path -LiteralPath $DataDirectory).Path
$parent = Split-Path -Parent $OutputFile
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

# SQLite WAL and the content-addressed Blob directory must be captured together.
# Stop the container first, or use an application-level snapshot, so the archive is coherent.
Compress-Archive -Path (Join-Path $data '*') -DestinationPath $OutputFile -Force
Write-Output "OrigRead Sync backup written to $OutputFile"
