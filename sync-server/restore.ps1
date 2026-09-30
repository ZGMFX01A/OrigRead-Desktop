param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile,
  [Parameter(Mandatory = $true)]
  [string]$DataDirectory,
  [switch]$ServiceStopped
)

$ErrorActionPreference = 'Stop'
if (-not $ServiceStopped) { throw 'Stop the Sync Server before restore, then pass -ServiceStopped.' }
if (-not (Test-Path -LiteralPath $BackupFile -PathType Leaf)) { throw "Backup archive not found: $BackupFile" }
$data = (Resolve-Path -LiteralPath $DataDirectory).Path
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("origread-sync-restore-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $staging | Out-Null
try {
  Expand-Archive -LiteralPath $BackupFile -DestinationPath $staging -Force
  $items = Get-ChildItem -LiteralPath $staging -Force
  if (-not ($items | Where-Object Name -eq 'sync-server.db')) { throw 'Backup does not contain sync-server.db' }
  if (-not ($items | Where-Object Name -eq 'blobs')) { throw 'Backup does not contain the blobs directory' }
  if (Get-ChildItem -LiteralPath $data -Force -ErrorAction SilentlyContinue) {
    throw "Restore target is not empty: $data. Stop the container and move the existing data aside first."
  }
  foreach ($item in $items) {
    Copy-Item -LiteralPath $item.FullName -Destination $data -Recurse -Force
  }
  Write-Output "OrigRead Sync backup restored to $data"
} finally {
  $resolvedStaging = [System.IO.Path]::GetFullPath($staging)
  $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if ($resolvedStaging.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
      [System.IO.Path]::GetFileName($resolvedStaging).StartsWith('origread-sync-restore-')) {
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force -ErrorAction SilentlyContinue
  }
}
