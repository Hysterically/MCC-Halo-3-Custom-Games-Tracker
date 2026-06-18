@echo off
REM Launch the C++ tracker (single exe) using THIS folder's .env,
REM data\h3.db and aliases.json (the same config the Node version uses).
cd /d "%~dp0"
title Halo 3 Customs Tracker (C++)
"%~dp0cpp\build\bin\h3-tracker.exe"
echo.
echo Tracker stopped. Press any key to close.
pause >nul
