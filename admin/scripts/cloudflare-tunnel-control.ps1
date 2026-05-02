param(
  [ValidateSet("Status", "Start", "Stop", "Lockdown")]
  [string]$Action = "Status",
  [switch]$Elevated
)

$ErrorActionPreference = "Stop"
$ServiceName = if ($env:CLOUDFLARED_SERVICE_NAME) { $env:CLOUDFLARED_SERVICE_NAME } else { "Cloudflared" }
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$MainPidFile = Join-Path $ProjectRoot ".server.pid"

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-TunnelStatus {
  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Name -like "cloudflared*"
    })

  [pscustomobject]@{
    serviceName = $ServiceName
    serviceInstalled = [bool]$service
    serviceStatus = if ($service) { [string]$service.Status } else { "" }
    processCount = $processes.Count
    running = (($service -and $service.Status -eq "Running") -or $processes.Count -gt 0)
  }
}

function Write-Status {
  Get-TunnelStatus | ConvertTo-Json -Compress
}

function Stop-MainWebsite {
  $pids = New-Object System.Collections.Generic.HashSet[int]
  if (Test-Path $MainPidFile) {
    $pidText = Get-Content $MainPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    $pidValue = 0
    if ([int]::TryParse($pidText, [ref]$pidValue) -and $pidValue -gt 0) {
      [void]$pids.Add($pidValue)
    }
  }

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -like "node*" -and $_.CommandLine -like "*apps/main/src/server.js*"
  } | ForEach-Object {
    [void]$pids.Add([int]$_.ProcessId)
  }

  foreach ($pidValue in $pids) {
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $MainPidFile -Force -ErrorAction SilentlyContinue
}

function Start-Tunnel {
  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($service) {
    if ($service.Status -ne "Running") {
      Start-Service -Name $ServiceName
      Start-Sleep -Milliseconds 800
    }
    return
  }

  $cloudflared = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if (-not $cloudflared) {
    $cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
  }
  if (-not $cloudflared) {
    throw "Cloudflared service is not installed and cloudflared is not on PATH."
  }
  throw "Cloudflared is installed as a command, but no service named '$ServiceName' exists. Install a named tunnel service or set CLOUDFLARED_SERVICE_NAME."
}

function Stop-Tunnel {
  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($service -and $service.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
  }

  Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

if ($Action -ne "Status" -and -not (Test-IsAdmin) -and -not $Elevated) {
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$PSCommandPath`"",
    "-Action", $Action,
    "-Elevated"
  )
  Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -Verb RunAs -Wait
  Write-Status
  exit 0
}

switch ($Action) {
  "Start" {
    Start-Tunnel
    Write-Status
  }
  "Stop" {
    Stop-Tunnel
    Write-Status
  }
  "Lockdown" {
    Stop-MainWebsite
    Stop-Tunnel
    Write-Status
  }
  default {
    Write-Status
  }
}
