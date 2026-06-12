@echo off
rem Double-click this to re-run the Discord setup (change your webhook URLs).
rem cd pins .env/data lookups to this folder even if launched elevated.
cd /d "%~dp0"
title Halo 3 Customs Tracker - Setup
"%~dp0h3-tracker.exe" setup --force
echo.
pause
