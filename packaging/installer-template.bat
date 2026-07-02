@echo off
setlocal EnableExtensions
title Halo 3 Customs Tracker
rem One-file installer/launcher for the Halo 3 Customs Tracker.
rem First double-click: downloads the tracker from GitHub into
rem %USERPROFILE%\h3-tracker, drops in the group settings, and starts it.
rem Later double-clicks: updates if a newer release exists, then starts.
rem Keep this file anywhere - Desktop is fine. It IS the tracker's icon.
rem
rem This is a TEMPLATE: packaging\make-installer.py appends the group's
rem settings as ::ENV:: lines at the bottom (secrets - never commit the
rem generated file). H3_TRACKER_DIR / H3_NO_RUN overrides exist for testing.

set "DIR=%USERPROFILE%\h3-tracker"
if defined H3_TRACKER_DIR set "DIR=%H3_TRACKER_DIR%"
set "REPO=Hysterically/MCC-Halo-3-Custom-Games-Tracker"
set "ZIPURL=https://github.com/%REPO%/releases/latest/download/h3-tracker-windows.zip"

rem --- newest released version, from the /releases/latest redirect ------------
rem Best-effort: offline or blocked just means we run what's installed.
set "URL="
set "LATEST="
for /f "usebackq delims=" %%u in (`curl -s -L -o nul -w "%%{url_effective}" "https://github.com/%REPO%/releases/latest" 2^>nul`) do set "URL=%%u"
if defined URL for %%a in ("%URL%") do set "LATEST=%%~nxa"

if not exist "%DIR%\Start.bat" goto install

rem --- already installed: update first if a newer release exists --------------
set "CUR="
if exist "%DIR%\app\version.txt" set /p CUR=<"%DIR%\app\version.txt"
if not defined LATEST goto run
if /i "%LATEST%"=="latest" goto run
if /i "%CUR%"=="%LATEST%" goto run
echo [update] New tracker version %LATEST% (you have %CUR%) - updating...
goto fetch

:install
echo [install] Installing the tracker to %DIR% (one-time)...

:fetch
mkdir "%DIR%" 2>nul
curl -s -L -o "%TEMP%\h3-tracker-dl.zip" "%ZIPURL%"
if errorlevel 1 (
  if exist "%DIR%\Start.bat" goto run
  echo [install] Download failed - check your internet connection and
  echo           double-click this file again.
  pause
  exit /b 1
)
tar -xf "%TEMP%\h3-tracker-dl.zip" -C "%DIR%"
if errorlevel 1 (
  if exist "%DIR%\Start.bat" goto run
  echo [install] Could not unpack the download - try again.
  pause
  exit /b 1
)
del /q "%TEMP%\h3-tracker-dl.zip" 2>nul
rem friends never need the webhook re-setup tool
del /q "%DIR%\Setup.bat" 2>nul
rem after an update, force a fresh package install (deps may have changed)
if defined CUR if exist "%DIR%\app\node_modules" rmdir /s /q "%DIR%\app\node_modules" 2>nul
rem group settings (the ::ENV:: lines at the bottom of this file) -> app\.env
powershell -NoProfile -Command "(Get-Content -LiteralPath '%~f0') -match '^::ENV::' -replace '^::ENV::','' | Set-Content -Encoding ascii -LiteralPath '%DIR%\app\.env'"

:run
if defined H3_NO_RUN exit /b 0
call "%DIR%\Start.bat"
exit /b

rem ---- group settings below; added by make-installer.py - do not edit ----
