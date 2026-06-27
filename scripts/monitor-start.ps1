#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Start the Gestalt-System-Monitor desktop dock cleanly (one instance), detached.

.DESCRIPTION
  Runs `npm run desktop:dev` from the submodule root, detached from the calling
  shell so it survives, with stdout/stderr captured to .codex-current-tauri-dev*.log.
  `desktop:dev` starts the web dev server (which auto-spawns the discovery agent on
  7788 via the vite gsm-agent plugin) and the Tauri dock; Rust only spawns the agent
  as a fallback if 7788 is unoccupied.

  Dev launch source is read from Monitor/.env.local (GSM_HEADLESS_PROFILE=standalone
  + GSM_STANDALONE_EXE => the repo's editor-built standalone). Use -Restart to stop
  any existing instance first (recommended — avoids stacked AppBar reservations).

.PARAMETER Restart
  Run monitor-stop.ps1 first for a clean slate.

.PARAMETER Mock
  Start the agent against the built-in fake LAN (sets GSM_AGENT=--mock for this run).

.PARAMETER TimeoutSec
  How long to wait for web@5180 + dock app.exe + agent@7788 to come up.

.EXAMPLE
  pwsh Monitor/scripts/monitor-start.ps1 -Restart
#>
[CmdletBinding()]
param(
  [switch]$Restart,
  [switch]$Mock,
  [int]$TimeoutSec = 240
)

$ErrorActionPreference = 'Stop'
$SubRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$subPath1 = ($SubRoot -replace '/', '\')

if ($Restart) {
  Write-Host '[monitor-start] restarting: stopping existing instance first...'
  # Don't let the stop script's exit code (taskkill can return nonzero) abort us.
  & (Join-Path $PSScriptRoot 'monitor-stop.ps1')
  $global:LASTEXITCODE = 0
}

# Refuse to stack a second instance.
$existing = Get-NetTCPConnection -State Listen -LocalPort 7788 -ErrorAction SilentlyContinue
if ($existing -and -not $Restart) {
  Write-Warning "[monitor-start] agent already listening on 7788 (PID $($existing.OwningProcess -join ',')). Use -Restart to replace it."
  return
}

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = (Get-Command npm -ErrorAction Stop).Source }
$out = Join-Path $SubRoot '.codex-current-tauri-dev.log'
$err = Join-Path $SubRoot '.codex-current-tauri-dev.err.log'

$mockLine = if ($Mock) { 'set "GSM_AGENT=--mock"' } else { 'rem (real agent)' }

# Launch FULLY DETACHED in its own console / process group. A child that shares the
# launching shell's console receives that shell's Ctrl+C on exit
# (STATUS_CONTROL_C_EXIT) and dies with it — which is why the dock kept
# "disappearing" when the launching terminal closed. `start` gives it a fresh group.
$wrapper = Join-Path ([System.IO.Path]::GetTempPath()) 'gsm-dock-launch.cmd'
@(
  '@echo off',
  "cd /d `"$SubRoot`"",
  $mockLine,
  "npm run desktop:dev 1>`"$out`" 2>`"$err`""
) | Set-Content -Path $wrapper -Encoding ASCII
Write-Host "[monitor-start] launching 'npm run desktop:dev' (fully detached) in $SubRoot"
# WMI Win32_Process.Create starts the process with NO inherited console, so it
# survives both this script returning AND the launching terminal being closed
# (a console-group child would get CTRL_CLOSE/Ctrl+C and die — STATUS_CONTROL_C_EXIT).
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "cmd.exe /c `"$wrapper`"" }
if ($res.ReturnValue -eq 0) {
  Write-Host "[monitor-start] launched detached (pid $($res.ProcessId)); logs -> $out"
} else {
  Write-Warning "[monitor-start] detached launch failed (WMI ReturnValue=$($res.ReturnValue))"
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$web = $false; $dock = $false; $agent = $false
while ((Get-Date) -lt $deadline) {
  $web   = [bool](Get-NetTCPConnection -State Listen -LocalPort 5180 -ErrorAction SilentlyContinue)
  $agent = [bool](Get-NetTCPConnection -State Listen -LocalPort 7788 -ErrorAction SilentlyContinue)
  $dock  = [bool](Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'app.exe' -and ([string]$_.ExecutablePath) -like "*$subPath1*" })
  if ($web -and $dock -and $agent) { break }
  Start-Sleep -Seconds 3
}
Write-Host ("[monitor-start] web@5180={0}  dock={1}  agent@7788={2}" -f $web, $dock, $agent)
if (-not ($web -and $dock -and $agent)) {
  Write-Warning '[monitor-start] not all components are up yet; tail the logs:'
  Write-Host "  Get-Content '$err' -Tail 20"
}
