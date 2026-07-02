@echo off
setlocal
rem Assemble the Windows distribution zip for the TypeScript tracker:
rem   src\ + package.json + package-lock.json + tsconfig.json + aliases.json
rem   + Start.bat / Setup.bat / README.txt (from packaging\) + version.txt
rem "Extract here" then double-click Start.bat (first run self-installs Node
rem and the npm packages). Pass the release tag as the first arg, e.g.
rem   bundle.bat v2.0.0
rem The tag is written to version.txt, which Start.bat exports as H3_VERSION
rem for the outdated-build check (src/updateCheck.ts).

set "HERE=%~dp0"
set "VERSION=%~1"
if "%VERSION%"=="" (
  echo [bundle] usage: bundle.bat vX.Y.Z
  exit /b 1
)

rem Layout: root has ONLY Start.bat / Setup.bat / README.txt; the tracker
rem itself (source, configs, version.txt, later node_modules/data/.env)
rem lives in app\ so the folder doesn't look complex to friends.
set "STAGE=%HERE%dist\h3-tracker"
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%" "%STAGE%\app"

xcopy /e /i /q "%HERE%src"           "%STAGE%\app\src" >nul
copy /y "%HERE%package.json"         "%STAGE%\app\" >nul
copy /y "%HERE%package-lock.json"    "%STAGE%\app\" >nul
copy /y "%HERE%tsconfig.json"        "%STAGE%\app\" >nul
copy /y "%HERE%packaging\aliases.json" "%STAGE%\app\" >nul
<nul set /p ="%VERSION%" > "%STAGE%\app\version.txt"
copy /y "%HERE%packaging\Start.bat"  "%STAGE%\" >nul
copy /y "%HERE%packaging\Setup.bat"  "%STAGE%\" >nul
copy /y "%HERE%packaging\README.txt" "%STAGE%\" >nul

rem tar.exe (bsdtar, built into Windows 10+) writes standard forward-slash
rem zip entries; Compress-Archive would write backslashes, which some
rem extractors reject.
set "ZIP=%HERE%dist\h3-tracker-windows.zip"
if exist "%ZIP%" del /q "%ZIP%"
pushd "%STAGE%"
tar -a -cf "%ZIP%" *
if errorlevel 1 ( popd & echo [bundle] zip failed & exit /b 1 )
popd

echo.
echo [bundle] created %ZIP%
endlocal
