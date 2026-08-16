@echo off
rem ego-browser — forwards to the repo launcher.
rem Add this bin\ folder to your PATH to use `ego-browser` anywhere.
where node >nul 2>nul
if errorlevel 1 (
  echo [ego-browser] Node.js not found. Install Node ^>= 22 first: https://nodejs.org/
  exit /b 1
)
node "%~dp0..\scripts\ego-browser-launch.mjs" %*
exit /b %errorlevel%
