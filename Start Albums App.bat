@echo off
setlocal
set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not on PATH.
  pause
  exit /b 1
)

if not exist "%APP_DIR%node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$app=$env:APP_DIR; $pidFile=Join-Path $app '.server.pid'; $oldPid=0; if (Test-Path $pidFile) { [int]::TryParse((Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$oldPid) | Out-Null }; if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { Start-Process 'http://localhost:3000'; exit 0 }; $node=(Get-Command node).Source; $proc=Start-Process -FilePath $node -ArgumentList 'src/server.js' -WorkingDirectory $app -WindowStyle Hidden -PassThru; Set-Content -Path $pidFile -Value $proc.Id; Start-Sleep -Milliseconds 900; Start-Process 'http://localhost:3000'"

