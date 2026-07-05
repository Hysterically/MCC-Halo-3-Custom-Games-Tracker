@echo off
setlocal
title H3 Customs Watcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :nonode

node -e "process.exit(Number(process.versions.node.split('.')[0])>=18?0:1)" >nul 2>nul
if errorlevel 1 goto :oldnode

if not exist "watcher.env" goto :noconfig

:run
node watcher.mjs
rem Exit code 42 means the watcher just replaced itself with a newer version.
if %errorlevel%==42 goto :run
echo.
echo The watcher stopped. Press any key to start it again, or close this window.
pause >nul
goto :run

:nonode
echo Node.js was not found on this PC.
echo Install the LTS version from https://nodejs.org then run this again.
echo.
pause
exit /b 1

:oldnode
echo Your Node.js is too old for the watcher - it needs version 18 or newer.
echo Install the current LTS from https://nodejs.org then run this again.
echo.
pause
exit /b 1

:noconfig
echo watcher.env is missing. It must sit next to this file and contain the
echo WEBHOOK_URL=... line for the group's carnage inbox.
echo Ask your host for it, or copy watcher.env.example and fill it in.
echo.
pause
exit /b 1
