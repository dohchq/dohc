param([string]$NodeExecutable, [string]$RelayPath, [string]$Payload, [int]$CallerPid)
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
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    static long Created(IntPtr process) {
        long creation, exit, kernel, user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return creation;
    }

    // Windows can start this process outside its caller's job: Microsoft Store PowerShell runs as a
    // packaged app. So the command's lifetime follows the caller's process instead of its job.
    static IntPtr OpenCaller(int pid) {
        IntPtr caller = OpenProcess(0x00100000 | 0x1000, false, pid); // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
        if (caller == IntPtr.Zero) throw new InvalidOperationException("The caller exited before its command started.");
        // A pid reused after the caller exited names a process created after this one.
        if (WaitForSingleObject(caller, 0) == 0 || Created(caller) > Created(GetCurrentProcess())) {
            CloseHandle(caller);
            throw new InvalidOperationException("The caller exited before its command started.");
        }
        return caller;
    }

    public static int Run(string node, string relay, string payload, int callerPid) {
        IntPtr caller = OpenCaller(callerPid);
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) { CloseHandle(caller); throw new Win32Exception(Marshal.GetLastWin32Error()); }
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
            start.Environment.TryGetValue("NODE_OPTIONS", out var nodeOptions);
            start.Environment.Remove("NODE_OPTIONS"); // Preloads must not run before job assignment.
            using (var child = Process.Start(start)) {
                try {
                    // The trusted relay waits for this payload before spawning the command.
                    if (!AssignProcessToJobObject(job, child.Handle))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    child.StandardInput.Write(System.Text.Json.JsonSerializer.Serialize(new { payload, nodeOptions }));
                    child.StandardInput.Close();
                    var stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                    var stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                    // The caller cannot read the result once it has exited; closing the job stops the command.
                    while (!child.WaitForExit(250)) if (WaitForSingleObject(caller, 0) == 0) return 1;
                    Task.WaitAll(stdout, stderr);
                    return child.ExitCode;
                } finally {
                    if (!child.HasExited) child.Kill();
                    child.WaitForExit();
                }
            }
        } finally { CloseHandle(job); CloseHandle(caller); }
    }
}
'@

try { exit [VerificationJob]::Run($NodeExecutable, $RelayPath, $Payload, $CallerPid) }
# The command never started; verify.mjs reads this exit code as a machine failure.
catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 0xD0C5 }
