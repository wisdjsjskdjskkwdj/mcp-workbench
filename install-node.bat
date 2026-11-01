@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MCP Workbench - Node.js Environment Setup

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup_node.ps1"
echo.
pause
