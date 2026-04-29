@echo off
setlocal

set "RULE_NAME=Albums App Local Test 3000"

net session >nul 2>nul
if errorlevel 1 (
  echo This needs Administrator permission to change Windows Firewall.
  echo Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ruleName='%RULE_NAME%'; $existing=Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue; if ($existing) { Remove-NetFirewallRule -DisplayName $ruleName; Write-Host 'Closed Albums app LAN firewall access.' } else { Write-Host 'Albums app LAN firewall rule was not present.' }"
pause
