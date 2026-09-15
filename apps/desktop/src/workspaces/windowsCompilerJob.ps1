param([string]$NodeExecutable, [string]$RelayPath, [string]$Payload, [UInt64]$MemoryBytes, [UInt32]$MaxProcesses, [Int32]$TimeoutMs, [Int64]$InputBytes)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 5) { throw 'Compiler containment requires PowerShell 5 or later.' }
if ($MemoryBytes -eq 0 -or $MaxProcesses -eq 0 -or $TimeoutMs -le 0 -or $InputBytes -lt 0) { throw 'Invalid compiler job bounds.' }

# Same ownership and admission sequence as scripts/verification/windows-job.ps1.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class CompilerJob {
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
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    public static int Run(string node, string relay, string payload, ulong memoryBytes, uint maxProcesses, int timeoutMs, long inputBytes) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000 | 0x200 | 0x8; // KILL_ON_JOB_CLOSE, aggregate JOB_MEMORY, ACTIVE_PROCESS; no breakaway.
            limits.Basic.ActiveProcesses = maxProcesses;
            limits.JobMemory = new UIntPtr(memoryBytes);
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            var start = new ProcessStartInfo(node);
            start.Arguments = Quote(relay);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.EnvironmentVariables.Remove("NODE_OPTIONS");
            start.EnvironmentVariables.Remove("NODE_PATH");
            start.EnvironmentVariables.Remove("ESBUILD_BINARY_PATH");
            using (var child = Process.Start(start)) {
                try {
                    if (!AssignProcessToJobObject(job, child.Handle))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    byte[] admission = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(Convert.FromBase64String(payload)) + "\n");
                    child.StandardInput.BaseStream.Write(admission, 0, admission.Length);
                    child.StandardInput.BaseStream.Flush();
                    var callerClosed = Task.Run(async () => {
                        var input = Console.OpenStandardInput();
                        var buffer = new byte[8192];
                        long remaining = inputBytes;
                        try {
                            while (remaining > 0) {
                                int count = await input.ReadAsync(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                                if (count == 0) return;
                                await child.StandardInput.BaseStream.WriteAsync(buffer, 0, count);
                                remaining -= count;
                            }
                            child.StandardInput.Close();
                            // EOF or extra bytes both end this one-request owner's authority.
                            await input.ReadAsync(buffer, 0, 1);
                        } catch (System.IO.IOException) { }
                    });
                    var stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                    var stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                    var exited = Task.Run(() => child.WaitForExit());
                    int winner = Task.WaitAny(new Task[] { exited, callerClosed, Task.Delay(timeoutMs) });
                    int code = winner == 0 ? child.ExitCode : winner == 2 ? 124 : 125;
                    if (!TerminateJobObject(job, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    Task.WaitAll(stdout, stderr);
                    return code;
                } finally {
                    if (!child.HasExited) child.Kill();
                    child.WaitForExit();
                }
            }
        } finally { CloseHandle(job); }
    }
}
'@
try { exit [CompilerJob]::Run($NodeExecutable, $RelayPath, $Payload, $MemoryBytes, $MaxProcesses, $TimeoutMs, $InputBytes) }
catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
