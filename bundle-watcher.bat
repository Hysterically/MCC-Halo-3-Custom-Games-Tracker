@echo off
setlocal
rem Assemble the watcher launchers (v3 distribution):
rem   dist\watcher-ready\Run-Tracker.bat + Install-Node.bat + H3-Tracker.zip
rem       - group settings baked in; the zip is the pinned Discord attachment
rem   dist\watcher-public\Run-Tracker.bat + Install-Node.bat
rem       - no settings, the GitHub release assets
rem The heavy lifting is in packaging\build-watcher.ps1; this wrapper just
rem reads the live upload URL out of the gitignored watcher\watcher.env.

set "HERE=%~dp0"

set "WEBHOOK_URL="
for /f "usebackq tokens=1,* delims==" %%a in ("%HERE%watcher\watcher.env") do (
  if /i "%%a"=="WEBHOOK_URL" set "WEBHOOK_URL=%%b"
)
if "%WEBHOOK_URL%"=="" (
  echo [bundle-watcher] no WEBHOOK_URL found in watcher\watcher.env
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%packaging\build-watcher.ps1"
if errorlevel 1 (
  echo [bundle-watcher] build failed
  exit /b 1
)
endlocal
