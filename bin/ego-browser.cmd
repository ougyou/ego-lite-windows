@echo off
rem ego-browser — runs the vendored runtime directly.
rem Add this bin\ folder to your PATH to use `ego-browser` anywhere.
rem One node process, no launcher hop: the runtime itself detects Windows
rem browsers (chrome.mjs windowsBrowserCandidates) and sets the skill
rem workspace, so scripts\ego-browser-launch.mjs is no longer needed here.
where node >nul 2>nul
if errorlevel 1 (
  echo [ego-browser] Node.js not found. Install Node ^>= 22 first: https://nodejs.org/
  exit /b 1
)
node "%~dp0..\runtime\ego-linux\bin\ego-browser.mjs" %*
exit /b %errorlevel%
