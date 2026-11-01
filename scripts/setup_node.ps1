[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "MCP Workbench - Node.js Setup"

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "  MCP Workbench - Node.js Runtime Setup" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

$rootDir = Split-Path -Parent $PSScriptRoot
$runtimeNodeExe = Join-Path $rootDir "runtime\node-v24.18.0-win-x64\node.exe"
$installerZip = Join-Path $rootDir "installers\node-v24.18.0-win-x64.zip"
$runtimeDir = Join-Path $rootDir "runtime"

if (Test-Path $runtimeNodeExe) {
    Write-Host "[OK] Node.js runtime already exists!" -ForegroundColor Green
    $ver = & $runtimeNodeExe -v
    Write-Host "Version: $ver" -ForegroundColor Green
    Write-Host ""
    Write-Host "Runtime is ready! You can now launch start-web.bat or start-cli.bat." -ForegroundColor Yellow
    exit 0
}

if (-not (Test-Path $installerZip)) {
    Write-Host "[ERROR] installers\node-v24.18.0-win-x64.zip not found!" -ForegroundColor Red
    Write-Host "Please ensure the installer exists or download Node.js from https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

Write-Host "[INFO] Extracting Node.js (v24.18.0) into runtime directory..." -ForegroundColor Cyan
Write-Host "Please wait a few seconds..." -ForegroundColor Gray

if (-not (Test-Path $runtimeDir)) {
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
}

try {
    Expand-Archive -Path $installerZip -DestinationPath $runtimeDir -Force
    if (Test-Path $runtimeNodeExe) {
        $ver = & $runtimeNodeExe -v
        Write-Host ""
        Write-Host "===================================================" -ForegroundColor Green
        Write-Host "  [SUCCESS] Node.js runtime is successfully installed!" -ForegroundColor Green
        Write-Host "  Version: $ver (Win-x64 Portable)" -ForegroundColor Green
        Write-Host "===================================================" -ForegroundColor Green
        Write-Host ""
        Write-Host "Launch scripts will automatically detect and use this runtime." -ForegroundColor White
        Write-Host "You can now run start-web.bat or start-cli.bat directly." -ForegroundColor Green
    } else {
        Write-Host "[ERROR] Extraction finished, but node.exe was not found." -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "[ERROR] Extraction failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
