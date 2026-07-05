# Assembles the single-file watcher launchers (template header + watcher.mjs
# payload). Called by bundle-watcher.bat, which puts the live upload URL in
# WEBHOOK_URL for the ready variant; the public variant ships with it empty.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$template = [IO.File]::ReadAllText((Join-Path $root 'packaging\Run-Watcher.template.bat'))
$payload = [IO.File]::ReadAllText((Join-Path $root 'watcher\watcher.mjs'))

# The header must be CRLF or cmd can miss "goto :label" targets; the payload
# after the marker is JavaScript and keeps whatever endings the repo has.
$template = $template -replace "`r?`n", "`r`n"
if (-not $template.EndsWith("`r`n")) { $template += "`r`n" }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$readyDir = Join-Path $root 'dist\watcher-ready'
$publicDir = Join-Path $root 'dist\watcher-public'
New-Item -ItemType Directory -Force $readyDir | Out-Null
New-Item -ItemType Directory -Force $publicDir | Out-Null

$ready = $template.Replace('__WEBHOOK_URL__', [string]$env:WEBHOOK_URL) + $payload
$public = $template.Replace('__WEBHOOK_URL__', '') + $payload
[IO.File]::WriteAllText((Join-Path $readyDir 'Run-Watcher.bat'), $ready, $utf8)
[IO.File]::WriteAllText((Join-Path $publicDir 'Run-Watcher.bat'), $public, $utf8)

# The public variant goes on GitHub - it must never carry the live URL.
if ($env:WEBHOOK_URL -and $public.Contains($env:WEBHOOK_URL)) {
  throw 'public variant contains the live webhook URL'
}

Write-Host "[build-watcher] dist\watcher-ready\Run-Watcher.bat  (settings baked in)"
Write-Host "[build-watcher] dist\watcher-public\Run-Watcher.bat (no settings - GitHub)"
