# install.ps1 — one-line web installer for the Cowork Workflow Miner (Windows).
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/hungnt0406/cowork-logs-analysis/main/install.ps1 | iex
#
# What it does: downloads the latest GitHub Release (falls back to the main branch
# zip when no release exists), installs Bun if missing, runs `bun install`, and
# prints how to launch the interactive wizard.
#
# Env overrides:  $env:DIR (default cowork-logs-analysis)  $env:BRANCH (default main)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # much faster Invoke-WebRequest on Windows PowerShell 5.1

$repo   = "hungnt0406/cowork-logs-analysis"
$dir    = if ($env:DIR)    { $env:DIR }    else { "cowork-logs-analysis" }
$branch = if ($env:BRANCH) { $env:BRANCH } else { "main" }

if (Test-Path $dir) {
  throw "'$dir' already exists - remove it or set `$env:DIR to another path"
}

Write-Host "Resolving latest release of $repo ..."
$tag = $null
try {
  $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" `
    -Headers @{ "User-Agent" = "cowork-installer" }
  $tag = $rel.tag_name
} catch { }

if ($tag) {
  $url = "https://codeload.github.com/$repo/zip/refs/tags/$tag"
  Write-Host "Latest release: $tag"
} else {
  $url = "https://codeload.github.com/$repo/zip/refs/heads/$branch"
  Write-Host "No release found - using branch '$branch'"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cowork-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp "src.zip"

Write-Host "Downloading $url ..."
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $tmp -Force

# GitHub zips nest everything under a single <repo>-<ref>\ dir — lift it to $dir.
$inner = Get-ChildItem -Path $tmp -Directory |
  Where-Object { $_.Name -like "cowork-logs-analysis-*" } | Select-Object -First 1
if (-not $inner) { throw "unexpected archive layout" }
Move-Item -Path $inner.FullName -Destination $dir
Write-Host "Extracted to .\$dir"

# Best-effort temp cleanup. `Remove-Item -Recurse` can throw "Access is denied" on
# Windows (a race deleting the tree, or the zip still briefly locked) — leftover
# temp files are harmless, so NEVER let cleanup abort an otherwise-finished install.
try {
  [System.IO.Directory]::Delete($tmp, $true)
} catch {
  Write-Host "Note: could not remove temp dir $tmp (safe to delete later)."
}

# Install Bun if missing (mirrors start.ps1).
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "Bun not found - installing from https://bun.sh ..."
  powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex"
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
}

Write-Host "Installing dependencies ..."
Push-Location $dir
bun install
Pop-Location

Write-Host ""
Write-Host "Done. Launch the interactive wizard:"
Write-Host "  cd $dir; .\start.cmd"
Write-Host ""
Write-Host "(The wizard preflights deps, lists your sessions, runs the pipeline, and"
Write-Host ' optionally drafts skills. The --no-judge smoke path costs $0.)'
