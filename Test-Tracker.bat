@echo off
rem Sandboxed test run. Watches the real MCC folder and posts match results to
rem the normal results channel (from .env), but records to a scratch DB with
rem the leaderboard webhook and bot disabled - so the real leaderboard and
rem shared DB are never touched. Close the window to stop.
rem
rem Usage: Test-Tracker.bat [other-webhook-url]   (optional override)

cd /d "%~dp0"

rem file:/// URL needs forward slashes.
set "T=%TEMP:\=/%"
set "DB_URL=file:///%T%/h3-test.db"
rem A single space counts as "unset" to the tracker, overriding .env.
set "DB_AUTH_TOKEN= "
set "DISCORD_LEADERBOARD_WEBHOOK_URL= "
set "DISCORD_BOT_TOKEN= "
set "DISCORD_WEBHOOK_URL= "
if not "%~1"=="" set "DISCORD_RESULTS_WEBHOOK_URL=%~1"

echo.
echo [test] scratch DB : %TEMP%\h3-test.db  (delete it to reset between runs)
echo [test] leaderboard + shared DB: OFF  -  result posts: ON (from .env)
echo [test] play a Halo 3 custom; the result should appear with the map.
echo.
npm run watch
