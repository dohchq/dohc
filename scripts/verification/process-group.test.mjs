import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { run } from "./process.mjs";

test("an already aborted command starts no process and creates no log", async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-preaborted-command-"));
  const controller = new AbortController();
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  let spawned = false;
  controller.abort();
  try {
    await assert.rejects(run(process.execPath, ["-e", "require('node:fs').writeFileSync('command-ran','yes')"], {
      cwd: root, signal: controller.signal, log: join(root, "output/command.log"),
      onSpawn: () => { spawned = true; }, timeoutMs: 20_000,
    }), error => {
      assert.equal(error.interrupted, true);
      assert.equal(error.timedOut, false);
      assert.equal(error.exitCode, null);
      assert.equal(error.signal, null);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr, "");
      return true;
    });
    assert.equal(spawned, false);
    assert.equal(existsSync(join(root, "command-ran")), false);
    assert.equal(existsSync(join(root, "output")), false);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("abort during onSpawn is observed after registering the listener", { timeout: 20_000 }, async () => {
  const controller = new AbortController();
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await assert.rejects(run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    signal: controller.signal, timeoutMs: 15_000, onSpawn: () => controller.abort(),
  }), error => {
    assert.equal(error.interrupted, true);
    assert.equal(error.timedOut, false);
    return true;
  });
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
});

