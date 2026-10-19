param([Parameter(Mandatory)][string]$Root)
# Keeps the verification queue service running. Each service process lives in
# a job object that this supervisor alone holds; closing it stops the service
# and every process the service started. The service is stopped and restarted
# when it exits or when its heartbeat stops.
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'The queue supervisor requires PowerShell 7 (pwsh.exe).' }

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class QueueJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    public static IntPtr Create() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, without either breakaway flag.
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error);
        }
        return job;
    }
    public static void Assign(IntPtr job, IntPtr process) {
        if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static void Close(IntPtr job) { CloseHandle(job); }
}
'@

$rootPath = [IO.Path]::GetFullPath($Root)
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($rootPath.ToLowerInvariant()))).Substring(0, 12).ToLowerInvariant()
# One supervisor per queue root. Windows releases the mutex when this process dies.
$mutex = [Threading.Mutex]::new($false, "Local\dohc-verification-supervisor-$hash")
try { if (-not $mutex.WaitOne(0)) { exit 0 } } catch [Threading.AbandonedMutexException] { }

$logPath = Join-Path $rootPath 'supervisor.log'
function Write-Log([string]$line) {
    try {
        if ((Test-Path $logPath) -and (Get-Item $logPath).Length -gt 5MB) { Move-Item $logPath "$logPath.1" -Force }
        Add-Content -Path $logPath -Value "$([DateTime]::UtcNow.ToString('o')) $line"
    } catch { }
}

$node = (Get-Command node.exe).Source
$backoff = 5
Write-Log "supervisor $PID started for $rootPath"
while ($true) {
    $current = (Get-Content (Join-Path $rootPath 'current') -Raw).Trim()
    $service = Join-Path $rootPath "service\$current"
    $job = [QueueJob]::Create()
    $process = $null
    $assigned = $false
    $reason = 'exited'
    $started = [DateTime]::UtcNow
    try {
        $start = [Diagnostics.ProcessStartInfo]::new($node)
        foreach ($argument in @((Join-Path $service 'scripts\verification\queue-service.mjs'), '--supervised', '--root', $rootPath)) { $start.ArgumentList.Add($argument) }
        $start.WorkingDirectory = $service
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $process = [Diagnostics.Process]::Start($start)
        # The service waits for "go", so nothing it starts can escape the job.
        [QueueJob]::Assign($job, $process.Handle)
        $assigned = $true
        $process.StandardInput.WriteLine('go')
        $process.StandardInput.Flush()
        $beat = Join-Path $rootPath 'service.json'
        # Count polls without a new heartbeat, not wall-clock age: a wait does not advance
        # while the machine sleeps, so a resumed service is never mistaken for a hung one.
        $lastBeat = $null
        $quiet = 0
        while (-not $process.WaitForExit(5000)) {
            # A file locked for a moment reads as unchanged, never as a reason to stop the service.
            $seen = try { if (Test-Path $beat) { (Get-Item $beat).LastWriteTimeUtc } else { $null } } catch { $lastBeat }
            if ($seen -ne $lastBeat) { $lastBeat = $seen; $quiet = 0 } else { $quiet += 1 }
            if ($quiet -ge 24) { $reason = 'heartbeat stopped for 24 polls'; break }
        }
    } catch {
        $reason = "failed to start: $($_.Exception.Message)"
        # A service that never entered the job must not run unsupervised.
        if (-not $assigned -and $process -and -not $process.HasExited) { $process.Kill($true) }
    } finally {
        [QueueJob]::Close($job)
    }
    $code = if ($process -and $process.HasExited) { $process.ExitCode } else { $null }
    Write-Log "service $current $reason (exit $code); its job is closed"
    if ($code -eq 75) { $backoff = 5; continue }
    if (([DateTime]::UtcNow - $started).TotalMinutes -gt 10) { $backoff = 5 }
    Start-Sleep -Seconds $backoff
    $backoff = [Math]::Min($backoff * 2, 60)
}
