@echo off
rem Double-click this to re-run the Discord setup (change your webhook URLs).
rem cd pins .env/data lookups to this folder even if launched elevated.
cd /d "%~dp0"
title Halo 3 Customs Tracker - Setup
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
call npx tsx src/setup.ts --force
echo.
pause
