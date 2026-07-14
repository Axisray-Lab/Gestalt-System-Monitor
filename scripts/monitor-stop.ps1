#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Stop this checkout's monitor processes and verify that its AppBar was released.

.DESCRIPTION
  CloseMainWindow() is the only script-level path that lets a live Tauri dock send
  ABM_REMOVE. If it returns false or the dock misses the graceful timeout, this
  script does NOT force-kill the dock (directly or through an ancestor); it stops
  and returns a nonzero exit code.

  Process and port cleanup is ownership-safe. A process is killable only when its
  executable/command line names THIS checkout, it matches the recorded launcher
  identity, or it is a descendant of such a process. Process ownership is rebuilt
  from a fresh Win32_Process snapshot on every cleanup round to catch respawns.
  Foreign owners of 7788/5180/5191 are reported and left untouched.

  Finally, every monitor work area is compared with the pre-launch snapshot saved
  by monitor-start.ps1. Legacy sessions without a snapshot use a conservative
  check for a bottom reservation at least as large as DOCK_HEIGHT_PX (320).

.PARAMETER IncludeGames
  Also terminate GameExe when it is provably a descendant of this monitor session.
  Same-named foreign/manual game processes are never swept.

.PARAMETER GameExe
  Game executable leaf name considered when IncludeGames is set.

.PARAMETER Ports
  Well-known ports to report and check for surviving owned listeners.

.PARAMETER LockTimeoutSec
  Maximum time to wait for another start/stop operation on this checkout.

.PARAMETER GracefulTimeoutSec
  Maximum time for each graceful dock close attempt.

.PARAMETER CleanupTimeoutSec
  Maximum time spent refreshing and terminating owned non-dock processes.

.PARAMETER WorkAreaTimeoutSec
  Maximum time to wait for Explorer to restore the saved work areas.
#>
[CmdletBinding()]
param(
  [switch]$IncludeGames,
  [string]$GameExe = 'RobotBridgeDemo.exe',
  [int[]]$Ports = @(7788, 5180, 5191),
  [int]$LockTimeoutSec = 10,
  [int]$GracefulTimeoutSec = 8,
  [int]$CleanupTimeoutSec = 10,
  [int]$WorkAreaTimeoutSec = 6
)

