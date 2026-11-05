@echo off
chcp 65001 >nul 2>nul
rem Doubao Boot Animation - settings (visible console, for troubleshooting)
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

node "%~dp0bin\settings.mjs" %*
exit /b 0

:no_node
echo.
echo  [Doubao Boot Animation] Node.js 22 or newer is required.
echo  Install it from https://nodejs.org/ then run this file again.
echo.
pause
exit /b 1
