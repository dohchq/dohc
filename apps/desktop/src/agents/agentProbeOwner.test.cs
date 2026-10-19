// Fake kernel boundary for agentProbeOwner.cs, compiled with it by
// scripts/agent-probe-owner.test.mjs. The Own cases start the real relay on a
// real Node but use no job: they check ordering, not containment.
// Arguments: <node.exe> <agentProbeRelay.mjs> <scratch directory>.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Text;
using System.Threading.Tasks;

// Results repeat their last entry. A query result below zero is a failure with
// that error code. It reports zero active processes, so a test catches
// drainage inferred from a failed query.
sealed class FakeJob : IProbeJob {
    public readonly List<string> Calls = new List<string>();
    readonly int assign;
    readonly int[] terminate;
    readonly long[] query;
    int terminated, queried;

    public FakeJob(int assign, int[] terminate, long[] query) {
        this.assign = assign; this.terminate = terminate; this.query = query;
    }
    public int Assign(IntPtr process) { Calls.Add("assign"); return assign; }
    public int Terminate() { Calls.Add("terminate"); return terminate[Math.Min(terminated++, terminate.Length - 1)]; }
    public int QueryActive(out uint active) {
        Calls.Add("query");
        long result = query[Math.Min(queried++, query.Length - 1)];
        active = result < 0 ? 0u : (uint)result;
        return result < 0 ? (int)-result : 0;
    }
}

static class AgentProbeOwnerTests {
    sealed class StillWaiting : Exception { }
    static int failures;

    static void Check(bool passed, string name) {
        Console.WriteLine((passed ? "ok " : "FAIL ") + name);
        if (!passed) failures++;
    }

    // Stands in for Thread.Sleep and ends a drain that would otherwise wait forever.
    static Action<int> Sleeps(List<int> delays, int limit) {
        return delay => { delays.Add(delay); if (delays.Count == limit) throw new StillWaiting(); };
    }

    static bool Waits(FakeJob job, List<int> delays) {
        try { AgentProbeOwner.Drain(job, Sleeps(delays, 50), message => { }); return false; }
        catch (StillWaiting) { return true; }
    }

    static int Run(string node, string relay, byte[] admission, Task closed, FakeJob job, Stream stdout) {
        return AgentProbeOwner.Own(node, relay, admission, closed, job, stdout, new MemoryStream(), delay => { }, message => { });
    }

    // The command creates the marker and prints "probe ok", so the marker shows that it ran.
    static byte[] Admission(string node, string cwd, string marker) {
        string script = "require('fs').writeFileSync(process.argv[1], ''); process.stdout.write('probe ok')";
        return Encoding.UTF8.GetBytes("{\"command\":" + Json(node) + ",\"args\":[\"-e\"," + Json(script) + "," + Json(marker) +
            "],\"windowsVerbatimArguments\":false,\"cwd\":" + Json(cwd) + ",\"env\":{\"SystemRoot\":" +
            Json(Environment.GetEnvironmentVariable("SystemRoot")) + "}}");
    }

    static string Json(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

    static int Main(string[] args) {
        string node = args[0], relay = args[1], scratch = args[2];

        List<string> reports = new List<string>();
        List<int> delays = new List<int>();
        FakeJob recovering = new FakeJob(0, new[] { 5, 5, 0 }, new long[] { -31, 3, -6, 0 });
        AgentProbeOwner.Drain(recovering, Sleeps(delays, 50), reports.Add);
        Check(string.Join(",", recovering.Calls) == "terminate,query,terminate,query,terminate,query,terminate,query",
            "drain settles only on a successful empty query and terminates on every attempt");
        Check(string.Join(",", delays) == "5,10,20", "drain backs off between attempts");
        Check(reports.Count == 3, "drain reports each new failure once");

        delays = new List<int>();
        Check(Waits(new FakeJob(0, new[] { 0 }, new long[] { -5 }), delays), "a query that keeps failing never settles");
        Check(delays[delays.Count - 1] == 100, "a long wait polls at most every 100 ms");
        Check(Waits(new FakeJob(0, new[] { 5 }, new long[] { 1 }), new List<int>()),
            "a job that keeps a process after failed termination never settles");
        FakeJob empty = new FakeJob(0, new[] { 5 }, new long[] { 0 });
        AgentProbeOwner.Drain(empty, Sleeps(new List<int>(), 50), message => { });
        Check(empty.Calls.Count == 2, "an empty job settles even when termination failed");

        Task never = new TaskCompletionSource<int>().Task;
        string marker = Path.Combine(scratch, "refused");
        FakeJob refused = new FakeJob(5, new[] { 0 }, new long[] { 0 });
        int code = 0;
        try { Run(node, relay, Admission(node, scratch, marker), never, refused, new MemoryStream()); }
        catch (Win32Exception error) { code = error.NativeErrorCode; }
        Check(code == 5 && string.Join(",", refused.Calls) == "assign" && !File.Exists(marker),
            "a refused assignment ends the relay before its admission and starts nothing");

        marker = Path.Combine(scratch, "stopped");
        FakeJob stopped = new FakeJob(0, new[] { 0 }, new long[] { 0 });
        bool cancelled = false;
        try { Run(node, relay, Admission(node, scratch, marker), Task.FromResult(0), stopped, new MemoryStream()); }
        catch (OperationCanceledException) { cancelled = true; }
        Check(cancelled && stopped.Calls.Count == 0 && !File.Exists(marker), "a probe stopped before it starts creates no relay");

        marker = Path.Combine(scratch, "completed");
        MemoryStream stdout = new MemoryStream();
        FakeJob completed = new FakeJob(0, new[] { 5, 0 }, new long[] { -31, 0 });
        code = Run(node, relay, Admission(node, scratch, marker), never, completed, stdout);
        Check(code == 0 && Encoding.UTF8.GetString(stdout.ToArray()) == "probe ok" && File.Exists(marker),
            "a completed probe keeps its output and exit code");
        Check(string.Join(",", completed.Calls) == "assign,terminate,query,terminate,query",
            "a completed probe still drains its job through a failed attempt");

        return failures == 0 ? 0 : 1;
    }
}