$ErrorActionPreference = 'Stop'
$DockHeightPx = 320
$SubRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $PSCommandPath))).TrimEnd('\', '/')
$DockTargetRoot = Join-Path $SubRoot 'packages\desktop\src-tauri\target'
$StatePath = Join-Path $SubRoot '.codex-monitor-session.local'
$selfPid = $PID
$processQueryFailure = $false
$portQueryFailure = $false
$processQueryWarningShown = $false
$portQueryWarningShown = $false
$stopMutex = $null
$stopMutexHeld = $false
$tcpAuditAvailable = [bool](Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)
if (-not $tcpAuditAvailable) {
  $portQueryFailure = $true
  $portQueryWarningShown = $true
  Write-Warning '[monitor-stop] Get-NetTCPConnection is unavailable; owned-port cleanup cannot be verified.'
}

if ($LockTimeoutSec -lt 0 -or $GracefulTimeoutSec -lt 1 -or $CleanupTimeoutSec -lt 1 -or $WorkAreaTimeoutSec -lt 1) {
  Write-Error '[monitor-stop] LockTimeoutSec must be nonnegative and all other timeout values must be at least 1 second.' -ErrorAction Continue
  exit 64
}

$sha = [System.Security.Cryptography.SHA256]::Create()
try {
  $rootBytes = [System.Text.Encoding]::UTF8.GetBytes($SubRoot.ToLowerInvariant())
  $rootHash = ([System.BitConverter]::ToString($sha.ComputeHash($rootBytes))).Replace('-', '').Substring(0, 16).ToLowerInvariant()
} finally { $sha.Dispose() }
$ExpectedWrapperPath = Join-Path ([System.IO.Path]::GetTempPath()) "gsm-monitor-launch-$rootHash.ps1"

function Close-StopMutex {
  if ($script:stopMutexHeld -and $script:stopMutex) {
    try { $script:stopMutex.ReleaseMutex() } catch { }
    $script:stopMutexHeld = $false
  }
  if ($script:stopMutex) {
    try { $script:stopMutex.Dispose() } catch { }
    $script:stopMutex = $null
  }
}

function Exit-MonitorStop([int]$Code) {
  Close-StopMutex
  exit $Code
}

function Initialize-NativeMonitorApi {
  if ('GsmMonitor.NativeScreens' -as [type]) { return }

  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace GsmMonitor {
  public sealed class MonitorArea {
    public string DeviceName;
    public bool Primary;
    public int BoundsX;
    public int BoundsY;
    public int BoundsWidth;
    public int BoundsHeight;
    public int WorkX;
    public int WorkY;
    public int WorkWidth;
    public int WorkHeight;
  }

  public static class NativeScreens {
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MONITORINFOEX {
      public int cbSize;
      public RECT rcMonitor;
      public RECT rcWork;
      public uint dwFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
      public string szDevice;
    }

    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);

    [DllImport("user32.dll", EntryPoint = "SetThreadDpiAwarenessContext")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    public static MonitorArea[] Snapshot() {
      IntPtr previous = IntPtr.Zero;
      try {
        previous = SetThreadDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
      } catch (EntryPointNotFoundException) { }

      try {
        var result = new List<MonitorArea>();
        MonitorEnumProc callback = delegate(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data) {
          var info = new MONITORINFOEX();
          info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
          if (!GetMonitorInfo(monitor, ref info)) return true;
          result.Add(new MonitorArea {
            DeviceName = info.szDevice,
            Primary = (info.dwFlags & 1) != 0,
            BoundsX = info.rcMonitor.Left,
            BoundsY = info.rcMonitor.Top,
            BoundsWidth = info.rcMonitor.Right - info.rcMonitor.Left,
            BoundsHeight = info.rcMonitor.Bottom - info.rcMonitor.Top,
            WorkX = info.rcWork.Left,
            WorkY = info.rcWork.Top,
            WorkWidth = info.rcWork.Right - info.rcWork.Left,
            WorkHeight = info.rcWork.Bottom - info.rcWork.Top
          });
          return true;
        };
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero)) {
          throw new InvalidOperationException("EnumDisplayMonitors failed.");
        }
        return result.ToArray();
      } finally {
        if (previous != IntPtr.Zero) {
          try { SetThreadDpiAwarenessContext(previous); } catch (EntryPointNotFoundException) { }
        }
      }
    }
  }
}
'@
}

function Get-MonitorAreas {
  Initialize-NativeMonitorApi
  $areas = @([GsmMonitor.NativeScreens]::Snapshot() | ForEach-Object {
    [pscustomobject][ordered]@{
      DeviceName  = [string]$_.DeviceName
      Primary     = [bool]$_.Primary
      BoundsX     = [int]$_.BoundsX
      BoundsY     = [int]$_.BoundsY
      BoundsWidth = [int]$_.BoundsWidth
      BoundsHeight = [int]$_.BoundsHeight
      WorkX       = [int]$_.WorkX
      WorkY       = [int]$_.WorkY
      WorkWidth   = [int]$_.WorkWidth
      WorkHeight  = [int]$_.WorkHeight
    }
  })
  if ($areas.Count -eq 0) { throw 'No monitors were returned by EnumDisplayMonitors.' }
  return $areas
}

