@echo off
cd /d "%~dp0"
title cBot Control (phone access)

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

if not exist phone-access.env (
  echo Choose a password for opening the dashboard on your phone and iPad.
  echo Use at least 8 letters and numbers only.
  set /p "PW=Password: "
  call echo DASHBOARD_PASSWORD=%%PW%%> phone-access.env
  echo Saved. To change it later, delete the file phone-access.env.
)
for /f "usebackq tokens=1,* delims==" %%a in ("phone-access.env") do set "%%a=%%b"
set HOST=0.0.0.0

echo.
echo Keep this window open. Close it to stop the dashboard.
echo If Windows asks whether Node.js may use the network, allow it on Private networks.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:3000"
node server/index.js
pause
