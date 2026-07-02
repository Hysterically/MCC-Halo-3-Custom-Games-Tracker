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
rem NOTE: no parentheses in echo text anywhere in this file - a ")" inside an
rem if-block ends the block and cmd aborts the whole script with the window
rem closing instantly (this exact bug shipped in v2.0.0/v2.0.1).
where node >nul 2>nul
if not errorlevel 1 goto have_node
call :find_node
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
if defined NODE_DIR goto have_node
echo [setup] Node.js not found - installing it now, one time, about a minute...
winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo.
  echo [setup] Automatic install failed. Please install Node.js LTS yourself
  echo         from https://nodejs.org and then double-click Run-Tracker.bat again.
  pause
  exit /b 1
)
call :find_node
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
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
  echo [setup] Installing tracker packages - one time, about a minute...
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
exit /b 0

rem Find a Node.js install this shell's PATH doesn't know about yet: the
rem machine-wide MSI location and winget's per-user location. Sets NODE_DIR.
:find_node
set "NODE_DIR="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_DIR=%ProgramFiles%\nodejs"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_DIR=%LOCALAPPDATA%\Programs\nodejs"
exit /b 0
