@echo off
rem Double-click this to start the Halo 3 Customs Tracker.
rem First run: installs Node.js (via winget) and the tracker's packages if
rem missing, then starts. After that it starts straight away.
rem The tracker itself lives in app\ - this launcher is all you touch.
title Halo 3 Customs Tracker

rem A .env dropped next to Run-Tracker.bat is moved into app\ (where the tracker
rem reads it from), so "put the settings file next to Run-Tracker.bat" just works.
if exist "%~dp0.env" move /y "%~dp0.env" "%~dp0app\.env" >nul

rem cd pins .env/data lookups to the app folder even if launched elevated.
cd /d "%~dp0app"

rem Version stamp for the outdated-build notice (written by bundle.bat).
if exist version.txt set /p H3_VERSION=<version.txt

rem --- one-time: make sure Node.js is available -------------------------------
where node >nul 2>nul
if not errorlevel 1 goto have_node
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  goto have_node
)
echo [setup] Node.js not found - installing it now (one-time, about a minute)...
winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo.
  echo [setup] Automatic install failed. Please install Node.js LTS yourself
  echo         from https://nodejs.org and then double-click Run-Tracker.bat again.
  pause
  exit /b 1
)
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [setup] Node.js was installed but needs a fresh window to be picked up.
  echo         Please close this window and double-click Run-Tracker.bat again.
  pause
  exit /b 1
)
:have_node

rem --- one-time: install the tracker's packages -------------------------------
if not exist node_modules (
  echo [setup] Installing tracker packages (one-time)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [setup] Package install failed - check your internet connection and
    echo         double-click Run-Tracker.bat again.
    pause
    exit /b 1
  )
)

rem --- run ---------------------------------------------------------------------
call npx tsx src/watch.ts
echo.
echo Tracker stopped. Press any key to close this window.
pause >nul
