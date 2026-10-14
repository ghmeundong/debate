@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Debate Studio Setup Builder

echo.
echo ========================================
echo   Debate Studio - Windows Setup Builder
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 20 or newer, then run this file again.
  goto :failed
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js with npm included.
  goto :failed
)

if not exist "node_modules\electron-builder\package.json" (
  echo Installing project dependencies...
  call npm install
  if errorlevel 1 goto :failed
)

set "DIST_DIR=release\debate-build-%RANDOM%-%RANDOM%"
echo Building the Debate Studio app and Windows installer...
echo Output folder: %DIST_DIR%
echo The installer lets you choose a Qwen2.5 dialogue model and also installs the 1.5B judge model.
echo.

call npm run dist:prepare
if errorlevel 1 goto :failed
call npm run dist:package -- --config.directories.output=%DIST_DIR%
if errorlevel 1 goto :failed

echo.
echo ========================================
echo   Setup build completed successfully.
echo ========================================
echo.
echo Installer: %CD%\%DIST_DIR%\Debate Studio Setup 0.1.0.exe
echo.
if exist "%DIST_DIR%\Debate Studio Setup 0.1.0.exe" start "" explorer.exe "%CD%\%DIST_DIR%"
pause
exit /b 0

:failed
echo.
echo Setup build failed. Read the error above, fix the prerequisite, and run this file again.
echo.
pause
exit /b 1
