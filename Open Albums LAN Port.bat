@echo off
setlocal

set "RULE_NAME=Albums App Local Test 3000"
set "PORT=3000"

net session >nul 2>nul
if errorlevel 1 (
  echo This needs Administrator permission to change Windows Firewall.
  echo Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ruleName='%RULE_NAME%'; $port=%PORT%; $existing=Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue; if (-not $existing) { New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null; Write-Host 'Opened TCP port' $port 'for local network testing.' } else { Set-NetFirewallRule -DisplayName $ruleName -Enabled True -Profile Any -Action Allow | Out-Null; Write-Host 'Firewall rule already exists and is enabled.' }; $ips=Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -ExpandProperty IPAddress; Write-Host ''; Write-Host 'Try these from your phone while on the same network:'; foreach ($ip in $ips) { Write-Host ('  http://' + $ip + ':' + $port) }"
pause
