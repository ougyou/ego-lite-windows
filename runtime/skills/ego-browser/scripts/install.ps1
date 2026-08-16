# ego-browser skill installer (Windows)
#   - checks Node >= 22 and a Chrome/Edge/Brave binary
#   - installs the Copilot skill to ~/.copilot/skills/ego-browser
#   - adds bin\ego-browser.cmd to the user PATH (idempotent; -SkipPath to skip)
param([switch]$SkipPath)
$ErrorActionPreference = "Stop"

function Add-EgoBrowserToPath {
  param([string]$BinDir)
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) { $userPath = "" }
  $entries = @($userPath.Split(";") | Where-Object { $_ -ne "" })
  if ($entries -contains $BinDir) {
    Write-Host "[ok] already on user PATH: $BinDir"
    return
  }
  $newPath = ($userPath.TrimEnd(";") + ";" + $BinDir)
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "[ok] added to user PATH: $BinDir"
  Write-Host "     New terminals will pick it up ('ego-browser' works anywhere)."
}

$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # repo root
$SkillSource = Join-Path $Repo "skills\ego-browser"

Write-Host "== ego-browser skill installer (Windows) =="

# 1. Node check
$node = node --version 2>$null
if (-not $node) { Write-Error "Node not found. Install Node >= 22 first." }
$major = [int]($node -replace "v","" -split "\.")[0]
if ($major -lt 22) { Write-Error "Node $node found; need >= 22." }
Write-Host "[ok] Node $node"

# 2. Browser check
$candidates = @(
  $env:EGO_LINUX_CHROME,
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
  "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe"
) | Where-Object { $_ -and (Test-Path $_) }
if (-not $candidates) {
  Write-Warning "No Chrome/Edge/Brave found. Install one, or set EGO_LINUX_CHROME."
} else {
  Write-Host "[ok] browser: $($candidates[0])"
}

# 3. Install Copilot skill (user-level)
$Dest = Join-Path $HOME ".copilot\skills\ego-browser"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item "$SkillSource\*" $Dest -Recurse -Force
Write-Host "[ok] Copilot skill installed to $Dest"
Write-Host "     Restart VS Code (or 'Developer: Reload Window') to activate."

# 4. Add bin\ to the user PATH so 'ego-browser' works anywhere (idempotent).
$binDir = Join-Path $Repo "bin"
$cmdPath = Join-Path $binDir "ego-browser.cmd"
if (Test-Path $cmdPath) {
  if (-not $SkipPath) {
    Add-EgoBrowserToPath -BinDir $binDir
  } else {
    Write-Host "[skip] PATH not modified (-SkipPath). Add manually:"
    Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';' + '$binDir', 'User')"
  }
}

Write-Host ""
Write-Host "Done. Next: node scripts\verify.mjs  (from the repo root)."