test("POSIX abort waits for an ignored-stdio descendant after its leader closes", {
  skip: process.platform === "win32" ? "POSIX process-group lifecycle" : false, timeout: 30_000,
}, async context => {
  const root = mkdtempSync(join(tmpdir(), "dohc-abort-closed-leader-"));
  const controller = new AbortController();
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  let owner, descendantSocket, descendantPid, cleaning = false, socketClosed = false;
  let command;
  const abortReady = () => {
    if (descendantPid && descendantSocket && !controller.signal.aborted) controller.abort();
  };
  const server = createServer(socket => {
    descendantSocket = socket;
    socket.on("error", () => {});
    socket.once("close", () => { socketClosed = true; });
    socket.resume();
    if (cleaning) socket.end();
    else abortReady();
  });
  const stop = () => {
    cleaning = true;
    controller.abort();
    // This retained socket belongs to the fixture and asks only that descendant to exit.
    descendantSocket?.end();
  };
  context.signal.addEventListener("abort", stop, { once: true });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    writeFileSync(join(root, "descendant.mjs"), `
      import {connect} from 'node:net';
      const socket=connect(${server.address().port},'127.0.0.1');
      socket.on('end',()=>process.exit(0));
      socket.on('error',()=>process.exit(1));
      socket.resume();
      process.on('SIGTERM',()=>{});
      socket.once('connect',()=>process.send({pid:process.pid}));
    `);
    writeFileSync(join(root, "leader.mjs"), `
      import {spawn} from 'node:child_process';
      import {join} from 'node:path';
      process.on('SIGTERM',()=>process.exit(0));
      const child=spawn(process.execPath,[join(process.argv[2],'descendant.mjs')],{
        detached:false,stdio:['ignore','ignore','ignore','ipc'],
      });
      child.once('message',({pid})=>{
        child.disconnect();child.unref();console.log('descendant ready '+pid);
      });
      setInterval(()=>{},1000);
    `);
    let observed = "";
    command = run(process.execPath, [join(root, "leader.mjs"), root], {
      signal: controller.signal, timeoutMs: 20_000, quietStdout: true,
      onSpawn: child => {
        owner = child;
        child.stdout.on("data", chunk => {
          observed += chunk;
          const ready = /descendant ready (\d+)\n/u.exec(observed);
          if (ready) {
            descendantPid = Number(ready[1]);
            abortReady();
          }
        });
      },
    });
    await assert.rejects(command, error => {
      assert.equal(error.interrupted, true);
      assert.equal(error.timedOut, false);
      assert.equal(owner.exitCode, 0, "the leader exits normally on SIGTERM");
      assert.ok(descendantPid && descendantSocket);
      assert.equal(socketClosed, true, "caller cleanup cannot start while a descendant still owns its socket");
      assert.equal(descendantSocket.destroyed, true);
      return true;
    });
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
  } finally {
    context.signal.removeEventListener("abort", stop);
    stop();
    await command?.catch(() => {});
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test(`${process.platform === "win32" ? "Windows job" : "POSIX group"} abort closes active descendants before caller cleanup`, {
  timeout: 30_000,
}, async context => {
  const root = mkdtempSync(join(tmpdir(), "dohc-command-abort-"));
  const controller = new AbortController();
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  let owner, ready = false, descendantSocket, releaseDescendant, cancelWaitHandler, cleaning = false;
  const descendantClosed = new Promise(resolve => { releaseDescendant = resolve; });
  const server = createServer(socket => {
    descendantSocket = socket;
    socket.on("error", () => {});
    socket.once("close", releaseDescendant);
    socket.resume();
    if (cleaning) socket.end();
  });
  const cancelWait = new Promise((_, reject) => {
    cancelWaitHandler = () => {
      cleaning = true;
      controller.abort();
      descendantSocket?.end();
      if (owner?.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      reject(new Error("Descendant did not close."));
    };
    context.signal.addEventListener("abort", cancelWaitHandler, { once: true });
  });
  cancelWait.catch(() => {});
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    writeFileSync(join(root, "descendant.mjs"), `
      import {connect} from 'node:net';
      import {writeFileSync} from 'node:fs';
      import {join} from 'node:path';
      const socket=connect(${port},'127.0.0.1');
      socket.on('end',()=>process.exit(0));
      socket.on('error',()=>process.exit(1));
      socket.resume();
      process.on('SIGTERM',()=>process.stderr.write('descendant ignored SIGTERM\\n'));
      setInterval(()=>{},1000);
      socket.once('connect',()=>{
        writeFileSync(join(process.argv[2],'descendant.json'),JSON.stringify({pid:process.pid}));
        console.log('descendant ready');
      });
    `);
    writeFileSync(join(root, "leader.mjs"), `
      import {spawn} from 'node:child_process';
      import {join} from 'node:path';
      process.on('SIGTERM',()=>process.stderr.write('leader ignored SIGTERM\\n'));
      spawn(process.execPath,[join(process.argv[2],'descendant.mjs'),process.argv[2]],{
        windowsHide:true,stdio:['ignore','inherit','inherit'],
      });
      setInterval(()=>{},1000);
    `);
    let observed = "";
    await assert.rejects(run(process.execPath, [join(root, "leader.mjs"), root], {
      cwd: root, signal: controller.signal, timeoutMs: 20_000, quietStdout: true, log: join(root, "command.log"),
      onSpawn: child => {
        owner = child;
        child.stdout.on("data", chunk => {
          observed += chunk;
          if (!ready && observed.includes("descendant ready")) { ready = true; controller.abort(); }
        });
      },
    }), error => {
      assert.equal(error.interrupted, true);
      assert.equal(error.timedOut, false);
      assert.match(error.stdout, /descendant ready/);
      assert.ok(Object.hasOwn(error, "exitCode") && Object.hasOwn(error, "signal"));
      return true;
    });
    assert.equal(ready, true);
    assert.ok(owner.exitCode !== null || owner.signalCode !== null);
    assert.ok(descendantSocket);
    await Promise.race([descendantClosed, cancelWait]);
    assert.equal(descendantSocket.destroyed, true);
    if (process.platform === "win32") {
      const {pid} = JSON.parse(readFileSync(join(root, "descendant.json"), "utf8"));
      assert.throws(() => process.kill(pid, 0), {code: "ESRCH"});
    } else {
      assert.equal(owner.signalCode, "SIGKILL");
      assert.match(readFileSync(join(root, "command.log"), "utf8"), /descendant ignored SIGTERM/);
    }
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
  } finally {
    cleaning = true;
    context.signal.removeEventListener("abort", cancelWaitHandler);
    controller.abort();
    descendantSocket?.end();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

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

function writeWindowsPreload(root) {
  writeFileSync(join(root, "descendant.mjs"), `
    import { writeFileSync } from "node:fs";
    writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }));
    setInterval(() => {}, 1000);
    process.send("ready");
  `);
  const preload = join(root, "preload.cjs");
  writeFileSync(preload, `
    const { spawn } = require("node:child_process");
    const { appendFileSync } = require("node:fs");
    appendFileSync(${JSON.stringify(join(root, "preloads.jsonl"))}, JSON.stringify({
      pid: process.pid, options: process.env.NODE_OPTIONS, command: process.argv[1],
    }) + "\\n");
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ${JSON.stringify([join(root, "descendant.mjs"), join(root, "descendant.json")])}, {
      env, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.once("message", () => {
      child.disconnect();
      console.log("preload descendant ready");
    });
  `);
  return preload;
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
            timeoutMs:20000,log:join(root,'command.log'),
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
      deadline = setTimeout(() => supervisor.kill("SIGKILL"), 30_000);
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
  skip: process.platform !== "win32", timeout: 30_000,
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
      import { mock } from "node:test";
      import { run } from ${JSON.stringify(new URL("./process.mjs", import.meta.url).href)};
      const root = process.argv[1];
      let owner;
      let stdout = "";
      let expired = false;
      mock.timers.enable({ apis: ["setTimeout"] });
      await assert.rejects(run("cmd.exe", ["/d", "/c", join(root, "leader.cmd")], {
        timeoutMs: 2000, log: join(root, "output.log"),
        onSpawn: child => {
          owner = child;
          writeFileSync(join(root, "owner.json"), JSON.stringify({ pid: child.pid }));
          child.stdout.on("data", chunk => {
            stdout += chunk;
            if (!expired && stdout.includes("descendant ready") && stdout.includes("cmd leader exited")) {
              expired = true;
              assert.equal(owner.exitCode, null);
              assert.equal(owner.signalCode, null);
              mock.timers.tick(2000);
            }
          });
        },
      }), /timed out after 2000ms/);
      assert.equal(expired, true);
      mock.timers.reset();
      assert.ok(owner.exitCode !== null || owner.signalCode !== null);
      assert.match(readFileSync(join(root, "output.log"), "utf8"), /descendant ready/);
      assert.match(readFileSync(join(root, "output.log"), "utf8"), /cmd leader exited/);
      const { pid } = JSON.parse(readFileSync(join(root, "descendant.json"), "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      console.log(JSON.stringify({ ownerPid: owner.pid, descendantPid: pid, closed: true }));
    `, root], { encoding: "utf8", windowsHide: true, timeout: 20_000, killSignal: "SIGKILL" });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"closed":true/);
  } finally {
    stopWindowsDescendant(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows job closes descendants after the command completes normally", {
  skip: process.platform !== "win32", timeout: 30_000,
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
    `], { timeoutMs: 20_000, quietStdout: true });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /descendant ready/);
    const { pid } = JSON.parse(readFileSync(join(root, "descendant.json"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    stopWindowsDescendant(root);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const flag of ["--require", "--import"]) {
  test(`Windows ${flag} preloads run only in the assigned command and their descendants stop on timeout`, {
    skip: process.platform !== "win32", timeout: 30_000,
  }, async (context) => {
    const root = mkdtempSync(join(tmpdir(), "dohc-job-preload-"));
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const expire = () => context.mock.timers.tick(2000);
    context.signal.addEventListener("abort", expire, { once: true });
    try {
      const preload = writeWindowsPreload(root);
      const nodeOptions = `${flag} ${JSON.stringify(flag === "--import" ? pathToFileURL(preload).href : preload)}`;
      const command = join(root, "command.mjs");
      writeFileSync(command, "setInterval(() => {}, 1000);\n");
      const log = join(root, "output.log");
      let stdout = "";
      await assert.rejects(run(process.execPath, [command], {
        env: { ...process.env, NODE_OPTIONS: nodeOptions }, log, timeoutMs: 2000, quietStdout: true,
        onSpawn(child) {
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
            if (stdout.includes("preload descendant ready")) expire();
          });
        },
      }), /timed out after 2000ms/);
      assert.match(readFileSync(log, "utf8"), /preload descendant ready/);
      const preloads = readFileSync(join(root, "preloads.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(preloads.length, 1, "the trusted relay must not execute preloads");
      assert.equal(preloads[0].command, command);
      assert.equal(preloads[0].options, nodeOptions);
      assert.throws(() => process.kill(preloads[0].pid, 0), { code: "ESRCH" });
      const { pid } = JSON.parse(readFileSync(join(root, "descendant.json"), "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      context.signal.removeEventListener("abort", expire);
      stopWindowsDescendant(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const waitForRelay of [false, true]) {
  test(`Windows job closes the relay without launching commands or preloads when assignment fails${waitForRelay ? " after relay startup" : ""}`, {
    skip: process.platform !== "win32", timeout: 30_000,
  }, () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-job-assignment-"));
    try {
      const helper = readFileSync(new URL("./windows-job.ps1", import.meta.url), "utf8");
      const invalidHandle = helper.replace("AssignProcessToJobObject(job, child.Handle)", "AssignProcessToJobObject(job, IntPtr.Zero)");
      assert.notEqual(invalidHandle, helper);
      const script = join(root, "invalid-job.ps1");
      const relayPid = join(root, "relay.pid");
      const recordedChild = invalidHandle.replace("using (var child = Process.Start(start)) {", `using (var child = Process.Start(start)) {
        System.IO.File.WriteAllText(@"${relayPid.replaceAll('"', '""')}", child.Id.ToString());
        ${waitForRelay ? "child.StandardInput.Close(); child.WaitForExit();" : ""}`);
      assert.notEqual(recordedChild, invalidHandle);
      writeFileSync(script, recordedChild);
      const marker = join(root, "command-ran");
      const preload = writeWindowsPreload(root);
      const payload = Buffer.from(JSON.stringify({ command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] })).toString("base64");
      const quote = (value) => `'${value.replaceAll("'", "''")}'`;
      const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(script)}))) ${[
          process.execPath, fileURLToPath(new URL("./windows-command.mjs", import.meta.url)), payload,
        ].map(quote).join(" ")}`], {
        env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
        encoding: "utf8", windowsHide: true, timeout: 20_000,
      });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Win32Exception/);
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(join(root, "preloads.jsonl")), false, "preloads must not run even if the relay starts before assignment fails");
      assert.throws(() => process.kill(Number(readFileSync(relayPid, "utf8")), 0), { code: "ESRCH" });
    } finally {
      stopWindowsDescendant(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const input of ["", "invalid payload"]) {
  test(`Windows command relay rejects ${input ? "invalid" : "missing"} authorization`, () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-relay-authorization-"));
    try {
      const marker = join(root, "command-ran");
      const payload = Buffer.from(JSON.stringify({ command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] })).toString("base64");
      // An argv payload must not bypass the job owner's stdin authorization.
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./windows-command.mjs", import.meta.url)), payload], {
        input, encoding: "utf8", windowsHide: true, timeout: 20_000,
      });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(existsSync(marker), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("Windows job preserves arguments, environment, cwd, and unformatted output", {
  skip: process.platform !== "win32", timeout: 30_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-job-quoting-"));
  try {
    const args = ["", "two words", 'a"b', "trailing\\", "雪", "$(not-a-command)", "a'b"];
    const result = await run(process.execPath, ["-e", `
      process.stdout.write(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd(), value: process.env.DOHC_JOB_TEST }));
      process.stderr.write("stderr\\r\\n雪\\u0000tail");
    `, ...args], { cwd: root, env: { ...process.env, DOHC_JOB_TEST: "unchanged 雪" }, timeoutMs: 20_000, quietStdout: true });
    assert.deepEqual(JSON.parse(result.stdout), { args, cwd: root, value: "unchanged 雪" });
    assert.equal(result.stderr, "stderr\r\n雪\u0000tail");
    assert.equal(result.code, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
