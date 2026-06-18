@echo off
rem Double-click this to start the Halo 3 Customs Tracker.
rem On the very first run it walks you through Discord setup, then starts tracking.
rem cd pins .env/data lookups to this folder even if launched elevated.
cd /d "%~dp0"
title Halo 3 Customs Tracker
"%~dp0h3-tracker.exe"
echo.
echo Tracker stopped. Press any key to close this window.
pause >nul
