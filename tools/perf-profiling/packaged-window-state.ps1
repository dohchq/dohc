$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PackagedBenchmarkWindow {
  private delegate bool EnumWindowsCallback(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder title, int count);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Placement { public int Length, Flags, ShowCmd; public Point MinPosition, MaxPosition; public Rect NormalPosition; }
  [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr hWnd, ref Placement placement);
  public static Rect NormalRect(IntPtr window) {
    var placement = new Placement(); placement.Length = Marshal.SizeOf<Placement>();
    if (!GetWindowPlacement(window, ref placement)) throw new Exception("Cannot inspect app window placement");
    return placement.NormalPosition;
  }
  public static string Title(IntPtr window) {
    var title = new StringBuilder(GetWindowTextLength(window) + 1); GetWindowText(window, title, title.Capacity); return title.ToString();
  }
  public static IntPtr[] FindWindows(uint processId) {
    var windows = new List<IntPtr>();
    EnumWindows((window, unused) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      var className = new StringBuilder(256); GetClassName(window, className, className.Capacity);
      if (owner == processId && className.ToString() == "Chrome_WidgetWin_1" && GetWindowTextLength(window) > 0) windows.Add(window);
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

function Invoke-WindowRequest($request) {
  $AppProcessId = [int]$request.pid
  $ExpectedBinary = [string]$request.binary
  $ExpectedTitle = [string]$request.title
  $State = [string]$request.state
  if ($State -notin @('inspect', 'visible', 'minimized')) { throw 'Invalid window state' }
  $ownedProcess = Get-Process -Id $AppProcessId -ErrorAction Stop
  if (![StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($ownedProcess.Path), [IO.Path]::GetFullPath($ExpectedBinary))) {
    throw 'PID no longer belongs to the recorded packaged executable'
  }
$windows = @([PackagedBenchmarkWindow]::FindWindows($AppProcessId))
if ($State -eq 'inspect' -and $windows.Count -eq 0) {
  return @{ ready = $false; reason = 'window-not-ready'; pid = $AppProcessId }
}
if ($windows.Count -ne 1) { throw "Recorded packaged process has $($windows.Count) titled app windows; expected one" }
$window = $windows[0]
$title = [PackagedBenchmarkWindow]::Title($window)
if ($State -eq 'inspect' -and $title -ne $ExpectedTitle) {
  return @{ ready = $false; reason = 'title-changing'; pid = $AppProcessId }
}
if ($title -ne $ExpectedTitle) { throw "Owned window title '$title' does not match CDP page title '$ExpectedTitle'" }
$normalRect = [PackagedBenchmarkWindow]::NormalRect($window)
if (($normalRect.Right - $normalRect.Left) -lt 300 -or ($normalRect.Bottom - $normalRect.Top) -lt 200) { throw 'Owned window does not have application-sized normal dimensions' }
$minimized = $State -eq 'minimized'
if ($State -ne 'inspect') {
[void][PackagedBenchmarkWindow]::ShowWindowAsync($window, $(if ($minimized) { 6 } else { 9 }))
if (!$minimized) { [void][PackagedBenchmarkWindow]::SetForegroundWindow($window) }
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while ([PackagedBenchmarkWindow]::IsIconic($window) -ne $minimized -or ![PackagedBenchmarkWindow]::IsWindowVisible($window)) {
  if ([DateTime]::UtcNow -gt $deadline) { throw 'Owned window did not reach requested state' }
  Start-Sleep -Milliseconds 20
}
}
@{ pid = $AppProcessId; window = $window.ToInt64(); title = $title; class = 'Chrome_WidgetWin_1'; normalRect = $normalRect; state = $State; visible = [PackagedBenchmarkWindow]::IsWindowVisible($window); minimized = [PackagedBenchmarkWindow]::IsIconic($window); at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

}
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    if ($request.state -eq 'exit') { break }
    if ($request.state -eq 'ping') { $value = @{ pong = $true } }
    else { $value = Invoke-WindowRequest $request }
    $response = @{ id = $request.id; value = $value }
  } catch { $response = @{ id = $request.id; error = $_.Exception.Message } }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 6 -Compress))
  [Console]::Out.Flush()
}
