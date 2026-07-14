#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Start the Gestalt-System-Monitor desktop dock cleanly and detached.

.DESCRIPTION
  Takes a native-pixel snapshot of every monitor's work area before launch and
  stores it in .codex-monitor-session.local. monitor-stop.ps1 uses that baseline
  to prove that the AppBar reservation was actually released.

  A listener on 7788 is not, by itself, evidence that the dock is running. This
  script only refuses to stack another dock when app.exe from THIS checkout is
  alive. A compatible existing agent can therefore be adopted during dock crash
  recovery. Port ownership is reported and a foreign web server on 5180 is
  rejected because the Tauri dev URL would otherwise load the wrong application.

.PARAMETER Restart
  Run monitor-stop.ps1 first. A failed stop aborts the restart.

.PARAMETER Mock
  Start the agent against the built-in fake LAN.

.PARAMETER TimeoutSec
  Maximum time to wait for this checkout's web server and dock plus a compatible
  agent on 7788. A timeout is an error and returns a nonzero exit code.
#>
[CmdletBinding()]
param(
  [switch]$Restart,
  [switch]$Mock,
  [int]$TimeoutSec = 240
)

$ErrorActionPreference = 'Stop'
$DockHeightPx = 320
$SubRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $PSCommandPath))).TrimEnd('\', '/')
$DockTargetRoot = Join-Path $SubRoot 'packages\desktop\src-tauri\target'
$StatePath = Join-Path $SubRoot '.codex-monitor-session.local'
$selfPid = $PID
$startMutex = $null
$startMutexHeld = $false

if ($TimeoutSec -lt 1) {
  Write-Error '[monitor-start] TimeoutSec must be at least 1.' -ErrorAction Continue
  exit 64
}

$sha = [System.Security.Cryptography.SHA256]::Create()
try {
  $rootBytes = [System.Text.Encoding]::UTF8.GetBytes($SubRoot.ToLowerInvariant())
  $rootHash = ([System.BitConverter]::ToString($sha.ComputeHash($rootBytes))).Replace('-', '').Substring(0, 16).ToLowerInvariant()
} finally { $sha.Dispose() }
$ExpectedWrapperPath = Join-Path ([System.IO.Path]::GetTempPath()) "gsm-monitor-launch-$rootHash.ps1"

function Close-StartMutex {
  if ($script:startMutexHeld -and $script:startMutex) {
    try { $script:startMutex.ReleaseMutex() } catch { }
    $script:startMutexHeld = $false
  }
  if ($script:startMutex) {
    try { $script:startMutex.Dispose() } catch { }
    $script:startMutex = $null
  }
}

function Exit-MonitorStart([int]$Code) {
  Close-StartMutex
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
      $issues += "monitor '$name' work area differs (bottom delta ${bottomDelta}px)"
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
      $issues += "monitor '$($area.DeviceName)' has ${reserved}px reserved at the bottom (dock height is ${DockHeightPx}px)"
    }
  }
  return $issues
}

function Read-SessionState {
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
  try {
    $raw = [System.IO.File]::ReadAllText($StatePath, [System.Text.Encoding]::UTF8)
    return ($raw | ConvertFrom-Json)
  } catch {
    throw "Cannot read session state '$StatePath': $($_.Exception.Message)"
  }
}

function Write-SessionState($State) {
  $json = $State | ConvertTo-Json -Depth 8
  $temporary = Join-Path $SubRoot ".codex-monitor-session-$PID.local"
  $utf8Bom = New-Object System.Text.UTF8Encoding -ArgumentList $true
  [System.IO.File]::WriteAllText($temporary, $json, $utf8Bom)
  Move-Item -LiteralPath $temporary -Destination $StatePath -Force
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
  return @(Get-CimInstance Win32_Process -ErrorAction Stop)
}

