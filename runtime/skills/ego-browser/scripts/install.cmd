@echo off
setlocal EnableExtensions
REM ============================================================
REM  ego-browser skill installer (Windows, cmd)
REM   - checks Node >= 22 and a Chrome/Edge/Brave binary
REM   - installs the Copilot skill to ~\.copilot\skills\ego-browser
REM   - adds the repo bin\ folder to the user PATH (idempotent)
REM  Usage:  skills\ego-browser\scripts\install.cmd  [-SkipPath]
REM ============================================================

set "SKIP_PATH="
if /i "%~1"=="-SkipPath" set "SKIP_PATH=1"

set "REPO=%~dp0..\..\.."
set "SKILL_SRC=%REPO%\skills\ego-browser"
set "PF=%ProgramFiles%"
set "PF86=%ProgramFiles(x86)%"

echo == ego-browser skill installer (Windows) ==

REM --- 1. Node check (need >= 22) ---
set "NODE_MAJ="
for /f "tokens=1 delims=." %%a in ('node --version 2^>nul') do set "NODE_MAJ=%%a"
if not defined NODE_MAJ (
  echo [err] Node not found. Install Node ^>= 22 first.
  exit /b 1
)
set "NODE_MAJ=%NODE_MAJ:v=%"
if %NODE_MAJ% LSS 22 (
  echo [err] Node %NODE_MAJ% found; need ^>= 22.
  exit /b 1
)
echo [ok] Node %NODE_MAJ%

REM --- 2. Browser check ---
set "BROWSER="
if defined EGO_LINUX_CHROME if exist "%EGO_LINUX_CHROME%" set "BROWSER=%EGO_LINUX_CHROME%"
if not defined BROWSER if exist "%PF%\Google\Chrome\Application\chrome.exe" set "BROWSER=%PF%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%PF86%\Google\Chrome\Application\chrome.exe" set "BROWSER=%PF86%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%PF%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%PF%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%PF86%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%PF86%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%PF%\BraveSoftware\Brave-Browser\Application\brave.exe" set "BROWSER=%PF%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not defined BROWSER if exist "%PF86%\BraveSoftware\Brave-Browser\Application\brave.exe" set "BROWSER=%PF86%\BraveSoftware\Brave-Browser\Application\brave.exe"
if defined BROWSER (
  echo [ok] browser: %BROWSER%
) else (
  echo [warn] No Chrome/Edge/Brave found. Install one, or set EGO_LINUX_CHROME.
)

REM --- 3. Install the Copilot skill (user-level) ---
if not exist "%SKILL_SRC%" (
  echo [err] Skill source not found: %SKILL_SRC%
  exit /b 1
)
set "DEST=%USERPROFILE%\.copilot\skills\ego-browser"
if not exist "%DEST%" mkdir "%DEST%"
xcopy "%SKILL_SRC%\*" "%DEST%\" /e /i /y /q >nul 2>&1
echo [ok] Copilot skill installed to %DEST%
echo      Restart VS Code ^(or 'Developer: Reload Window'^) to activate.

REM --- 4. Add repo bin\ to the user PATH (idempotent) ---
if defined SKIP_PATH (
  echo [skip] PATH not modified ^(-SkipPath^). Add manually:
  echo   setx Path "%%PATH%%;%REPO%\bin"
  exit /b 0
)
call :AddPath "%REPO%\bin"
exit /b %ERRORLEVEL%

:AddPath
set "BIN=%~1"
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
