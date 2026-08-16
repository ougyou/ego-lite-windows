@echo off
setlocal
chcp 65001 >nul
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%..\cli\ego-vision.mjs" %*
exit /b %ERRORLEVEL%
