# Fetch official llama.cpp Windows x64 CPU prebuilds for Murmur polish.
#
# Produces:  .sidecars/bin/llama-server.exe  (+ required DLLs)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/sidecars/fetch-llama-win.ps1
#
# Override tag: $env:LLAMA_TAG = 'b10278'

$ErrorActionPreference = 'Stop'

$LlamaTag = if ($env:LLAMA_TAG) { $env:LLAMA_TAG } else { 'b10276' }
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$OutDir = if ($env:OUT_DIR) { $env:OUT_DIR } else { Join-Path $RepoRoot '.sidecars\bin' }
$WorkDir = if ($env:WORK_DIR) { $env:WORK_DIR } else { Join-Path $RepoRoot '.sidecars\cache' }

$ZipName = "llama-$LlamaTag-bin-win-cpu-x64.zip"
$Url = "https://github.com/ggml-org/llama.cpp/releases/download/$LlamaTag/$ZipName"
$ZipPath = Join-Path $WorkDir $ZipName
$ExtractDir = Join-Path $WorkDir "llama-bin-win-cpu-x64-$LlamaTag"

function Write-Log([string]$Message) {
  Write-Host "[fetch-llama-win] $Message"
}

Write-Log "llama.cpp $LlamaTag -> $OutDir"
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not (Test-Path $ZipPath)) {
  Write-Log "downloading $Url"
  try {
    Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
  } catch {
    Write-Log "download failed for $Url - try a newer LLAMA_TAG from github.com/ggml-org/llama.cpp/releases"
    throw
  }
} else {
  Write-Log "using cached $ZipPath"
}

if (Test-Path $ExtractDir) {
  Remove-Item -Recurse -Force $ExtractDir
}
Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

$ServerSrc = Get-ChildItem -Path $ExtractDir -Filter 'llama-server.exe' -Recurse -File | Select-Object -First 1
if (-not $ServerSrc) {
  $ServerSrc = Get-ChildItem -Path $ExtractDir -Filter 'server.exe' -Recurse -File | Select-Object -First 1
}
if (-not $ServerSrc) {
  throw "llama-server.exe not found under $ExtractDir"
}

$ServerDir = $ServerSrc.DirectoryName
Copy-Item -Force $ServerSrc.FullName (Join-Path $OutDir 'llama-server.exe')
Write-Log "installed llama-server.exe"

Get-ChildItem -Path $ServerDir -Filter '*.dll' -File | ForEach-Object {
  Copy-Item -Force $_.FullName (Join-Path $OutDir $_.Name)
  Write-Log "installed $($_.Name)"
}

$Server = Join-Path $OutDir 'llama-server.exe'
if (-not (Test-Path $Server)) {
  throw "install failed: $Server missing"
}

Write-Log "ok: $Server"
Write-Host $Server
