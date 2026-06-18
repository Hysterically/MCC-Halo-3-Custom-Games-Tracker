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

"%CMAKE%" -S "%SRCDIR%." -B "%BUILDDIR%" -G Ninja ^
  -DCMAKE_MAKE_PROGRAM="%NINJA%" ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_TOOLCHAIN_FILE="%VCPKG_TC%" ^
  -DVCPKG_TARGET_TRIPLET=x64-windows-static
if errorlevel 1 ( echo [build] configure failed & exit /b 1 )

"%CMAKE%" --build "%BUILDDIR%" --config Release
if errorlevel 1 ( echo [build] compile failed & exit /b 1 )

echo [build] OK -^> %BUILDDIR%\bin\h3-tracker.exe
endlocal
