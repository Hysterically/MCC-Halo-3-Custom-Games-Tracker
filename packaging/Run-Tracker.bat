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
if not defined NODE_DIR goto no_node
set "PATH=%NODE_DIR%;%PATH%"
:node_ok

if not exist node_modules goto no_packages

call npx tsx src/watch.ts
echo.
echo Tracker stopped. Press any key to close this window.
pause >nul
exit /b 0

:no_node
echo.
echo Can't start: Node.js is not installed on this PC.
echo Node.js is the program the tracker runs on - without it nothing can run.
echo This launcher never installs things itself, so:
echo.
echo   1. Double-click Install.bat - it's in this folder. It installs Node.js
echo      and the tracker's packages, and takes about a minute.
echo   2. Then double-click Run-Tracker.bat again.
echo.
echo Press any key to close this window.
pause >nul
exit /b 1

:no_packages
echo.
echo Can't start: the tracker's packages are missing from this folder.
echo That's normal if this is a fresh download - the packages aren't part of
echo the .zip, they get downloaded once by the installer. So:
echo.
echo   1. Double-click Install.bat - it's in this folder. Since Node.js is
echo      already installed, this only takes a moment.
echo   2. Then double-click Run-Tracker.bat again.
echo.
echo Press any key to close this window.
pause >nul
exit /b 1

rem Find a Node.js install this window's PATH doesn't know about yet: the
rem machine-wide MSI location and winget's per-user location. Sets NODE_DIR.
:find_node
set "NODE_DIR="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_DIR=%ProgramFiles%\nodejs"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_DIR=%LOCALAPPDATA%\Programs\nodejs"
exit /b 0
