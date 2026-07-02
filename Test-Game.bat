@echo off
setlocal
rem Sandboxed fake-game test: runs the tracker with Discord OFF and a scratch
rem local DB (the shared Turso DB and your channels are never touched), then
rem replays a real carnage report from your MCC folder as if the game just
rem finished - so you can watch what the terminal does when a match comes in.
rem
rem Usage: Test-Game.bat [path-to-mpcarnagereport.xml]
rem   (no arg = your newest real report is replayed)
rem
rem Note: the match block prints ~45s after the drop - the map lookup polls
rem for a theater film that never arrives in the sandbox, then gives up.

cd /d "%~dp0"

rem Unique sandbox per run so two test windows can never race each other;
rem old sandboxes are swept best-effort (in-use ones just stay until reboot).
for /d %%d in ("%TEMP%\h3-fake-test-*") do rmdir /s /q "%%d" 2>nul
set "SB=%TEMP%\h3-fake-test-%RANDOM%"
mkdir "%SB%\mcc"

rem Pick the report to replay: the file you passed, else your newest real one.
set "MCC=%USERPROFILE%\AppData\LocalLow\MCC\Temporary"
set "REPORT=%~1"
if "%REPORT%"=="" (
  for /f "delims=" %%f in ('dir /b /od "%MCC%\mpcarnagereport*.xml" 2^>nul') do set "REPORT=%MCC%\%%f"
)
if "%REPORT%"=="" (
  echo [test] no carnage reports found in %MCC%
  pause
  exit /b 1
)

rem Sandbox config: a single space counts as "unset" to the tracker and
rem overrides the repo .env (dotenv never overwrites set env vars).
set "T=%SB:\=/%"
set "DB_URL=file:///%T%/h3.db"
set "DB_AUTH_TOKEN= "
set "DISCORD_RESULTS_WEBHOOK_URL= "
set "DISCORD_LEADERBOARD_WEBHOOK_URL= "
set "DISCORD_WEBHOOK_URL= "
set "DISCORD_BOT_TOKEN= "
set "MCC_CARNAGE_DIR=%SB%\mcc"

echo [test] Discord OFF - shared DB OFF - scratch DB: %SB%\h3.db
echo [test] fake game: %REPORT%
echo.

rem Drop the fake game in after the watcher has gone live (it ignores files
rem already present at startup). powershell avoids start/b's quote-mangling
rem of paths with spaces.
start "" /b powershell -NoProfile -Command "Start-Sleep 12; Copy-Item -LiteralPath '%REPORT%' -Destination '%SB%\mcc'; Write-Host ''; Write-Host '[test] fake game dropped in - the match should print above in ~45s (map lookup times out first)...'"
call npm run watch
echo.
echo [test] tracker stopped.
pause
