@echo off
chcp 65001 >nul
title MCP Workbench Daemon
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% equ 0 goto RUN_APP

if exist "%~dp0runtime\node-v24.18.0-win-x64\node.exe" (
  set "PATH=%~dp0runtime\node-v24.18.0-win-x64;%PATH%"
  goto RUN_APP
)

if exist "%~dp0installers\node-v24.18.0-win-x64.zip" (
  echo [INFO] Initializing bundled Node.js runtime...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup_node.ps1"
  if exist "%~dp0runtime\node-v24.18.0-win-x64\node.exe" (
    set "PATH=%~dp0runtime\node-v24.18.0-win-x64;%PATH%"
    goto RUN_APP
  )
)

echo [ERROR] Node.js is required but not found.
echo Please run install-node.bat or download Node.js from https://nodejs.org/
pause
exit /b 1

:RUN_APP
echo ===================================================
echo   MCP Workbench Unified Gateway (v0.3.0)
echo   Web Console: http://127.0.0.1:43110/ui
echo   MCP Endpoint: http://127.0.0.1:43110/mcp
echo ===================================================
echo.

node ./dist/daemon.js
pause
