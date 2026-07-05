@echo off
setlocal
rem Assemble the single-file watcher launchers (v3 distribution - no zip):
rem   dist\watcher-ready\Run-Watcher.bat  - group settings baked in, for the
rem                                         pinned Discord #tracker-download post
rem   dist\watcher-public\Run-Watcher.bat - no settings, the GitHub release asset
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
