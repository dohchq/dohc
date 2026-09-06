param([string]$NodeExecutable, [string]$RelayPath, [string]$Payload)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Verification requires PowerShell 7 (pwsh.exe).' }

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

public static class VerificationJob {
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

    public static int Run(string node, string relay, string payload) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, without either breakaway flag.
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            // This process owns the only job handle. Its exit closes the job,
            // including descendants whose immediate parent has already exited.
            var start = new ProcessStartInfo(node);
            start.ArgumentList.Add(relay);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            using (var child = Process.Start(start)) {
                try {
                    // The trusted relay waits for this payload before spawning the command.
                    if (!AssignProcessToJobObject(job, child.Handle))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    child.StandardInput.Write(payload);
                    child.StandardInput.Close();
                    var stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                    var stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                    child.WaitForExit();
                    Task.WaitAll(stdout, stderr);
                    return child.ExitCode;
                } finally {
                    if (!child.HasExited) child.Kill();
                    child.WaitForExit();
                }
            }
        } finally { CloseHandle(job); }
    }
}
'@

try { exit [VerificationJob]::Run($NodeExecutable, $RelayPath, $Payload) }
catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
