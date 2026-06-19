@echo off
setlocal
rem Build a release exe and assemble the flat Windows distribution zip:
rem   h3-tracker.exe + Start.bat + Setup.bat + README.txt + aliases.json
rem "Extract here" yields those files at the folder root (double-click Start.bat).

set "HERE=%~dp0"
rem Stamp the release version into the exe (for the outdated-build check). Pass
rem the tag as the first arg, e.g. `bundle.bat v1.7.0`; build.bat reads H3_VERSION.
if "%~1" neq "" set "H3_VERSION=%~1"
call "%HERE%build.bat"
if errorlevel 1 ( echo [bundle] build failed & exit /b 1 )

set "STAGE=%HERE%dist\h3-tracker"
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%"

copy /y "%HERE%build\bin\h3-tracker.exe" "%STAGE%\" >nul
copy /y "%HERE%packaging\Start.bat"      "%STAGE%\" >nul
copy /y "%HERE%packaging\Setup.bat"      "%STAGE%\" >nul
copy /y "%HERE%packaging\README.txt"     "%STAGE%\" >nul
copy /y "%HERE%packaging\aliases.json"   "%STAGE%\" >nul

set "ZIP=%HERE%dist\h3-tracker-windows.zip"
if exist "%ZIP%" del /q "%ZIP%"
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\*' -DestinationPath '%ZIP%' -Force"
if errorlevel 1 ( echo [bundle] zip failed & exit /b 1 )

echo.
echo [bundle] created %ZIP%
endlocal
