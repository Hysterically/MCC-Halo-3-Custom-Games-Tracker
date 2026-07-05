@echo off
setlocal
title H3 Customs Watcher
cd /d "%~dp0"

rem ---------------------------------------------------------------------
rem  H3 Customs Watcher - everything in one file. The watcher's code sits
rem  below the payload marker at the bottom of this file and is unpacked
rem  to watcher.mjs on first run. The watcher keeps watcher.mjs up to
rem  date by itself after that, so an existing copy is never overwritten.
rem ---------------------------------------------------------------------

rem The group's upload settings (baked in by bundle-watcher.bat).
set "H3_INBOX_WEBHOOK_URL=__WEBHOOK_URL__"

where node >nul 2>nul
if errorlevel 1 goto :nonode

node -e "process.exit(Number(process.versions.node.split('.')[0])>=18?0:1)" >nul 2>nul
if errorlevel 1 goto :oldnode

if not exist "watcher.mjs" call :unpack
if not exist "watcher.mjs" goto :unpackfail

:run
node watcher.mjs
rem Exit code 42 means the watcher just replaced itself with a newer version.
if %errorlevel%==42 goto :run
echo.
echo The watcher stopped. Press any key to start it again, or close this window.
pause >nul
goto :run

:unpack
rem Write everything after the marker line out as UTF-8, byte-faithful.
rem cmd tools like "more" would mangle the code's symbols, so PowerShell
rem does the split; the marker is spelled via char codes so this very
rem line can never be mistaken for it.
set "H3SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:H3SELF); $m=[string][char]58+[char]58+'PAYLOAD'; $i=$t.IndexOf($m); $s=$t.Substring($t.IndexOf([char]10,$i)+1); [IO.File]::WriteAllText((Join-Path (Split-Path $env:H3SELF) 'watcher.mjs'), $s, (New-Object System.Text.UTF8Encoding($false)))"
exit /b 0

:unpackfail
echo Could not unpack the watcher code next to this file.
echo Make sure this folder allows writing files, then run it again.
echo.
pause
exit /b 1

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

::PAYLOAD