function Compare-MonitorAreas($Expected, $Actual) {
  $issues = @()
  $expectedByName = @{}
  foreach ($area in @($Expected)) { $expectedByName[[string]$area.DeviceName] = $area }
  $actualByName = @{}
  foreach ($area in @($Actual)) { $actualByName[[string]$area.DeviceName] = $area }

  foreach ($name in $expectedByName.Keys) {
    if (-not $actualByName.ContainsKey($name)) {
      $issues += "monitor '$name' is no longer present"
      continue
    }
    $before = $expectedByName[$name]
    $after = $actualByName[$name]
    $sameBounds = ([int]$before.BoundsX -eq [int]$after.BoundsX) -and
      ([int]$before.BoundsY -eq [int]$after.BoundsY) -and
      ([int]$before.BoundsWidth -eq [int]$after.BoundsWidth) -and
      ([int]$before.BoundsHeight -eq [int]$after.BoundsHeight)
    $sameWork = ([int]$before.WorkX -eq [int]$after.WorkX) -and
      ([int]$before.WorkY -eq [int]$after.WorkY) -and
      ([int]$before.WorkWidth -eq [int]$after.WorkWidth) -and
      ([int]$before.WorkHeight -eq [int]$after.WorkHeight)
    if (-not $sameBounds) { $issues += "monitor '$name' bounds changed" }
    if (-not $sameWork) {
      $beforeBottom = [int]$before.WorkY + [int]$before.WorkHeight
      $afterBottom = [int]$after.WorkY + [int]$after.WorkHeight
      $bottomDelta = $beforeBottom - $afterBottom
      $issues += "monitor '$name' work area differs (bottom delta $($bottomDelta)px)"
    }
  }
  foreach ($name in $actualByName.Keys) {
    if (-not $expectedByName.ContainsKey($name)) { $issues += "new monitor '$name' is present" }
  }
  return $issues
}

function Get-SuspiciousBottomReservations($Areas) {
  $issues = @()
  foreach ($area in @($Areas)) {
    $boundsBottom = [int]$area.BoundsY + [int]$area.BoundsHeight
    $workBottom = [int]$area.WorkY + [int]$area.WorkHeight
    $reserved = $boundsBottom - $workBottom
    if ($reserved -ge $DockHeightPx) {
      $issues += "monitor '$($area.DeviceName)' still has $($reserved)px reserved at the bottom (dock height is $($DockHeightPx)px)"
    }
  }
  return $issues
}

function Read-SessionState {
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
  $raw = [System.IO.File]::ReadAllText($StatePath, [System.Text.Encoding]::UTF8)
  return ($raw | ConvertFrom-Json)
}

