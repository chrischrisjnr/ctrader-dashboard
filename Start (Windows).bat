@echo off
cd /d "%~dp0"
title cBot Control

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed yet. Opening the download page...
  echo Install the "LTS" version, then double-click this file again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

if not exist node_modules (
  echo First start: installing, this takes about a minute...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo.
echo The dashboard will open in your browser: http://127.0.0.1:3000
echo Keep this window open while your bots run. Close it to stop the dashboard.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:3000"
node server/index.js
pause
