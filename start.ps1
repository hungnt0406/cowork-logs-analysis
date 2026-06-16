# start.ps1 — Windows entry point (PowerShell mirror of start.sh).
# Installs Bun if missing, then launches the interactive wizard (run.ts), which
# preflights deps, lists sessions, lets you pick, runs the pipeline, and optionally
# drafts skills.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "Bun not found - installing from https://bun.sh ..."
  powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex"
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
}

bun run "$dir\run.ts" @args
exit $LASTEXITCODE
