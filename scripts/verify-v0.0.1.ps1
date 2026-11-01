<#
.SYNOPSIS
Executes the 6-Step Acceptance Verification Suite for MCP Workbench Gateway Prototype v0.0.1.
#>
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

if (-not (Test-Path "./dist/verify_acceptance.js")) {
    Write-Host "[MCP Workbench] Compiling TypeScript sources..." -ForegroundColor Cyan
    npm run build
}

Write-Host "[MCP Workbench] Running 6-Step Acceptance Verification Suite..." -ForegroundColor Green
node ./dist/verify_acceptance.js