function Get-OwnedProcessMap($Processes, $Session) {
  $owned = @{}
  $byId = @{}
  foreach ($process in @($Processes)) { $byId[[int]$process.ProcessId] = $process }
  foreach ($process in @($Processes)) {
    if (Test-IsDirectlyOwnedProcess $process $Session) { $owned[[int]$process.ProcessId] = $true }
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

function Get-ListeningConnectionsSnapshot {
  $netErrors = @()
  $connections = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue -ErrorVariable netErrors)
  $unexpected = @($netErrors | Where-Object { $_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*' })
  if ($unexpected.Count -gt 0) { throw "Get-NetTCPConnection failed: $($unexpected[0].Exception.Message)" }
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

function Test-CompatibleAgent {
  try {
    $response = Invoke-WebRequest -Uri 'http://localhost:7788/launcher' -UseBasicParsing -TimeoutSec 2
    $content = [string]$response.Content
    return ($content -match '"kind"\s*:\s*"launcherStatus"') -and
      ($content -match '"autoSave"\s*:') -and ($content -match '"batches"\s*:')
  } catch { return $false }
}

$mutexName = "Local\GestaltSystemMonitorLifecycle-$rootHash"
try {
  $startMutex = New-Object System.Threading.Mutex -ArgumentList $false, $mutexName
  try {
    $startMutexHeld = $startMutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $startMutexHeld = $true
  }
} catch {
  Write-Error "[monitor-start] cannot create the checkout launch mutex: $($_.Exception.Message)" -ErrorAction Continue
  Exit-MonitorStart 8
}
if (-not $startMutexHeld) {
  $startMutex.Dispose()
  $startMutex = $null
  Write-Error '[monitor-start] another start/restart for this checkout is already in progress.' -ErrorAction Continue
  Exit-MonitorStart 8
}

try {
if ($Restart) {
  Write-Host '[monitor-start] restarting: stopping existing instance first...'
  & (Join-Path $PSScriptRoot 'monitor-stop.ps1')
  $stopExitCode = $LASTEXITCODE
  if ($stopExitCode -ne 0) {
    Write-Error "[monitor-start] restart aborted because monitor-stop.ps1 failed (exit $stopExitCode)." -ErrorAction Continue
    Exit-MonitorStart $stopExitCode
  }
}

$priorState = $null
try { $priorState = Read-SessionState } catch {
  Write-Error "[monitor-start] $($_.Exception.Message) Refusing to overwrite the only work-area baseline." -ErrorAction Continue
  Exit-MonitorStart 3
}
if ($priorState -and -not ([string]$priorState.CheckoutRoot).Equals($SubRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  Write-Error '[monitor-start] session state belongs to a different checkout; refusing to overwrite it.' -ErrorAction Continue
  Exit-MonitorStart 3
}
if ($priorState -and (([int]$priorState.Schema -ne 1) -or ([int]$priorState.DockHeightPx -ne $DockHeightPx) -or
    -not $priorState.WorkAreas -or -not (Test-SafeWrapperPath ([string]$priorState.WrapperPath)))) {
  Write-Error '[monitor-start] session state is incomplete or has an unsupported schema; refusing to trust or overwrite it.' -ErrorAction Continue
  Exit-MonitorStart 3
}

try {
  Get-Command Get-NetTCPConnection -ErrorAction Stop | Out-Null
  $processes = @(Get-ProcessSnapshot)
} catch {
  Write-Error "[monitor-start] cannot audit existing processes/ports: $($_.Exception.Message)" -ErrorAction Continue
  Exit-MonitorStart 5
}
$owned = Get-OwnedProcessMap $processes $priorState
$docks = @(Get-CheckoutDocks $processes $owned)
if ($docks.Count -gt 0) {
  Write-Error "[monitor-start] this checkout already has a dock (PID $($docks.ProcessId -join ',')). Use -Restart for a verified clean restart." -ErrorAction Continue
  Exit-MonitorStart 2
}

try { $baseline = @(Get-MonitorAreas) } catch {
  Write-Error "[monitor-start] cannot snapshot monitor work areas: $($_.Exception.Message)" -ErrorAction Continue
  Exit-MonitorStart 4
}

if ($priorState -and $priorState.WorkAreas) {
  $priorIssues = @(Compare-MonitorAreas @($priorState.WorkAreas) $baseline)
  if ($priorIssues.Count -gt 0) {
    foreach ($issue in $priorIssues) { Write-Warning "[monitor-start] unreleased/changed work area: $issue" }
    Write-Error '[monitor-start] refusing to stack a new AppBar on a work area that has not returned to the saved baseline.' -ErrorAction Continue
    Exit-MonitorStart 4
  }
}
$suspicious = @(Get-SuspiciousBottomReservations $baseline)
if ($suspicious.Count -gt 0) {
  foreach ($issue in $suspicious) { Write-Warning "[monitor-start] $issue" }
  Write-Error '[monitor-start] possible stale 320px AppBar reservation detected; repair the desktop work area before starting.' -ErrorAction Continue
  Exit-MonitorStart 4
}

try { $listenerSnapshot = @(Get-ListeningConnectionsSnapshot) } catch {
  Write-Error "[monitor-start] cannot audit existing TCP listeners: $($_.Exception.Message)" -ErrorAction Continue
  Exit-MonitorStart 5
}
$webRecords = @(Get-PortRecords 5180 $processes $owned $listenerSnapshot)
$foreignWeb = @($webRecords | Where-Object { -not $_.Owned })
if ($foreignWeb.Count -gt 0) {
  Write-Error "[monitor-start] web port 5180 is owned by a foreign process (PID $($foreignWeb.Pid -join ',')). The dock would load the wrong dev server." -ErrorAction Continue
  Exit-MonitorStart 5
}
if ($webRecords.Count -gt 0) {
  Write-Warning "[monitor-start] reusing this checkout's existing web listener on 5180 (PID $($webRecords.Pid -join ','))."
}

$agentRecords = @(Get-PortRecords 7788 $processes $owned $listenerSnapshot)
if ($agentRecords.Count -gt 0) {
  $agentOwnership = if (@($agentRecords | Where-Object { $_.Owned }).Count -gt 0) { 'owned' } else { 'foreign/adopted' }
  Write-Warning "[monitor-start] agent port 7788 is already listening ($agentOwnership; PID $($agentRecords.Pid -join ',')); dock recovery will continue and compatibility will be verified."
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction Stop }
$npm = [string]$npmCommand.Source
$out = Join-Path $SubRoot '.codex-current-tauri-dev.log'
$err = Join-Path $SubRoot '.codex-current-tauri-dev.err.log'

$wrapper = $ExpectedWrapperPath

function ConvertTo-SingleQuotedLiteral([string]$Value) { return $Value.Replace("'", "''") }
$wrapperLines = @(
  '$ErrorActionPreference = ''Stop''',
  "Set-Location -LiteralPath '$(ConvertTo-SingleQuotedLiteral $SubRoot)'",
  $(if ($Mock) { '$env:GSM_AGENT = ''--mock''' } else { 'Remove-Item Env:GSM_AGENT -ErrorAction SilentlyContinue' }),
  "& '$(ConvertTo-SingleQuotedLiteral $npm)' run desktop:dev 1> '$(ConvertTo-SingleQuotedLiteral $out)' 2> '$(ConvertTo-SingleQuotedLiteral $err)'",
  'exit $LASTEXITCODE'
)
$utf8Bom = New-Object System.Text.UTF8Encoding -ArgumentList $true
[System.IO.File]::WriteAllText($wrapper, ($wrapperLines -join [System.Environment]::NewLine), $utf8Bom)

$state = [pscustomobject][ordered]@{
  Schema = 1
  CheckoutRoot = $SubRoot
  DockHeightPx = $DockHeightPx
  CapturedAtUtc = [datetime]::UtcNow.ToString('o')
  StartedAtUtc = $null
  Status = 'launching'
  LauncherPid = 0
  LauncherCreationUtc = $null
  WrapperPath = $wrapper
  WorkAreas = @($baseline)
}
Write-SessionState $state

$hostCommand = Get-Command pwsh.exe -ErrorAction SilentlyContinue
if (-not $hostCommand) { $hostCommand = Get-Command powershell.exe -ErrorAction Stop }
$hostExe = [string]$hostCommand.Source
$commandLine = '"{0}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}"' -f $hostExe, $wrapper

Write-Host "[monitor-start] launching detached desktop dev session in $SubRoot"
try {
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
} catch {
  $state.Status = 'launch-failed'
  Write-SessionState $state
  Write-Error "[monitor-start] detached launch failed: $($_.Exception.Message)" -ErrorAction Continue
  Exit-MonitorStart 6
}
if ([int]$result.ReturnValue -ne 0) {
  $state.Status = 'launch-failed'
  Write-SessionState $state
  Write-Error "[monitor-start] detached launch failed (Win32_Process.Create ReturnValue=$($result.ReturnValue))." -ErrorAction Continue
  Exit-MonitorStart 6
}

$state.LauncherPid = [int]$result.ProcessId
$state.StartedAtUtc = [datetime]::UtcNow.ToString('o')
for ($attempt = 0; $attempt -lt 10; $attempt++) {
  $launcherProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.LauncherPid)" -ErrorAction SilentlyContinue
  if ($launcherProcess) {
    $created = Get-ProcessCreationUtc $launcherProcess
    if ($created) { $state.LauncherCreationUtc = $created.ToString('o') }
    break
  }
  Start-Sleep -Milliseconds 100
}
Write-SessionState $state
Write-Host "[monitor-start] launched detached (PID $($state.LauncherPid)); logs -> $out"

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$webReady = $false
$dockReady = $false
$agentReady = $false
$agentOwner = 'none'
$readinessAuditWarningShown = $false
do {
  try {
    $processes = @(Get-ProcessSnapshot)
    $owned = Get-OwnedProcessMap $processes $state
    $dockReady = @(Get-CheckoutDocks $processes $owned).Count -gt 0

    $listenerSnapshot = @(Get-ListeningConnectionsSnapshot)
    $webRecords = @(Get-PortRecords 5180 $processes $owned $listenerSnapshot)
    $webReady = @($webRecords | Where-Object { $_.Owned }).Count -gt 0

    $agentRecords = @(Get-PortRecords 7788 $processes $owned $listenerSnapshot)
    if ($agentRecords.Count -gt 0) {
      $agentOwner = if (@($agentRecords | Where-Object { $_.Owned }).Count -gt 0) { 'owned' } else { 'foreign/adopted' }
      $agentReady = Test-CompatibleAgent
    } else {
      $agentOwner = 'none'
      $agentReady = $false
    }
  } catch {
    if (-not $readinessAuditWarningShown) {
      Write-Warning "[monitor-start] readiness audit failed and will be retried: $($_.Exception.Message)"
      $readinessAuditWarningShown = $true
    }
    $webReady = $false
    $dockReady = $false
    $agentOwner = 'none'
    $agentReady = $false
  }

  if ($webReady -and $dockReady -and $agentReady) { break }
  Start-Sleep -Milliseconds 750
} while ((Get-Date) -lt $deadline)

Write-Host ("[monitor-start] owned web@5180={0}  checkout dock={1}  compatible agent@7788={2} ({3})" -f $webReady, $dockReady, $agentReady, $agentOwner)
if (-not ($webReady -and $dockReady -and $agentReady)) {
  $state.Status = 'timeout'
  Write-SessionState $state
  Write-Warning "[monitor-start] startup timed out after ${TimeoutSec}s; closing the partial session through the verified stop path."
  Write-Host "  Get-Content '$err' -Tail 40"
  & (Join-Path $PSScriptRoot 'monitor-stop.ps1')
  $cleanupExitCode = $LASTEXITCODE
  if ($cleanupExitCode -ne 0) {
    Write-Warning "[monitor-start] timeout cleanup also failed (exit $cleanupExitCode); inspect the stop diagnostics above."
  }
  Exit-MonitorStart 7
}

$state.Status = 'running'
Write-SessionState $state
Write-Host '[monitor-start] ready.'
Exit-MonitorStart 0
} finally {
  # Covers provider errors, wrapper/state I/O failures, and pipeline interruption.
  # Explicit exits also pass through here; Close-StartMutex is idempotent.
  Close-StartMutex
}
