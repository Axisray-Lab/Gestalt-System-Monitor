#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Gracefully stop the Gestalt-System-Monitor desktop dock and release ALL resources.

.DESCRIPTION
  The dock is a Windows AppBar that RESERVES a strip of the desktop work area
  (SHAppBarMessage ABM_NEW). That reservation, plus the auto-spawned discovery
  agent (and any game it launched), only release on a *graceful* shutdown — a hard
  `taskkill /F` on the dock skips the AppBar `ABM_REMOVE` and orphans the agent +
  game windows. This is the "killed the game but Windows didn't free the window"
  symptom.

  This script does it the right way, in order:
    1. CloseMainWindow() on the dock app.exe  -> fires WindowEvent::CloseRequested
       -> appbar::remove() releases the reserved screen edge.
    2. Tree-kill every remaining process that belongs to THIS submodule
       (web dev server, vite/esbuild, tsx, the node agent, tauri/cargo, app.exe),
       walking descendants AND npm wrappers.
    3. Free the well-known ports (7788 agent, 5180/5191 web).
    4. (-IncludeGames) optionally sweep launched standalone game windows
       (RobotBridgeDemo.exe) that were orphaned by an earlier hard kill.

  It deliberately LEAVES unrelated checkouts alone (a separate
  Documents\Gestalt-System-Monitor clone, or secundus).

.PARAMETER IncludeGames
  Also kill RobotBridgeDemo.exe processes (the launched standalone). Off by default
  so a manually-run editor/game session is not collateral.

.PARAMETER GameExe
  Game executable leaf name to sweep when -IncludeGames is set. Default RobotBridgeDemo.exe.

.EXAMPLE
  pwsh Monitor/scripts/monitor-stop.ps1
.EXAMPLE
  pwsh Monitor/scripts/monitor-stop.ps1 -IncludeGames
#>
[CmdletBinding()]
param(
  [switch]$IncludeGames,
  [string]$GameExe = 'RobotBridgeDemo.exe',
  [int[]]$Ports = @(7788, 5180, 5191)
)

$ErrorActionPreference = 'SilentlyContinue'

# This script lives in <submodule>/scripts; the submodule root is its parent's parent.
$SubRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$subPath1 = ($SubRoot -replace '/', '\')
$subPath2 = ($SubRoot -replace '\\', '/')
$self = $PID

Write-Host "[monitor-stop] submodule root: $SubRoot"

$all = Get-CimInstance Win32_Process
$byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }

function Belongs($p) {
  if (-not $p) { return $false }
  $cmd = [string]$p.CommandLine
  $exe = [string]$p.ExecutablePath
  if ($cmd -like "*$subPath1*" -or $cmd -like "*$subPath2*" -or $cmd -like '*@gsm/*') { return $true }
  if ($exe -like "*$subPath1*") { return $true }
  return $false
}

