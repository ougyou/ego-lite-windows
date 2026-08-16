# Install the ego-browser + ego-vision skills for GitHub Copilot (VS Code).
# Copies skills/ego-browser -> ~/.copilot/skills/ego-browser and
# ego-vision/ego-vision -> ~/.copilot/skills/ego-vision, and adds bin\ + ego-vision\bin\ to the
# user PATH so 'ego-browser' and 'ego-vision' work anywhere.
# Restart / reload VS Code afterwards. -SkipPath skips the PATH step.
param([switch]$SkipPath)
$ErrorActionPreference = "Stop"

function Add-DirToUserPath {
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
  Write-Host "     New terminals will pick it up."
}

$Repo = Split-Path -Parent $PSScriptRoot

# --- skill 1: ego-browser ---
$Src1 = Join-Path $Repo "skills\ego-browser"
$Dest1 = Join-Path $HOME ".copilot\skills\ego-browser"
if (-not (Test-Path $Src1)) { Write-Error "Skill source not found: $Src1" }
New-Item -ItemType Directory -Force -Path $Dest1 | Out-Null
Copy-Item "$Src1\*" $Dest1 -Recurse -Force
Write-Host "[ok] Copilot skill installed to: $Dest1"

# --- skill 2: ego-vision ---
$Src2 = Join-Path $Repo "ego-vision\ego-vision"
$Dest2 = Join-Path $HOME ".copilot\skills\ego-vision"
if (Test-Path $Src2) {
  New-Item -ItemType Directory -Force -Path $Dest2 | Out-Null
  Copy-Item "$Src2\*" $Dest2 -Recurse -Force
  Write-Host "[ok] ego-vision skill installed to: $Dest2"
} else {
  Write-Warning "ego-vision skill source not found: $Src2 (skipped)"
}

# --- capability check: vendored deps + language packs (offline, must be present) ---
$visionTess = Join-Path $Repo "ego-vision\node_modules\tesseract.js"
$visionEng = Join-Path $Repo "ego-vision\data\eng.traineddata"
$visionZh  = Join-Path $Repo "ego-vision\data\chi_sim.traineddata"
if ((Test-Path $visionTess) -and (Test-Path $visionEng) -and (Test-Path $visionZh)) {
  Write-Host "[ok] vision capability vendored deps + language packs present (offline OK)"
} else {
  Write-Warning "vision vendored deps/data incomplete - run setup (npm install + language pack download) under ego-vision/ first"
}

Write-Host "     Next: in VS Code run 'Developer: Reload Window' (or restart)."

# --- PATH: bin\ (ego-browser) + ego-vision\bin\ (ego-vision) ---
if (-not $SkipPath) {
  $bins = @((Join-Path $Repo "bin"), (Join-Path $Repo "ego-vision\bin"))
  foreach ($b in $bins) {
    if (Test-Path $b) { Add-DirToUserPath -BinDir $b }
  }
} else {
  Write-Host "[skip] user PATH not modified (-SkipPath)."
}
