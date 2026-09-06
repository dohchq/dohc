import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { run } from "./process.mjs";

function stopWindowsDescendant(root) {
  if (!existsSync(join(root, "descendant.json"))) return;
  const { pid } = JSON.parse(readFileSync(join(root, "descendant.json"), "utf8"));
  // Retain the process handle before checking the unique fixture path.
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

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`POSIX repeated ${signal} waits for owned group escalation and caller cleanup`, {
    skip: process.platform === "win32" ? "Real POSIX signal delivery" : false,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-repeated-signal-"));
    let supervisor;
    let supervisorClosed;
    let deadline;
    let commandSocket;
    let commandClosed;
    let cleaning = false;
    const server = createServer((socket) => {
      commandSocket = socket;
      commandClosed = new Promise((done) => socket.once("close", done));
      socket.on("error", () => {});
      socket.resume();
      if (cleaning) socket.end();
    });
    try {
      await new Promise((done, reject) => {
        server.once("error", reject);
        server.listen(join(root, "cleanup.sock"), done);
      });
      writeFileSync(join(root, "command.mjs"), `
        import {connect} from 'node:net';
        import {join} from 'node:path';
        const cleanup=connect(join(import.meta.dirname,'cleanup.sock'));
        cleanup.on('end',()=>process.exit(0));
        cleanup.on('error',()=>process.exit(1));
        cleanup.resume();
        process.on('SIGTERM',()=>process.stderr.write('command ignored SIGTERM\\n'));
        setInterval(()=>{},1000);
        cleanup.once('connect',()=>console.log('command ready'));
      `);
      supervisor = spawn(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import {writeFileSync} from 'node:fs';
        import {join} from 'node:path';
        import {run} from ${JSON.stringify(new URL("./process.mjs", import.meta.url).href)};
        const root=process.argv[1];
        let command, closed=false, signals=0, callerFinally=false;
        let stdout='',stderr='';
        try {
          await assert.rejects(run(process.execPath,[join(root,'command.mjs')],{
            timeoutMs:10000,log:join(root,'command.log'),
            onSpawn:child=>{
              command=child;
              child.once('close',()=>{closed=true;});
              child.stdout.on('data',chunk=>{
                stdout+=chunk;
                if(signals===0 && stdout.includes('command ready')) {
                  signals++;process.kill(process.pid,${JSON.stringify(signal)});
                }
              });
              child.stderr.on('data',chunk=>{
                stderr+=chunk;
                if(signals===1 && stderr.includes('command ignored SIGTERM')) {
                  signals++;process.kill(process.pid,${JSON.stringify(signal)});
                }
              });
            },
          }),/interrupted/);
        } finally {callerFinally=true;}
        assert.equal(signals,2);
        assert.equal(closed,true);
        assert.equal(command.signalCode,'SIGKILL');
        assert.equal(process.listenerCount('SIGINT'),0);
        assert.equal(process.listenerCount('SIGTERM'),0);
        writeFileSync(join(root,'completed.json'),JSON.stringify({signals,closed,callerFinally}));
      `, root], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      supervisor.stderr.on("data", (chunk) => { stderr += chunk; });
      supervisorClosed = new Promise((done, reject) => {
        supervisor.once("error", reject);
        supervisor.once("close", (status, signal) => done({ status, signal }));
      });
      deadline = setTimeout(() => supervisor.kill("SIGKILL"), 15_000);
      const result = await supervisorClosed;
      assert.equal(result.signal, null, "repeated signal must not terminate the supervisor before cleanup");
      assert.equal(result.status, 0, stderr);
      assert.ok(commandSocket);
      await commandClosed;
      assert.equal(commandSocket.destroyed, true);
      assert.deepEqual(JSON.parse(readFileSync(join(root, "completed.json"), "utf8")), { signals: 2, closed: true, callerFinally: true });
    } finally {
      clearTimeout(deadline);
      cleaning = true;
      commandSocket?.end();
      if (supervisor?.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
      await supervisorClosed?.catch(() => {});
      await new Promise((done) => server.close(done));
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("POSIX timeout kills descendants holding pipes after their leader exits", {
  skip: process.platform === "win32" ? "POSIX detached process-group lifecycle" : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-process-group-"));
  let supervisor;
  let supervisorClosed;
  let deadline;
  let descendantSocket;
  let descendantClosed;
  let cleaning = false;
  const server = createServer((socket) => {
    descendantSocket = socket;
    descendantClosed = new Promise((done) => socket.once("close", done));
    socket.on("error", () => {});
    socket.resume();
    if (cleaning) socket.end();
  });
  try {
    await new Promise((done, reject) => {
      server.once("error", reject);
      server.listen(join(root, "cleanup.sock"), done);
    });
    writeFileSync(join(root, "descendant.mjs"), `
      import { connect } from "node:net";
      import { join } from "node:path";
      const cleanup = connect(join(process.argv[2], "cleanup.sock"));
      cleanup.on("end", () => process.exit(0));
      cleanup.on("error", () => process.exit(1));
      cleanup.resume();
      process.on("SIGTERM", () => process.stderr.write("descendant ignored SIGTERM\\n"));
      setInterval(() => {}, 1000);
      cleanup.once("connect", () => {
        process.stdout.write("descendant ready\\n");
        process.send("ready");
      });
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
    supervisor = spawn(process.execPath, ["--input-type=module", "-e", `
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
    `, root], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    supervisor.stderr.on("data", (chunk) => { stderr += chunk; });
    supervisorClosed = new Promise((done, reject) => {
      supervisor.once("error", reject);
      supervisor.once("close", (status, signal) => done({ status, signal }));
    });
    deadline = setTimeout(() => supervisor.kill("SIGKILL"), 20_000);
    const result = await supervisorClosed;
    assert.equal(result.signal, null, stderr);
    assert.equal(result.status, 0, stderr);
    assert.ok(descendantSocket);
    await descendantClosed;
    assert.equal(descendantSocket.destroyed, true);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "completed.json"), "utf8")), {
      leaderExit: { code: 0, signal: null }, closed: true,
    });
  } finally {
    clearTimeout(deadline);
    cleaning = true;
    descendantSocket?.end();
    if (supervisor?.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    await supervisorClosed?.catch(() => {});
    await new Promise((done) => server.close(done));
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
    stopWindowsDescendant(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows job closes descendants after the command completes normally", {
  skip: process.platform !== "win32", timeout: 15_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-job-completion-"));
  try {
    writeFileSync(join(root, "descendant.mjs"), `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }));
      setInterval(() => {}, 1000);
      process.send("ready");
    `);
    const result = await run(process.execPath, ["--input-type=module", "-e", `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, ${JSON.stringify([join(root, "descendant.mjs"), join(root, "descendant.json")])}, {
        windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      child.once("message", () => {
        console.log("descendant ready");
        child.disconnect();
        process.exit(0);
      });
    `], { timeoutMs: 5000, quietStdout: true });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /descendant ready/);
    const { pid } = JSON.parse(readFileSync(join(root, "descendant.json"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    stopWindowsDescendant(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows job closes the relay without launching the command when child assignment fails", {
  skip: process.platform !== "win32", timeout: 10_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-job-assignment-"));
  try {
    const helper = readFileSync(new URL("./windows-job.ps1", import.meta.url), "utf8");
    const invalidHandle = helper.replace("AssignProcessToJobObject(job, child.Handle)", "AssignProcessToJobObject(job, IntPtr.Zero)");
    assert.notEqual(invalidHandle, helper);
    const script = join(root, "invalid-job.ps1");
    const relayPid = join(root, "relay.pid");
    const recordedChild = invalidHandle.replace("using (var child = Process.Start(start)) {", `using (var child = Process.Start(start)) {
      System.IO.File.WriteAllText(@"${relayPid.replaceAll('"', '""')}", child.Id.ToString());`);
    assert.notEqual(recordedChild, invalidHandle);
    writeFileSync(script, recordedChild);
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
    assert.throws(() => process.kill(Number(readFileSync(relayPid, "utf8")), 0), { code: "ESRCH" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const input of ["", "invalid payload"]) {
  test(`Windows command relay rejects ${input ? "invalid" : "missing"} authorization`, () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-relay-authorization-"));
    try {
      const marker = join(root, "command-ran");
      const payload = Buffer.from(JSON.stringify({ command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] })).toString("base64");
      // An argv payload must not bypass the job owner's stdin authorization.
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./windows-command.mjs", import.meta.url)), payload], {
        input, encoding: "utf8", windowsHide: true, timeout: 5000,
      });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(existsSync(marker), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

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
