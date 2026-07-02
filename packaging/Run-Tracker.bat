@echo off
rem Double-click this to run the Halo 3 Customs Tracker.
rem First time on this PC? Double-click Install.bat once instead - it sets
rem everything up. This launcher never installs or downloads anything.
rem NOTE: no parentheses in echo text anywhere in this file - a ")" inside an
rem if-block ends the block and cmd aborts the whole script.
title Halo 3 Customs Tracker

rem A .env dropped next to the launchers belongs in app\ where the tracker
rem reads it from, so "put the settings file next to Run-Tracker.bat" works.
if exist "%~dp0.env" move /y "%~dp0.env" "%~dp0app\.env" >nul

rem cd pins .env/data lookups to the app folder even if launched elevated.
cd /d "%~dp0app"

rem Version stamp for the outdated-build notice - written by bundle.bat.
if exist version.txt set /p H3_VERSION=<version.txt

rem Node.js may be installed but not on this window's PATH yet.
where node >nul 2>nul
if not errorlevel 1 goto node_ok
call :find_node
if not defined NODE_DIR goto not_installed
set "PATH=%NODE_DIR%;%PATH%"
:node_ok

if not exist node_modules goto not_installed

call npx tsx src/watch.ts
echo.
echo Tracker stopped. Press any key to close this window.
pause >nul
exit /b 0

:not_installed
echo.
echo The tracker isn't installed on this PC yet.
echo Double-click Install.bat - it's next to this file - then come back here.
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
