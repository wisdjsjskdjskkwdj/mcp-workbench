@echo off
chcp 65001 >nul
title Stop MCP Workbench
cd /d "%~dp0"

echo [INFO] Stopping MCP Workbench Daemon on port 43110...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :43110 ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)
if exist ".workbench-daemon.lock.json" del /f /q ".workbench-daemon.lock.json" >nul 2>&1

echo [OK] MCP Workbench Daemon has been stopped.
echo The web console (http://127.0.0.1:43110/ui) is now closed.
timeout /t 2 >nul
