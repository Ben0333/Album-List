@echo off
setlocal
set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$app=$env:APP_DIR; $pidFile=Join-Path $app '.server.pid'; $stopped=$false; $pidValue=0; if (Test-Path $pidFile) { [int]::TryParse((Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$pidValue) | Out-Null; if ($pidValue) { $proc=Get-Process -Id $pidValue -ErrorAction SilentlyContinue; if ($proc) { Stop-Process -Id $pidValue -Force; $stopped=$true } }; Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }; if (-not $stopped) { Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*src/server.js*' -and $_.Name -like 'node*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $script:stopped=$true } }; if ($stopped) { Write-Host 'Albums app stopped.' } else { Write-Host 'Albums app was not running.' }"
pause

