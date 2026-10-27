$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBin = Join-Path $taskRoot 'data/bin'
New-Item -ItemType Directory -Force -Path $taskBin | Out-Null
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest' -Headers @{ 'User-Agent' = 'Techzolo-local-webhook-setup' }
$asset = $release.assets | Where-Object { $_.name -eq 'cloudflared-windows-amd64.exe' } | Select-Object -First 1
if (-not $asset -or $asset.browser_download_url -notlike 'https://github.com/cloudflare/cloudflared/releases/download/*') { throw 'The official cloudflared Windows asset was not found.' }
$taskExe = Join-Path $taskBin 'cloudflared.exe'
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $taskExe
if ($asset.digest -and $asset.digest.StartsWith('sha256:')) {
  $actual = (Get-FileHash -LiteralPath $taskExe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $asset.digest.Substring(7)) { throw 'cloudflared SHA-256 verification failed. The binary will not be run.' }
}
Write-Output "Downloaded official cloudflared $($release.tag_name) to $taskExe"
& $taskExe --version
