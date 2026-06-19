@echo off
setlocal
rem Build helper: sets up the MSVC dev environment (vcvars64) then configures
rem and builds with CMake + Ninja, using the Visual Studio-bundled toolchain
rem and vcpkg (static triplet -> single self-contained exe).

set "VSROOT=C:\Program Files\Microsoft Visual Studio\2022\Community"
set "CMAKE=%VSROOT%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
set "NINJA=%VSROOT%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
set "VCPKG_TC=%VSROOT%\VC\vcpkg\scripts\buildsystems\vcpkg.cmake"

call "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 ( echo [build] vcvars64 failed & exit /b 1 )

set "SRCDIR=%~dp0"
set "BUILDDIR=%SRCDIR%build"

rem Version stamped into the exe for the outdated-build check. The release path
rem (bundle.bat) sets H3_VERSION to the tag being shipped; a plain dev build
rem leaves it "dev", which keeps the update check silent.
if not defined H3_VERSION set "H3_VERSION=dev"
echo [build] version: %H3_VERSION%

"%CMAKE%" -S "%SRCDIR%." -B "%BUILDDIR%" -G Ninja ^
  -DCMAKE_MAKE_PROGRAM="%NINJA%" ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_TOOLCHAIN_FILE="%VCPKG_TC%" ^
  -DVCPKG_TARGET_TRIPLET=x64-windows-static ^
  -DH3_VERSION="%H3_VERSION%"
if errorlevel 1 ( echo [build] configure failed & exit /b 1 )

"%CMAKE%" --build "%BUILDDIR%" --config Release
if errorlevel 1 ( echo [build] compile failed & exit /b 1 )

echo [build] OK -^> %BUILDDIR%\bin\h3-tracker.exe
endlocal
