// Owns one agent probe on Windows. The relay and every process it starts run
// in a kill-on-close job without breakaway. This owner exits only after the
// relay has exited, its output has drained and a query reports the job empty.
// Arguments: <node.exe> <agentProbeRelay.mjs> <admission byte count>.
// stdin: the admission, then end of input when the caller stops the probe or exits.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// Each call returns 0 or a Win32 error code. agentProbeOwner.test.cs fakes this boundary.
interface IProbeJob {
    int Assign(IntPtr process);
    int Terminate();
    int QueryActive(out uint active);
}

static class AgentProbeOwner {
    // agentProbeProcess.ts uses the same bound.
    const int MaxAdmissionBytes = 16 * 1024 * 1024;

    static int Main(string[] args) {
        Stream stderr = Console.OpenStandardError();
        try {
            int length;
            if (args.Length != 3 || !int.TryParse(args[2], out length) || length < 1 || length > MaxAdmissionBytes)
                throw new ArgumentException("Invalid agent probe arguments.");
            // Read the whole admission before any job or relay exists, so a short one starts nothing.
            Stream input = Console.OpenStandardInput();
            byte[] admission = new byte[length];
            for (int read = 0; read < length; ) {
                int count = input.Read(admission, read, length - read);
                if (count == 0) throw new EndOfStreamException("Agent probe admission ended early.");
                read += count;
            }
            // Completes when the caller stops the probe or exits.
            Task callerClosed = input.ReadAsync(new byte[1], 0, 1);
            using (KernelJob job = KernelJob.Create()) {
                return Own(args[0], args[1], admission, callerClosed, job, Console.OpenStandardOutput(), stderr,
                    Thread.Sleep, message => Report(stderr, message));
            }
        } catch (Exception error) {
            Report(stderr, error.Message);
            return 1;
        }
    }

    // Returns, or throws, only after the relay has exited. Once the relay is in
    // the job, also only after its output has drained and the job is empty.
    internal static int Own(string node, string relayPath, byte[] admission, Task callerClosed, IProbeJob job,
            Stream stdout, Stream stderr, Action<int> sleep, Action<string> report) {
        if (callerClosed.IsCompleted) throw new OperationCanceledException("The agent probe stopped before it started.");
        ProcessStartInfo start = new ProcessStartInfo(node);
        start.Arguments = Quote(relayPath);
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.EnvironmentVariables.Remove("NODE_OPTIONS");
        start.EnvironmentVariables.Remove("NODE_PATH");
        using (Process relay = Process.Start(start)) {
            int error = job.Assign(relay.Handle);
            if (error != 0) {
                // Before its admission the relay starts nothing. If termination
                // fails, end of input still makes it exit without starting anything.
                Native.TerminateProcess(relay.Handle, 1);
                Close(relay.StandardInput);
                relay.WaitForExit();
                throw new Win32Exception(error);
            }
            Task output = null;
            try {
                output = Task.WhenAll(
                    relay.StandardOutput.BaseStream.CopyToAsync(stdout),
                    relay.StandardError.BaseStream.CopyToAsync(stderr));
                // A probe stopped after the relay started gets no admission, so the relay exits at end of input.
                if (!callerClosed.IsCompleted) {
                    Stream input = relay.StandardInput.BaseStream;
                    input.Write(admission, 0, admission.Length);
                    input.Flush();
                }
                Close(relay.StandardInput);
                Task exited = Task.Run(() => relay.WaitForExit());
                Task.WaitAny(Task.WhenAll(output, exited), callerClosed);
            } finally {
                // Also ends processes that released their output but still run.
                Drain(job, sleep, report);
                relay.WaitForExit();
                // Every writer has exited. A copy fails if the caller's pipe closed first.
                if (output != null) {
                    try { output.Wait(); } catch (AggregateException) { }
                }
            }
            return relay.ExitCode;
        }
    }

    // TerminateJobObject only starts termination, and a process being created
    // can join the job after a call, so this terminates again until a query
    // succeeds and reports no active process. A call that keeps failing keeps
    // this owner, and so the caller's probe, waiting: drainage is never assumed.
    internal static void Drain(IProbeJob job, Action<int> sleep, Action<string> report) {
        int terminateError = 0, queryError = 0;
        for (int delay = 5; ; delay = Math.Min(delay * 2, 100)) {
            int error = job.Terminate();
            if (error != 0 && error != terminateError)
                report("Agent probe termination failed with error " + error + "; still waiting.");
            terminateError = error;
            uint active;
            error = job.QueryActive(out active);
            if (error == 0 && active == 0) return;
            if (error != 0 && error != queryError)
                report("Agent probe query failed with error " + error + "; still waiting.");
            queryError = error;
            sleep(delay);
        }
    }

    // The relay can exit before its input closes.
    static void Close(StreamWriter writer) {
        try { writer.Close(); } catch (IOException) { }
    }

    static void Report(Stream stream, string message) {
        byte[] bytes = Encoding.UTF8.GetBytes(message + Environment.NewLine);
        try { stream.Write(bytes, 0, bytes.Length); } catch (IOException) { } // The caller can be gone.
    }

    static string Quote(string value) {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
}

sealed class KernelJob : IProbeJob, IDisposable {
    readonly IntPtr handle;
    KernelJob(IntPtr handle) { this.handle = handle; }

    // Kill-on-close without breakaway: the relay and everything it starts stay in the job.
    public static KernelJob Create() {
        IntPtr handle = Native.CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        Native.ExtendedLimits limits = new Native.ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!Native.SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(limits))) {
            int error = Marshal.GetLastWin32Error();
            Native.CloseHandle(handle);
            throw new Win32Exception(error);
        }
        return new KernelJob(handle);
    }

    public int Assign(IntPtr process) {
        return Native.AssignProcessToJobObject(handle, process) ? 0 : Marshal.GetLastWin32Error();
    }

    public int Terminate() {
        return Native.TerminateJobObject(handle, 1) ? 0 : Marshal.GetLastWin32Error();
    }

    public int QueryActive(out uint active) {
        Native.Accounting info;
        bool queried = Native.QueryInformationJobObject(handle, 1, out info, (uint)Marshal.SizeOf(typeof(Native.Accounting)), IntPtr.Zero);
        int error = queried ? 0 : Marshal.GetLastWin32Error();
        active = info.ActiveProcesses;
        return error;
    }

    public void Dispose() { Native.CloseHandle(handle); }
}

static class Native {
    [StructLayout(LayoutKind.Sequential)]
    internal struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")]
    internal static extern bool CloseHandle(IntPtr handle);
}
