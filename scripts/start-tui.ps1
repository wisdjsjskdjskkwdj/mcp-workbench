<#
.SYNOPSIS
Launches the Claude-Code-style Black-Window Interactive Terminal Workbench (TUI) for MCP Workbench v0.3.0.
Automatically wakes the background Daemon if not already running.
#>
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$env:MCP_WORKBENCH_ROOT = $ProjectRoot

node ./dist/tui_console.js