function Test-PathInsideCheckout([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  try { $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/') } catch { return $false }
  if ($full.Equals($SubRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $full.StartsWith($SubRoot + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
    $full.StartsWith($SubRoot + '/', [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-TextContainsCompletePath([string]$Text, [string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Text) -or [string]::IsNullOrWhiteSpace($Path)) { return $false }
  foreach ($candidate in @($Path.Replace('/', '\'), $Path.Replace('\', '/'))) {
    $searchFrom = 0
    while ($searchFrom -lt $Text.Length) {
      $index = $Text.IndexOf($candidate, $searchFrom, [System.StringComparison]::OrdinalIgnoreCase)
      if ($index -lt 0) { break }
      $end = $index + $candidate.Length
      if ($end -eq $Text.Length) { return $true }
      $next = $Text[$end]
      if ([char]::IsWhiteSpace($next) -or $next -eq '\' -or $next -eq '/' -or $next -eq '"' -or $next -eq "'") {
        return $true
      }
      $searchFrom = $index + 1
    }
  }
  return $false
}

function Test-TextContainsCheckout([string]$Text) {
  return (Test-TextContainsCompletePath $Text $SubRoot)
}

function Get-ProcessCreationUtc([object]$Process) {
  if (-not $Process -or -not $Process.CreationDate) { return $null }
  try { return ([datetime]$Process.CreationDate).ToUniversalTime() } catch { return $null }
}

function Get-ProcessIdentity([object]$Process) {
  $created = Get-ProcessCreationUtc $Process
  if ($created) { return $created.ToString('o') }
  return ''
}

function Test-LiveProcessMatchesSnapshot([System.Diagnostics.Process]$LiveProcess, [object]$Snapshot) {
  if (-not $LiveProcess -or -not $Snapshot) { return $false }
  try {
    $expected = Get-ProcessCreationUtc $Snapshot
    $actual = $LiveProcess.StartTime.ToUniversalTime()
    $expectedName = [System.IO.Path]::GetFileNameWithoutExtension([string]$Snapshot.Name)
    return $expected -and ($LiveProcess.ProcessName -ieq $expectedName) -and
      ([math]::Abs(($actual - $expected).TotalMilliseconds) -lt 10)
  } catch { return $false }
}

function Test-IsStateLauncher([object]$Process, [object]$Session) {
  if (-not $Session -or -not $Session.LauncherPid) { return $false }
  if ([int]$Process.ProcessId -ne [int]$Session.LauncherPid) { return $false }
  if ([string]::IsNullOrWhiteSpace([string]$Session.LauncherCreationUtc)) { return $false }
  try {
    $expected = ([datetime]$Session.LauncherCreationUtc).ToUniversalTime()
    $actual = Get-ProcessCreationUtc $Process
    return $actual -and ([math]::Abs(($actual - $expected).TotalMilliseconds) -lt 10)
  } catch { return $false }
}

function Test-IsDirectlyOwnedProcess([object]$Process, [object]$Session) {
  if (-not $Process -or [int]$Process.ProcessId -eq $selfPid) { return $false }
  if (Test-PathInsideCheckout ([string]$Process.ExecutablePath)) { return $true }
  if ($Session -and -not [string]::IsNullOrWhiteSpace([string]$Session.WrapperPath)) {
    if (Test-TextContainsCompletePath ([string]$Process.CommandLine) ([string]$Session.WrapperPath)) {
      return $true
    }
  }
  if (Test-IsStateLauncher $Process $Session) { return $true }
  if (Test-TextContainsCheckout ([string]$Process.CommandLine)) {
    $name = ([string]$Process.Name).ToLowerInvariant()
    if ($name -eq 'node.exe' -or $name -like 'cargo*.exe' -or $name -like 'rust*.exe') {
      return $true
    }
  }
  return $false
}

function Get-ProcessSnapshot {
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    $script:processQueryFailure = $true
    if (-not $script:processQueryWarningShown) {
      Write-Warning "[monitor-stop] Win32_Process audit failed: $($_.Exception.Message)"
      $script:processQueryWarningShown = $true
    }
    return @()
  }
}

function Get-OwnedProcessMap($Processes, $Session, $KnownOwned) {
  $owned = @{}
  $byId = @{}
  foreach ($process in @($Processes)) { $byId[[int]$process.ProcessId] = $process }
  foreach ($process in @($Processes)) {
    $pidValue = [int]$process.ProcessId
    if (Test-IsDirectlyOwnedProcess $process $Session) {
      $owned[$pidValue] = $true
      continue
    }
    if ($KnownOwned -and $KnownOwned.ContainsKey($pidValue)) {
      $knownIdentity = [string]$KnownOwned[$pidValue]
      if ($knownIdentity -and $knownIdentity -eq (Get-ProcessIdentity $process)) { $owned[$pidValue] = $true }
    }
  }
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in @($Processes)) {
      $pidValue = [int]$process.ProcessId
      $parentPid = [int]$process.ParentProcessId
      $parent = $byId[$parentPid]
      $childCreated = Get-ProcessCreationUtc $process
      $parentCreated = Get-ProcessCreationUtc $parent
      $validAncestry = $parent -and $childCreated -and $parentCreated -and
        (($childCreated - $parentCreated).TotalMilliseconds -ge -10)
      if (-not $owned.ContainsKey($pidValue) -and $owned.ContainsKey($parentPid) -and $validAncestry) {
        $owned[$pidValue] = $true
        $changed = $true
      }
    }
  }
  return $owned
}

function Update-KnownOwned($Processes, $Owned, $KnownOwned) {
  foreach ($process in @($Processes)) {
    $pidValue = [int]$process.ProcessId
    if ($Owned.ContainsKey($pidValue)) {
      $identity = Get-ProcessIdentity $process
      if ($identity) { $KnownOwned[$pidValue] = $identity }
    }
  }
}

function Get-AncestorMap($Processes) {
  $byId = @{}
  foreach ($process in @($Processes)) { $byId[[int]$process.ProcessId] = $process }
  $ancestors = @{ $selfPid = $true }
  $cursor = $byId[$selfPid]
  while ($cursor -and [int]$cursor.ParentProcessId -ne 0) {
    $parentPid = [int]$cursor.ParentProcessId
    $ancestors[$parentPid] = $true
    $cursor = $byId[$parentPid]
  }
  return $ancestors
}

function Test-IsExpectedDockProcess([object]$Process) {
  if (-not $Process -or $Process.Name -ine 'app.exe' -or ([string]$Process.CommandLine) -like '*--appbar-watchdog*') {
    return $false
  }
  if (-not (Test-PathInsideCheckout ([string]$Process.ExecutablePath))) { return $false }
  try {
    $exe = [System.IO.Path]::GetFullPath([string]$Process.ExecutablePath)
    $target = [System.IO.Path]::GetFullPath($DockTargetRoot).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    return $exe.StartsWith($target, [System.StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

function Get-CheckoutDocks($Processes, $Owned) {
  return @($Processes | Where-Object {
    $Owned.ContainsKey([int]$_.ProcessId) -and (Test-IsExpectedDockProcess $_)
  })
}

function Close-DocksGracefully($Docks) {
  $requested = @()
  foreach ($dock in @($Docks)) {
    try {
      $process = Get-Process -Id ([int]$dock.ProcessId) -ErrorAction Stop
      if (-not (Test-LiveProcessMatchesSnapshot $process $dock)) {
        Write-Warning "[monitor-stop] dock PID $($dock.ProcessId) changed identity after the CIM snapshot; the replacement process was left untouched."
        continue
      }
      $closed = $process.CloseMainWindow()
      Write-Host "[monitor-stop] dock PID $($dock.ProcessId): CloseMainWindow -> $closed"
      if (-not $closed) {
        Write-Warning "[monitor-stop] dock PID $($dock.ProcessId) rejected CloseMainWindow; it will NOT be force-killed."
        return $false
      }
      $requested += $dock
    } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
      # It exited between the CIM snapshot and Get-Process.
    } catch {
      Write-Warning "[monitor-stop] dock PID $($dock.ProcessId) graceful close failed: $($_.Exception.Message)"
      return $false
    }
  }

  $deadline = (Get-Date).AddSeconds($GracefulTimeoutSec)
  do {
    $alive = @()
    foreach ($requestedDock in $requested) {
      $live = Get-Process -Id ([int]$requestedDock.ProcessId) -ErrorAction SilentlyContinue
      if ($live -and (Test-LiveProcessMatchesSnapshot $live $requestedDock)) { $alive += $requestedDock }
    }
    if ($alive.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)

  Write-Warning "[monitor-stop] graceful dock close timed out; still alive: $($alive.ProcessId -join ','). No force kill was attempted."
  return $false
}

function Get-ListeningConnectionsSnapshot {
  if (-not $script:tcpAuditAvailable) { return @() }
  $netErrors = @()
  $connections = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue -ErrorVariable netErrors)
  $unexpected = @($netErrors | Where-Object { $_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*' })
  if ($unexpected.Count -gt 0) {
    $script:portQueryFailure = $true
    if (-not $script:portQueryWarningShown) {
      Write-Warning "[monitor-stop] TCP listener audit failed: $($unexpected[0].Exception.Message)"
      $script:portQueryWarningShown = $true
    }
    return @()
  }
  return $connections
}

function Get-PortRecords([int]$Port, $Processes, $Owned, $Connections) {
  $byId = @{}
  foreach ($process in @($Processes)) { $byId[[int]$process.ProcessId] = $process }
  $seen = @{}
  $records = @()
  foreach ($connection in @($Connections | Where-Object { [int]$_.LocalPort -eq $Port })) {
    $ownerPid = [int]$connection.OwningProcess
    if ($seen.ContainsKey($ownerPid)) { continue }
    $seen[$ownerPid] = $true
    $process = $byId[$ownerPid]
    $records += [pscustomobject]@{
      Port = $Port
      Pid = $ownerPid
      Name = if ($process) { [string]$process.Name } else { '<unknown>' }
      ProcessKnown = [bool]$process
      Owned = $Owned.ContainsKey($ownerPid)
    }
  }
  return $records
}

function Test-SafeWrapperPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  try {
    $full = [System.IO.Path]::GetFullPath($Path)
    $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $expected = [System.IO.Path]::GetFullPath($ExpectedWrapperPath)
    return $full.StartsWith($temp, [System.StringComparison]::OrdinalIgnoreCase) -and
      $full.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

$mutexName = "Local\GestaltSystemMonitorLifecycle-$rootHash"
try {
  $stopMutex = New-Object System.Threading.Mutex -ArgumentList $false, $mutexName
  try {
    $stopMutexHeld = $stopMutex.WaitOne([TimeSpan]::FromSeconds($LockTimeoutSec))
  } catch [System.Threading.AbandonedMutexException] {
    $stopMutexHeld = $true
  }
} catch {
  Write-Error "[monitor-stop] cannot create the checkout lifecycle mutex: $($_.Exception.Message)" -ErrorAction Continue
  Exit-MonitorStop 8
}
if (-not $stopMutexHeld) {
  Write-Error "[monitor-stop] another start/stop operation still owns the checkout lifecycle lock after ${LockTimeoutSec}s." -ErrorAction Continue
  Exit-MonitorStop 8
}

try {
Write-Host "[monitor-stop] checkout root: $SubRoot"
$state = $null
$stateFailure = $false
if (Test-Path -LiteralPath $StatePath -PathType Leaf) {
  try {
    $state = Read-SessionState
    if (-not ([string]$state.CheckoutRoot).Equals($SubRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'session state belongs to a different checkout'
    }
    if (([int]$state.Schema -ne 1) -or ([int]$state.DockHeightPx -ne $DockHeightPx) -or
        -not $state.WorkAreas -or -not (Test-SafeWrapperPath ([string]$state.WrapperPath))) {
      throw 'session state is incomplete or has an unsupported schema'
    }
  } catch {
    $stateFailure = $true
    Write-Warning "[monitor-stop] cannot trust saved session state: $($_.Exception.Message)"
    $state = $null
  }
}

$knownOwned = @{}
$processes = @(Get-ProcessSnapshot)
$owned = Get-OwnedProcessMap $processes $state $knownOwned
Update-KnownOwned $processes $owned $knownOwned
$docks = @(Get-CheckoutDocks $processes $owned)
$dockCloseFailed = $false
if ($docks.Count -eq 0) {
  Write-Warning '[monitor-stop] no live checkout dock was found; AppBar release will be decided by work-area verification, not by process absence.'
} elseif (-not (Close-DocksGracefully $docks)) {
  $dockCloseFailed = $true
}

if ($dockCloseFailed) {
  Write-Warning '[monitor-stop] skipping all force cleanup because it could indirectly terminate a dock before ABM_REMOVE.'
} else {
  $cleanupDeadline = (Get-Date).AddSeconds($CleanupTimeoutSec)
  $quietRounds = 0
  $quietRoundsRequired = 3
  $cleanupAuditRounds = 0
  do {
    $cleanupAuditRounds++
    # Refresh on every round so a supervisor respawn cannot escape the ownership set.
    $processes = @(Get-ProcessSnapshot)
    $owned = Get-OwnedProcessMap $processes $state $knownOwned
    Update-KnownOwned $processes $owned $knownOwned

    $respawnedDocks = @(Get-CheckoutDocks $processes $owned)
    if ($respawnedDocks.Count -gt 0) {
      $quietRounds = 0
      Write-Warning "[monitor-stop] detected a respawned dock (PID $($respawnedDocks.ProcessId -join ',')); closing it gracefully."
      if (-not (Close-DocksGracefully $respawnedDocks)) {
        $dockCloseFailed = $true
        break
      }
      continue
    }

    $ancestors = Get-AncestorMap $processes
    $victims = @($processes | Where-Object {
      $pidValue = [int]$_.ProcessId
      $isOwned = $owned.ContainsKey($pidValue)
      $isProtected = $ancestors.ContainsKey($pidValue)
      $isDock = $_.Name -ieq 'app.exe' -and $isOwned
      $isExcludedGame = (-not $IncludeGames) -and ($_.Name -ieq $GameExe)
      $isOwned -and -not $isProtected -and -not $isDock -and -not $isExcludedGame
    })
    if ($victims.Count -gt 0) {
      $quietRounds = 0
      Write-Host "[monitor-stop] terminating owned non-dock PIDs: $((@($victims.ProcessId | Sort-Object) -join ','))"
      foreach ($victim in $victims) {
        try {
          $live = Get-Process -Id ([int]$victim.ProcessId) -ErrorAction Stop
          if (-not (Test-LiveProcessMatchesSnapshot $live $victim)) {
            Write-Warning "[monitor-stop] PID $($victim.ProcessId) changed identity after refresh; replacement was left untouched."
            continue
          }
          $live.Kill()
        } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
          # It exited between refresh and termination.
        } catch {
          Write-Warning "[monitor-stop] failed to terminate owned PID $($victim.ProcessId): $($_.Exception.Message)"
        }
      }
      Start-Sleep -Milliseconds 350
      continue
    }

    # Do not force-kill app.exe helpers. The AppBar watchdog/broker must get a
    # chance to observe owner death, remove the lease, and exit on its own.
    $lingeringOwned = @($processes | Where-Object {
      $pidValue = [int]$_.ProcessId
      $isExcludedGame = (-not $IncludeGames) -and ($_.Name -ieq $GameExe)
      $owned.ContainsKey($pidValue) -and -not $ancestors.ContainsKey($pidValue) -and -not $isExcludedGame
    })
    $ownedPortsThisRound = @()
    $unknownPortsThisRound = @()
    $listenerSnapshot = @(Get-ListeningConnectionsSnapshot)
    foreach ($port in $Ports) {
      foreach ($record in @(Get-PortRecords $port $processes $owned $listenerSnapshot)) {
        if ($record.Owned) { $ownedPortsThisRound += $record }
        elseif (-not $record.ProcessKnown) { $unknownPortsThisRound += $record }
      }
    }

    if ($lingeringOwned.Count -eq 0 -and $ownedPortsThisRound.Count -eq 0 -and $unknownPortsThisRound.Count -eq 0) {
      $quietRounds++
      if ($quietRounds -ge $quietRoundsRequired) { break }
    } else {
      $quietRounds = 0
    }
    Start-Sleep -Milliseconds 350
  } while ((Get-Date) -lt $cleanupDeadline -or $cleanupAuditRounds -lt $quietRoundsRequired)
}

# A manual game with the same leaf name is not proof of ownership.
if ($IncludeGames) {
  $latest = @(Get-ProcessSnapshot)
  $latestOwned = Get-OwnedProcessMap $latest $state $knownOwned
  $foreignGames = @($latest | Where-Object { $_.Name -ieq $GameExe -and -not $latestOwned.ContainsKey([int]$_.ProcessId) })
  if ($foreignGames.Count -gt 0) {
    Write-Warning "[monitor-stop] leaving unproven/foreign $GameExe processes untouched (PID $($foreignGames.ProcessId -join ','))."
  }
}

$workspaceFailure = $false
$currentAreas = $null
$workAreaIssues = @()
$survivors = @()
$ownedPortRecords = @()
$unknownPortRecords = @()
$allPortRecords = @()
$finalCleanRounds = 0
$finalCleanRoundsRequired = 3
$finalAuditRounds = 0
$finalAuditDeadline = (Get-Date).AddSeconds($WorkAreaTimeoutSec)
do {
  $finalAuditRounds++
  # One final audit round uses one fresh process snapshot for both ownership and
  # port classification, then checks the work area. Three consecutive clean
  # rounds close the remaining exit/respawn/watchdog races.
  $processes = @(Get-ProcessSnapshot)
  $owned = Get-OwnedProcessMap $processes $state $knownOwned
  Update-KnownOwned $processes $owned $knownOwned
  $ancestors = Get-AncestorMap $processes
  $survivors = @($processes | Where-Object {
    $pidValue = [int]$_.ProcessId
    $isExcludedGame = (-not $IncludeGames) -and ($_.Name -ieq $GameExe)
    $owned.ContainsKey($pidValue) -and -not $ancestors.ContainsKey($pidValue) -and -not $isExcludedGame
  })

  $ownedPortRecords = @()
  $unknownPortRecords = @()
  $allPortRecords = @()
  $listenerSnapshot = @(Get-ListeningConnectionsSnapshot)
  foreach ($port in $Ports) {
    $records = @(Get-PortRecords $port $processes $owned $listenerSnapshot)
    $allPortRecords += $records
    $ownedPortRecords += @($records | Where-Object { $_.Owned })
    $unknownPortRecords += @($records | Where-Object { -not $_.Owned -and -not $_.ProcessKnown })
  }

  try {
    $currentAreas = @(Get-MonitorAreas)
    if ($state -and $state.WorkAreas) {
      $workAreaIssues = @(Compare-MonitorAreas @($state.WorkAreas) $currentAreas)
    } else {
      $workAreaIssues = @(Get-SuspiciousBottomReservations $currentAreas)
    }
  } catch {
    $workAreaIssues = @("monitor work-area query failed: $($_.Exception.Message)")
  }

  $roundClean = ($survivors.Count -eq 0) -and ($ownedPortRecords.Count -eq 0) -and
    ($unknownPortRecords.Count -eq 0) -and ($workAreaIssues.Count -eq 0) -and
    (-not $processQueryFailure) -and (-not $portQueryFailure)
  if ($roundClean) {
    $finalCleanRounds++
    if ($finalCleanRounds -ge $finalCleanRoundsRequired) { break }
  } else {
    $finalCleanRounds = 0
  }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $finalAuditDeadline -or $finalAuditRounds -lt $finalCleanRoundsRequired)

if ($survivors.Count -gt 0) {
  $survivorLabels = @($survivors | ForEach-Object { "$($_.ProcessId):$($_.Name)" })
  Write-Warning "[monitor-stop] owned survivors: $($survivorLabels -join ', ')"
} elseif ($processQueryFailure) {
  Write-Warning '[monitor-stop] owned process survivors could not be verified because the process audit failed.'
} else {
  Write-Host '[monitor-stop] no owned monitor-process survivors.'
}

if ($unknownPortRecords.Count -gt 0) {
  $portQueryFailure = $true
  Write-Warning "[monitor-stop] listener owners changed during the final snapshot (PID $($unknownPortRecords.Pid -join ',')); refusing to call them foreign."
}
foreach ($port in $Ports) {
  $records = @($allPortRecords | Where-Object { $_.Port -eq $port })
  if ($records.Count -eq 0) {
    if ($portQueryFailure) { Write-Warning "[monitor-stop] port $($port): unverifiable" }
    else { Write-Host "[monitor-stop] port $($port): free" }
    continue
  }
  foreach ($record in $records) {
    if ($record.Owned) { $kind = 'OWNED survivor' }
    elseif (-not $record.ProcessKnown) { $kind = 'unresolved owner (verification failed)' }
    else { $kind = 'foreign (left untouched)' }
    Write-Host "[monitor-stop] port $($port): PID $($record.Pid) $($record.Name) [$kind]"
  }
}

if ($workAreaIssues.Count -gt 0) {
  $workspaceFailure = $true
  foreach ($issue in $workAreaIssues) { Write-Warning "[monitor-stop] work area not released: $issue" }
} elseif ($state -and $state.WorkAreas) {
  Write-Host '[monitor-stop] every monitor work area matches the pre-launch snapshot.'
} else {
  Write-Warning '[monitor-stop] no pre-launch snapshot was available; the 320px stale-reservation check passed, but exact restoration cannot be proven.'
}

$quiescenceFailure = $finalCleanRounds -lt $finalCleanRoundsRequired
if ($quiescenceFailure) {
  Write-Warning "[monitor-stop] final state did not remain clean for three consecutive audit rounds (rounds=$finalAuditRounds, cleanTail=$finalCleanRounds, survivors=$($survivors.Count), ownedPorts=$($ownedPortRecords.Count), unknownPorts=$($unknownPortRecords.Count), workAreaIssues=$($workAreaIssues.Count))."
}

$failed = $dockCloseFailed -or $stateFailure -or $workspaceFailure -or $quiescenceFailure -or $processQueryFailure -or $portQueryFailure -or
  ($survivors.Count -gt 0) -or ($ownedPortRecords.Count -gt 0)

if ($failed) {
  Write-Error '[monitor-stop] FAILED: one or more owned resources remain or AppBar release could not be verified.' -ErrorAction Continue
  Exit-MonitorStop 1
}

if ($state -and (Test-SafeWrapperPath ([string]$state.WrapperPath))) {
  Remove-Item -LiteralPath ([string]$state.WrapperPath) -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
Write-Host '[monitor-stop] done; owned processes, owned ports, and work areas are clean.'
Exit-MonitorStop 0
} finally {
  # Prevent a failed audit or pipeline interruption from wedging future lifecycle
  # operations. start -Restart re-enters this mutex on the same thread safely.
  Close-StopMutex
}
