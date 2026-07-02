$ErrorActionPreference = "Stop"

$RepoUrl = $env:OPENCODE_FEATURES_REPO
if (-not $RepoUrl) {
  $RepoUrl = "https://git.stockhome.com.au/stocky789/opencode.git"
}

$Branch = $env:OPENCODE_FEATURES_BRANCH
if (-not $Branch) {
  $Branch = "features"
}

$InstallRoot = $env:OPENCODE_FEATURES_INSTALL_DIR
if (-not $InstallRoot) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA "opencode-features"
}

function Resolve-BinDir {
  if ($env:OPENCODE_FEATURES_BIN_DIR) {
    return $env:OPENCODE_FEATURES_BIN_DIR
  }

  $userLocalBin = Join-Path $env:USERPROFILE ".local\bin"
  $pathEntries = @($env:Path, [Environment]::GetEnvironmentVariable("Path", "User")) -join ";"
  foreach ($entry in ($pathEntries -split ";" | Where-Object { $_ })) {
    if ([System.IO.Path]::GetFullPath($entry).TrimEnd("\") -eq [System.IO.Path]::GetFullPath($userLocalBin).TrimEnd("\")) {
      return $userLocalBin
    }
  }

  return Join-Path $InstallRoot "bin"
}

$SourceDir = Join-Path $InstallRoot "source"
$BinDir = Resolve-BinDir

function Info($Message) {
  Write-Host "[opencode features] $Message"
}

function Require-Command($Name, $InstallHint) {
  if (Get-Command $Name -ErrorAction SilentlyContinue) {
    return
  }
  throw "$Name is required. $InstallHint"
}

function Ensure-Bun {
  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if ($bun) {
    return $bun.Source
  }

  Info "Installing Bun"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"

  $candidates = @(
    (Join-Path $env:USERPROFILE ".bun\bin\bun.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\bun.exe")
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if ($bun) {
    return $bun.Source
  }

  throw "Bun installed, but bun.exe was not found. Restart the terminal and rerun this installer."
}

function Add-UserPath($PathToAdd) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $items = @()
  if ($current) {
    $items = $current -split ";" | Where-Object { $_ }
  }

  if ($items -contains $PathToAdd) {
    return
  }

  [Environment]::SetEnvironmentVariable("Path", (($items + $PathToAdd) -join ";"), "User")
  $env:Path = "$PathToAdd;$env:Path"
  Info "Added $PathToAdd to your user PATH. Open a new terminal after this install."
}

Require-Command "git" "Install Git for Windows, then rerun this command: winget install --id Git.Git -e"
$Bun = Ensure-Bun

New-Item -ItemType Directory -Force -Path $InstallRoot, $BinDir | Out-Null

if (Test-Path (Join-Path $SourceDir ".git")) {
  Info "Updating $Branch branch in $SourceDir"
  git -C $SourceDir fetch origin $Branch --depth 1
  git -C $SourceDir checkout -B $Branch "origin/$Branch"
} else {
  if (Test-Path $SourceDir) {
    throw "$SourceDir already exists but is not a git checkout. Remove it or set OPENCODE_FEATURES_INSTALL_DIR."
  }
  Info "Cloning $RepoUrl#$Branch"
  git clone --branch $Branch --depth 1 $RepoUrl $SourceDir
}

Info "Installing dependencies"
& $Bun install --cwd $SourceDir

$PackageDir = Join-Path $SourceDir "packages\opencode"
$EntryPoint = Join-Path $PackageDir "src\index.ts"
$LauncherCmd = @"
@echo off
setlocal
"$Bun" --conditions=browser "$EntryPoint" %*
"@

$LauncherPs1 = @"
& "$Bun" --conditions=browser "$EntryPoint" @args
"@

Set-Content -LiteralPath (Join-Path $BinDir "opencode.cmd") -Value $LauncherCmd -NoNewline -Encoding ascii
Set-Content -LiteralPath (Join-Path $BinDir "opencode-features.cmd") -Value $LauncherCmd -NoNewline -Encoding ascii
Set-Content -LiteralPath (Join-Path $BinDir "opencode-features.ps1") -Value $LauncherPs1 -NoNewline -Encoding ascii

Add-UserPath $BinDir

Info "Installed feature branch launcher"
Write-Host ""
Write-Host "Run:"
Write-Host "  opencode"
Write-Host ""
Write-Host "Or explicitly:"
Write-Host "  opencode-features"
