@echo off
REM Launch the Halo 3 Customs Tracker from SOURCE (not the dist/ bundle).
REM Reads .env, data\h3.db and aliases.json from this folder.
cd /d "%~dp0"
title Halo 3 Customs Tracker
call npm run -s watch
echo.
echo Tracker stopped. Press any key to close.
pause >nul
