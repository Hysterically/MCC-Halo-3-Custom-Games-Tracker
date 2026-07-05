@echo off
rem One-time Node.js installer for the H3 Customs Tracker. Node.js is the
rem free, official program that runs the tracker's code; Run-Tracker.bat
rem sends people here when it can't find it.
rem NOTE: no parentheses in echo text anywhere in this file - a ")" inside
rem an if-block ends the block and cmd aborts the whole script.
title H3 Customs Tracker - Install Node.js
setlocal

rem Already good? Check the version too - 18 or newer is what the tracker needs.
where node >nul 2>nul
if errorlevel 1 goto check_hidden
node -e "process.exit(Number(process.versions.node.split('.')[0])>=18?0:1)" >nul 2>nul
if not errorlevel 1 goto already
echo Your Node.js is too old for the tracker - this will update it to the
echo current LTS version.
echo.
goto consent

:check_hidden
rem Node might be installed but not on this window's PATH yet.
call :find_node
if defined NODE_DIR goto already

:consent
echo This installs Node.js - the free, official program that runs the tracker.
echo Windows may show an administrator prompt for its installer - choose Yes.
echo.
echo Press any key to install Node.js - or close this window to cancel.
pause >nul
echo.

where winget >nul 2>nul
if errorlevel 1 goto nowinget

echo Installing Node.js - about a minute...
winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
rem winget's failure codes are 0x8A15xxxx values, NEGATIVE as signed ints, so
rem "if errorlevel 1" misses them - compare the exact value instead.
if not "%errorlevel%"=="0" goto failed
call :find_node
if not defined NODE_DIR goto notvisible

echo.
echo All set - Node.js is installed.
echo Close this window and double-click Run-Tracker.bat to start the tracker.
echo.
pause
exit /b 0

:already
echo Node.js is already installed on this PC - nothing to do here.
echo Close this window and double-click Run-Tracker.bat to start the tracker.
echo.
pause
exit /b 0

:nowinget
echo This PC can't install it automatically. Installing it yourself only
echo takes a minute: go to https://nodejs.org and click the green LTS
echo button, then next, next, finish. After that run Run-Tracker.bat again.
echo.
pause
exit /b 1

:failed
echo.
echo Node.js did NOT get installed.
echo.
echo If Windows showed an administrator prompt and you clicked No, that's
echo why - the installer needs that permission. Run this again and choose
echo Yes on the prompt.
echo.
echo If it failed some other way, install Node.js yourself from
echo https://nodejs.org - the green LTS button - then run Run-Tracker.bat.
echo.
pause
exit /b 1

:notvisible
echo.
echo Node.js finished installing but this window can't see it yet.
echo Close this window and double-click Run-Tracker.bat - it should work now.
echo.
pause
exit /b 0

rem Find a Node.js install this window's PATH doesn't know about yet: the
rem machine-wide MSI location and winget's per-user location. Sets NODE_DIR.
:find_node
set "NODE_DIR="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_DIR=%ProgramFiles%\nodejs"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_DIR=%LOCALAPPDATA%\Programs\nodejs"
exit /b 0
