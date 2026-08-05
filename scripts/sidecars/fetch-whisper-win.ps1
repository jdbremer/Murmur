# Fetch official whisper.cpp Windows x64 prebuilds for Murmur (PLAN §4.1 / G7).
#
# Produces:  .sidecars/bin/whisper-server.exe  (+ required DLLs)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/sidecars/fetch-whisper-win.ps1
#   $env:WHISPER_TAG = 'v1.9.2'; .\scripts\sidecars\fetch-whisper-win.ps1
#
# Why prebuilt: overnight Windows boxes may not have CMake on PATH; the ggml-org
# release zip already ships whisper-server.exe for x64. Pinned tag matches
# scripts/sidecars/build-whisper.sh.

$ErrorActionPreference = 'Stop'

$WhisperTag = if ($env:WHISPER_TAG) { $env:WHISPER_TAG } else { 'v1.9.2' }
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$OutDir = if ($env:OUT_DIR) { $env:OUT_DIR } else { Join-Path $RepoRoot '.sidecars\bin' }
$WorkDir = if ($env:WORK_DIR) { $env:WORK_DIR } else { Join-Path $RepoRoot '.sidecars\cache' }

$ZipName = 'whisper-bin-x64.zip'
$Url = "https://github.com/ggml-org/whisper.cpp/releases/download/$WhisperTag/$ZipName"
$ZipPath = Join-Path $WorkDir $ZipName
$ExtractDir = Join-Path $WorkDir "whisper-bin-x64-$WhisperTag"

function Write-Log([string]$Message) {
  Write-Host "[fetch-whisper-win] $Message"
}

Write-Log "whisper.cpp $WhisperTag → $OutDir"
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not (Test-Path $ZipPath)) {
  Write-Log "downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
} else {
  Write-Log "using cached $ZipPath"
}

if (Test-Path $ExtractDir) {
  Remove-Item -Recurse -Force $ExtractDir
}
Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

# Official zip nests under Release\
$ReleaseDir = Join-Path $ExtractDir 'Release'
if (-not (Test-Path (Join-Path $ReleaseDir 'whisper-server.exe'))) {
  # Some layouts are flat
  $ReleaseDir = $ExtractDir
}
if (-not (Test-Path (Join-Path $ReleaseDir 'whisper-server.exe'))) {
  throw "whisper-server.exe not found under $ExtractDir"
}

# Copy server + every DLL it may load (CPU backends are selected at runtime).
$patterns = @('whisper-server.exe', '*.dll')
foreach ($pattern in $patterns) {
  Get-ChildItem -Path $ReleaseDir -Filter $pattern -File | ForEach-Object {
    Copy-Item -Force $_.FullName (Join-Path $OutDir $_.Name)
    Write-Log "installed $($_.Name)"
  }
}

$Server = Join-Path $OutDir 'whisper-server.exe'
if (-not (Test-Path $Server)) {
  throw "install failed: $Server missing"
}

Write-Log "ok: $Server"
Write-Host $Server
