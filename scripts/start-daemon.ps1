<#
.SYNOPSIS
Starts the single-instance MCP Workbench Gateway Daemon (v0.0.1) on Windows PowerShell.
#>
param(
    [int]$Port = 43110
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$env:MCP_WORKBENCH_ROOT = $ProjectRoot
$env:MCP_WORKBENCH_PORT = "$Port"

if (-not (Test-Path "./dist/daemon.js")) {
    Write-Host "[MCP Workbench] Building TypeScript sources..." -ForegroundColor Cyan
    npm run build
}

Write-Host "[MCP Workbench] Starting Single-Instance Core Daemon on port $Port..." -ForegroundColor Green
node ./dist/daemon.js
