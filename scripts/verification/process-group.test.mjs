import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { run } from "./process.mjs";

function killRecorded(path, group = false) {
  if (!existsSync(path)) return;
  const { pid } = JSON.parse(readFileSync(path, "utf8"));
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(group ? -pid : pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

test("POSIX timeout kills descendants holding pipes after their leader exits", {
  skip: process.platform === "win32" ? "POSIX detached process-group lifecycle" : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-process-group-"));
  let completed = false;
  try {
    writeFileSync(join(root, "descendant.mjs"), `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      writeFileSync(join(process.argv[2], "descendant.json"), JSON.stringify({ pid: process.pid }));
      process.on("SIGTERM", () => process.stderr.write("descendant ignored SIGTERM\\n"));
      setInterval(() => {}, 1000);
      process.stdout.write("descendant ready\\n");
      process.send("ready");
    `);
    writeFileSync(join(root, "leader.mjs"), `
      import { spawn } from "node:child_process";
      import { join } from "node:path";
      const root = process.argv[2];
      const descendant = spawn(process.execPath, [join(root, "descendant.mjs"), root], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      descendant.once("message", () => { descendant.disconnect(); process.exit(0); });
    `);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { run } from ${JSON.stringify(new URL("./process.mjs", import.meta.url).href)};
      const root = process.argv[1];
      const log = join(root, "group.log");
      let leaderExit;
      let closed = false;
      await assert.rejects(run(process.execPath, [join(root, "leader.mjs"), root], {
        timeoutMs: 2500, log,
        onSpawn: leader => {
          writeFileSync(join(root, "leader.json"), JSON.stringify({ pid: leader.pid }));
          leader.once("exit", (code, signal) => { leaderExit = { code, signal }; });
          leader.once("close", () => { closed = true; });
        },
      }), /timed out after 2500ms/);
      assert.deepEqual(leaderExit, { code: 0, signal: null });
      assert.equal(closed, true);
      const evidence = readFileSync(log, "utf8");
      assert.match(evidence, /descendant ready/);
      assert.match(evidence, /descendant ignored SIGTERM/);
      writeFileSync(join(root, "completed.json"), JSON.stringify({ leaderExit, closed }));
    `, root], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
    completed = existsSync(join(root, "completed.json"));
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(completed, true);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "completed.json"), "utf8")), {
      leaderExit: { code: 0, signal: null }, closed: true,
    });
  } finally {
    if (!completed) {
      killRecorded(join(root, "descendant.json"));
      killRecorded(join(root, "leader.json"), true);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows timeout kills descendants holding pipes after cmd.exe exits", {
  skip: process.platform !== "win32", timeout: 25_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-windows-job-"));
  try {
    writeFileSync(join(root, "descendant.mjs"), `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, leaderPid: process.ppid }));
      console.log("descendant ready");
      const leaderPid = process.ppid;
      const checkLeader = setInterval(() => {
        try { process.kill(leaderPid, 0); }
        catch (error) {
          if (error.code !== "ESRCH") throw error;
          console.log("cmd leader exited");
          clearInterval(checkLeader);
        }
      }, 10);
      setInterval(() => {}, 1000);
    `);
    writeFileSync(join(root, "leader.cmd"), `@echo off\r\nstart "" /b "${process.execPath}" "${join(root, "descendant.mjs")}" "${join(root, "descendant.json")}"\r\n`);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { run } from ${JSON.stringify(new URL("./process.mjs", import.meta.url).href)};
      const root = process.argv[1];
      let owner;
      await assert.rejects(run("cmd.exe", ["/d", "/c", join(root, "leader.cmd")], {
        timeoutMs: 2000, log: join(root, "output.log"),
        onSpawn: child => { owner = child; writeFileSync(join(root, "owner.json"), JSON.stringify({ pid: child.pid })); },
      }), /timed out after 2000ms/);
      assert.ok(owner.exitCode !== null || owner.signalCode !== null);
      assert.match(readFileSync(join(root, "output.log"), "utf8"), /descendant ready/);
      assert.match(readFileSync(join(root, "output.log"), "utf8"), /cmd leader exited/);
      const { pid } = JSON.parse(readFileSync(join(root, "descendant.json"), "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      console.log(JSON.stringify({ ownerPid: owner.pid, descendantPid: pid, closed: true }));
    `, root], { encoding: "utf8", windowsHide: true, timeout: 10_000, killSignal: "SIGKILL" });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"closed":true/);
  } finally {
    // Open and retain the process handle before checking the unique fixture path.
    // If an earlier PID has exited, never use that PID for a later kill operation.
    if (existsSync(join(root, "descendant.json"))) {
      const { pid } = JSON.parse(readFileSync(join(root, "descendant.json"), "utf8"));
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
        $owned = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
        if ($owned) {
          try {
            $null = $owned.Handle
            $identity = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'
            if ($identity.CommandLine -and $identity.CommandLine.Contains('${root.replaceAll("'", "''")}') -and !$owned.HasExited) {
              $owned.Kill(); $owned.WaitForExit(5000) | Out-Null
            }
          } finally { $owned.Dispose() }
        }
        exit 0
      `], { windowsHide: true, timeout: 10_000, stdio: "ignore" });
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows job refuses to launch the command when job assignment fails", {
  skip: process.platform !== "win32", timeout: 10_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-job-assignment-"));
  try {
    const helper = readFileSync(new URL("./windows-job.ps1", import.meta.url), "utf8");
    const invalidHandle = helper.replace("Process.GetCurrentProcess().Handle", "IntPtr.Zero");
    assert.notEqual(invalidHandle, helper);
    const script = join(root, "invalid-job.ps1");
    writeFileSync(script, invalidHandle);
    const marker = join(root, "command-ran");
    const payload = Buffer.from(JSON.stringify({ command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] })).toString("base64");
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(script)}))) ${[
        process.execPath, fileURLToPath(new URL("./windows-command.mjs", import.meta.url)), payload,
      ].map(quote).join(" ")}`], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Win32Exception/);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows job preserves arguments, environment, cwd, and unformatted output", {
  skip: process.platform !== "win32", timeout: 10_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-job-quoting-"));
  try {
    const args = ["", "two words", 'a"b', "trailing\\", "雪", "$(not-a-command)", "a'b"];
    const result = await run(process.execPath, ["-e", `
      process.stdout.write(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd(), value: process.env.DOHC_JOB_TEST }));
      process.stderr.write("stderr\\r\\n雪\\u0000tail");
    `, ...args], { cwd: root, env: { ...process.env, DOHC_JOB_TEST: "unchanged 雪" }, timeoutMs: 5000, quietStdout: true });
    assert.deepEqual(JSON.parse(result.stdout), { args, cwd: root, value: "unchanged 雪" });
    assert.equal(result.stderr, "stderr\r\n雪\u0000tail");
    assert.equal(result.code, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
