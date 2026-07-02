@echo off
rem One-time setup for the Halo 3 Customs Tracker: installs Node.js - the
rem runtime the tracker runs on - if it's missing, then downloads the
rem tracker's packages. Run this once; after that, use Run-Tracker.bat.
rem NOTE: no parentheses in echo text anywhere in this file - a ")" inside an
rem if-block ends the block and cmd aborts the whole script.
title Halo 3 Customs Tracker - Install

echo This sets up the Halo 3 Customs Tracker on this PC:
echo.
echo   1. Node.js is installed - only if it's missing. Windows may show an
echo      administrator prompt for its installer.
echo   2. The tracker's packages are downloaded into the app folder.
echo.
echo Press any key to continue - or close this window to cancel.
pause >nul
echo.

rem A .env dropped next to the launchers belongs in app\ where the tracker
rem reads it from.
if exist "%~dp0.env" move /y "%~dp0.env" "%~dp0app\.env" >nul
cd /d "%~dp0app"
if exist version.txt set /p H3_VERSION=<version.txt

rem --- Node.js -----------------------------------------------------------------
where node >nul 2>nul
if not errorlevel 1 goto node_ok
call :find_node
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
if defined NODE_DIR goto node_ok
echo [install] Installing Node.js - about a minute...
winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
rem winget's failure codes are 0x8A15xxxx values, NEGATIVE as signed ints, so
rem "if errorlevel 1" misses them - compare the exact value instead.
if not "%errorlevel%"=="0" goto node_install_failed
call :find_node
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto node_not_visible
:node_ok
echo [install] Node.js: OK

rem --- tracker packages ----------------------------------------------------------
echo [install] Installing the tracker's packages - about a minute...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo [install] Package install failed - check your internet connection and
  echo           run Install.bat again.
  pause
  exit /b 1
)

echo.
echo [install] All set. Press any key to start the tracker now - or close this
echo           window and double-click Run-Tracker.bat whenever you play.
pause >nul
call npx tsx src/watch.ts
echo.
echo Tracker stopped. Press any key to close this window.
pause >nul
exit /b 0

:node_install_failed
echo.
echo [install] Node.js did NOT get installed.
echo.
echo If Windows showed an administrator prompt and you clicked No, that's
echo why - the installer needs that permission. Run Install.bat again and
echo choose Yes on the prompt.
echo.
echo If there was no prompt or it failed some other way, install Node.js LTS
echo yourself from https://nodejs.org and then run Install.bat again.
echo.
pause
exit /b 1

:node_not_visible
echo.
echo [install] Node.js finished installing, but this window can't see it yet.
echo           Close this window and run Install.bat again to finish the setup.
echo.
pause
exit /b 1

rem Find a Node.js install this window's PATH doesn't know about yet: the
rem machine-wide MSI location and winget's per-user location. Sets NODE_DIR.
:find_node
set "NODE_DIR="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_DIR=%ProgramFiles%\nodejs"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_DIR=%LOCALAPPDATA%\Programs\nodejs"
exit /b 0
