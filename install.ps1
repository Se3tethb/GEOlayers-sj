# GeoMotion installer for After Effects (Windows).
# 1) allows unsigned CEP panels (PlayerDebugMode = 1 for CSXS 9..12)
# 2) copies this folder to %APPDATA%\Adobe\CEP\extensions\com.sajad.geomotion
# Restart After Effects afterwards, then open: Window > Extensions > GeoMotion

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dst = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.sajad.geomotion'

foreach ($v in 9, 10, 11, 12) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -Type String
}

if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item -Recurse -Force (Join-Path $src 'CSXS'), (Join-Path $src 'css'), (Join-Path $src 'js'), (Join-Path $src 'jsx'), (Join-Path $src 'index.html') $dst

Write-Host "GeoMotion installed to $dst"
Write-Host "Restart After Effects, then: Window > Extensions > GeoMotion"
