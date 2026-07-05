@echo off
setlocal
title H3 Customs Tracker
cd /d "%~dp0"

rem ---------------------------------------------------------------------
rem  H3 Customs Tracker - the watcher, everything in one file. Its code
rem  sits below the payload marker at the bottom of this file and is
rem  unpacked to watcher.mjs on first run. The watcher keeps watcher.mjs
rem  up to date by itself after that, so an existing copy is never
rem  overwritten.
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
echo The tracker stopped. Press any key to start it again, or close this window.
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
if exist "%~dp0Install-Node.bat" goto nonode_helper
echo Install the LTS version from https://nodejs.org then run this again.
echo Or grab Install-Node.bat from the tracker's download page and it will
echo install Node.js for you.
echo.
pause
exit /b 1

:nonode_helper
echo Double-click Install-Node.bat - it's in this folder, right next to this
echo file - and it will install Node.js for you. Then run this file again.
echo.
pause
exit /b 1

:oldnode
echo Your Node.js is too old for the tracker - it needs version 18 or newer.
if exist "%~dp0Install-Node.bat" goto oldnode_helper
echo Install the current LTS from https://nodejs.org then run this again.
echo.
pause
exit /b 1

:oldnode_helper
echo Double-click Install-Node.bat - it's in this folder, right next to this
echo file - and it will update Node.js for you. Then run this file again.
echo.
pause
exit /b 1

::PAYLOAD
