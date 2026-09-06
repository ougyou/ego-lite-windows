@echo off
setlocal EnableExtensions
REM ============================================================
REM  Install the ego-browser skill for GitHub Copilot (VS Code).
REM  Copies skills\ego-browser -> ~\.copilot\skills\ego-browser
REM  and adds the repo bin\ folder to the user PATH so
REM  'ego-browser' works anywhere (idempotent).
REM  Restart / reload VS Code afterwards.
REM  Usage:  scripts\install-copilot-skill.cmd  [-SkipPath]
REM ============================================================

set "SKIP_PATH="
if /i "%~1"=="-SkipPath" set "SKIP_PATH=1"

set "REPO=%~dp0.."
set "SRC=%REPO%\skills\ego-browser"
set "DEST=%USERPROFILE%\.copilot\skills\ego-browser"

if not exist "%SRC%" (
  echo [err] Skill source not found: %SRC%
  exit /b 1
)

if not exist "%DEST%" mkdir "%DEST%"
xcopy "%SRC%\*" "%DEST%\" /e /i /y /q >nul 2>&1
echo [ok] Copilot skill installed to: %DEST%
echo      Next: in VS Code run 'Developer: Reload Window' ^(or restart^).

if defined SKIP_PATH (
  echo [skip] user PATH not modified ^(-SkipPath^).
  exit /b 0
)

REM --- add repo bin\ to the user PATH if not already present ---
set "BIN=%REPO%\bin"
if not exist "%BIN%\ego-browser.cmd" (
  echo [warn] %BIN%\ego-browser.cmd not found; PATH not modified.
  exit /b 0
)

set "USER_PATH="
for /f "skip=2 tokens=1,2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do (
  if /i "%%a"=="Path" set "USER_PATH=%%c"
)

echo "%USER_PATH%" | findstr /i /c:"%BIN%" >nul 2>&1
if not errorlevel 1 (
  echo [ok] already on user PATH: %BIN%
  exit /b 0
)

if not defined USER_PATH (
  set "NEW_PATH=%BIN%"
) else (
  set "NEW_PATH=%USER_PATH%;%BIN%"
)
reg add "HKCU\Environment" /v Path /t REG_EXPAND_SZ /d "%NEW_PATH%" /f >nul
echo [ok] added to user PATH: %BIN%
echo      New terminals will pick it up ^('ego-browser' works anywhere^).
exit /b 0