# 1) Graceful close of the dock app.exe -> releases the AppBar reservation.
$docks = $all | Where-Object { $_.Name -eq 'app.exe' -and ([string]$_.ExecutablePath) -like "*$subPath1*" }
foreach ($d in $docks) {
  $proc = Get-Process -Id $d.ProcessId -ErrorAction SilentlyContinue
  if ($proc) {
    $closed = $proc.CloseMainWindow()
    Write-Host "[monitor-stop] dock PID $($d.ProcessId): CloseMainWindow -> $closed"
  }
}
# Give the graceful close + appbar::remove a moment to run.
$deadline = (Get-Date).AddSeconds(4)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id ($docks.ProcessId) -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}
$dockAlive = (Get-Process -Id ($docks.ProcessId) -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host "[monitor-stop] dock alive after graceful close: $dockAlive (0 = AppBar released cleanly)"

# 2) Build the kill set: belonging processes + descendants + npm-wrapper ancestors.
$set = @{}
foreach ($p in $all) { if (Belongs $p) { $set[[int]$p.ProcessId] = $true } }

$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    if (-not $set.ContainsKey([int]$p.ProcessId) -and $set.ContainsKey([int]$p.ParentProcessId)) {
      $set[[int]$p.ProcessId] = $true; $changed = $true
    }
  }
}
foreach ($seedPid in @($set.Keys)) {
  $cur = $byId[[int]$seedPid]
  while ($cur -and $cur.ParentProcessId) {
    $parent = $byId[[int]$cur.ParentProcessId]
    if (-not $parent) { break }
    $pcmd = [string]$parent.CommandLine
    $isNpmWrapper = ($parent.Name -eq 'node.exe' -and ($pcmd -like '*npm-cli.js*' -or $pcmd -like '*@gsm/*' -or $pcmd -like '*desktop:dev*')) -or
                    ($parent.Name -eq 'npm.cmd') -or ($parent.Name -eq 'cmd.exe' -and ($pcmd -like '*@gsm/*' -or $pcmd -like '*tauri dev*' -or $pcmd -like '*run agent*'))
    if ($isNpmWrapper) { $set[[int]$parent.ProcessId] = $true; $cur = $parent } else { break }
  }
}
$set.Remove($self) | Out-Null

# 3) Add port owners (catches an orphaned agent from a prior hard kill).
foreach ($port in $Ports) {
  foreach ($c in (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
    if ($c.OwningProcess -and $c.OwningProcess -ne $self) { $set[[int]$c.OwningProcess] = $true }
  }
}

# 4) Optionally sweep launched game windows.
if ($IncludeGames) {
  foreach ($g in ($all | Where-Object { $_.Name -eq $GameExe })) { $set[[int]$g.ProcessId] = $true }
}

# Never kill this script's own process or its ancestor chain (a tree-kill /T on an
# ancestor would take down the pwsh running this script).
$ancestors = @{ $self = $true }
$cur = $byId[[int]$self]
while ($cur -and $cur.ParentProcessId) {
  $ancestors[[int]$cur.ParentProcessId] = $true
  $cur = $byId[[int]$cur.ParentProcessId]
}

$victims = $set.Keys | Where-Object {
  $p = $byId[[int]$_]
  $cmd = if ($p) { [string]$p.CommandLine } else { '' }
  (-not $ancestors.ContainsKey([int]$_)) -and
  $cmd -notlike '*Documents\Gestalt-System-Monitor*' -and $cmd -notlike '*secundus*'
}

if (-not $victims) {
  Write-Host '[monitor-stop] nothing left to kill.'
} else {
  Write-Host "[monitor-stop] tree-killing PIDs: $((($victims | Sort-Object) -join ', '))"
  foreach ($v in $victims) { & taskkill /PID $v /T /F 2>$null | Out-Null }
}

# Processes (esbuild/vite children) can take a moment to fully exit after taskkill;
# retry briefly so the report doesn't falsely warn about still-dying processes.
$survivors = @()
for ($i = 0; $i -lt 8; $i++) {
  Start-Sleep -Milliseconds 500
  $survivors = Get-CimInstance Win32_Process | Where-Object { (Belongs $_) -and $_.ProcessId -ne $self }
  if (-not $survivors) { break }
}
if ($survivors) {
  Write-Warning "[monitor-stop] survivors (still exiting?): $((($survivors.ProcessId) -join ', '))"
} else {
  Write-Host '[monitor-stop] no submodule survivors.'
}
foreach ($port in $Ports) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  Write-Host ("[monitor-stop] port {0}: {1}" -f $port, ($(if ($c) { 'PID ' + ($c.OwningProcess -join ',') } else { 'free' })))
}
Write-Host '[monitor-stop] done.'
# taskkill against an already-gone PID returns a nonzero $LASTEXITCODE; don't let
# that surface as a script failure to callers (e.g. monitor-start.ps1 -Restart).
exit 0
