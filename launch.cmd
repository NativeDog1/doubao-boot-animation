@echo off
rem Doubao Boot Animation - launcher (visible console, shows the log)
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

node "%~dp0bin\inject.mjs" %*
if errorlevel 1 goto :failed
exit /b 0

:no_node
echo.
echo  [Doubao Boot Animation] Node.js 22 or newer is required.
echo  Install it from https://nodejs.org/ then run this file again.
echo.
pause
exit /b 1

:failed
echo.
echo  The intro did not play. The log is here:
echo  %LOCALAPPDATA%\DoubaoBootAnimation\logs\latest.log
echo.
pause
exit /b 1