param([string]$OutDir = "testdata")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Chinese text built from code points so this file stays pure ASCII:
# PowerShell 5.1 reads BOM-less .ps1 as ANSI and would mangle UTF-8 literals.
# 哔哩哔哩 你好世界  => U+54D7 U+56E9 U+54D7 U+56E9 SP U+4F60 U+597D U+4E16 U+754C
$ZH_TEXT = -join ([char[]](0x54D7,0x56E9,0x54D7,0x56E9,0x20,0x4F60,0x597D,0x4E16,0x754C))

function New-Fixture([string]$Text, [string]$Path, [string]$FontName, [int]$Size) {
  $bmp = New-Object System.Drawing.Bitmap 640, 200
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $font = New-Object System.Drawing.Font($FontName, $Size, [System.Drawing.FontStyle]::Regular)
  $g.DrawString($Text, $font, [System.Drawing.Brushes]::Black, 20, 40)
  $g.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

New-Fixture "Hello World 12345" (Join-Path $OutDir "en.png") "Arial" 28
New-Fixture $ZH_TEXT (Join-Path $OutDir "zh.png") "Microsoft YaHei" 28
Write-Output "fixtures written to $OutDir"
