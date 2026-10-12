import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProbeProcess } from "../src/agents/agentProbeProcess.ts";
import { resolveSpawnCommand } from "../src/process/windowsSpawn.ts";
import { compileOwner } from "./stage-agent-probe.mjs";

// Liveness is a loopback listener, never a PID. The deadline case waits out
// the probe's five-second budget; every other case waits for a real condition.
const windows = { skip: process.platform !== "win32" || process.arch !== "x64", timeout: 30000 };
const source = name => fileURLToPath(new URL(`../src/agents/${name}`, import.meta.url));
const descendant = `import { createServer } from "node:net"; import { writeFileSync } from "node:fs";
const [marker, mode] = process.argv.slice(2);
const server = createServer(socket => { socket.destroy(); if (mode === "drain") process.stdout.write("drained\\n", () => process.exit(0)); });
server.listen(0, "127.0.0.1", () => {
  writeFileSync(marker, JSON.stringify({ port: server.address().port }));
  if (mode === "flood") process.stdout.write(Buffer.alloc(70 * 1024, 120));
});`;
// Detached keeps the descendant out of the launcher's libuv job; it still holds the inherited pipes.
const launcher = `import { spawn } from "node:child_process"; import { fileURLToPath } from "node:url";
spawn(process.execPath, [fileURLToPath(new URL("./descendant.mjs", import.meta.url
)), ...process.argv.slice(2)],
  { detached: true, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] }).unref();`;

function waitForFile(path) {
  const directory = join(path, "..");
  let watcher;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { watcher.close(); reject(new Error("Fixture readiness timed out.")); }, 20000);
    const read = async () => {
      try { const value = JSON.parse(await readFile(path, "utf8")); clearTimeout(timeout); watcher.close(); resolve(value); }
      catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) { clearTimeout(timeout); watcher.close(); reject(error); } }
    };
    watcher = watch(directory, read); void read();
  });
}
const listening = port => new Promise(resolve => {
  const socket = connect(port, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); }).once("error", () => resolve(false));
});

let setup;
function prepared() {
  setup ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "dohc-agent-probe-test-"));
    const executable = join(directory, "agentProbeOwner.exe");
    await compileOwner([source("agentProbeOwner.cs")], executable);
    await writeFile(join(directory, "descendant.mjs"), descendant);
    await writeFile(join(directory, "launcher.mjs"), launcher);
    // The wrapper prints a version, starts the descendant, marks its own last step, and exits.
    await writeFile(join(directory, "probe.cmd"), ["@echo off", "echo probe 1.2.3",
      `"${process.execPath}" "${join(directory, "launcher.mjs")}" %*`, 'echo {}> "%~1.wrapper"', "exit /b 0", ""].join("\r\n"));
    // Unrelated control: a process this test owns, outside every probe.
    const sleeperMarker = join(directory, "sleeper.json");
    const sleeper = spawn(process.execPath, [join(directory, "descendant.mjs"), sleeperMarker, "hold"], { windowsHide: true, stdio: "ignore" });
    const { port } = await waitForFile(sleeperMarker);
    return { directory, sleeper: { child: sleeper, port },
      owner: { root: directory, executable, relay: source("agentProbeRelay.mjs"), node: process.execPath } };
  })();
  return setup;
}
after(async () => {
  if (!setup) return;
  const { directory, sleeper } = await setup;
  if (sleeper.child.exitCode === null) { const closed = once(sleeper.child, "close"); sleeper.child.kill(); await closed; }
  await rm(directory, { recursive: true, force: true });
});

function probe(context, name, mode, signal = new AbortController().signal) {
  const marker = join(context.directory, `${name}.json`);
  const command = resolveSpawnCommand(join(context.directory, "probe.cmd"), [marker, mode], { cwd: homedir() });
  return { marker, running: runProbeProcess(command, signal, context.owner) };
}
const admission = (context, marker) => Buffer.from(JSON.stringify({
  ...resolveSpawnCommand(join(context.directory, "probe.cmd"), [marker, "hold"], { cwd: homedir() }), cwd: homedir(), env: process.env,
}));
function startOwner(context, args) {
  const child = spawn(context.owner.executable, args, { cwd: context.owner.root, env: { SystemRoot: process.env.SystemRoot }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const output = { stdout: [], stderr: [] };
  child.stdout.on("data", chunk => output.stdout.push(chunk)); child.stderr.on("data", chunk => output.stderr.push(chunk));
  child.stdin.on("error", () => {});
  const closed = once(child, "close").then(([code]) => ({ code, stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString() }));
  return { child, closed };
}

test("cancelling a probe ends a descendant that holds its pipes after the wrapper exits", windows, async () => {
  const context = await prepared();
  const controller = new AbortController(), reason = new Error("cancelled");
  const { marker, running } = probe(context, "cancel", "hold", controller.signal);
  const { port } = await waitForFile(marker);
  await waitForFile(`${marker}.wrapper`);
  assert.equal(await listening(port), true);
  controller.abort(reason);
  await assert.rejects(running, error => error === reason);
  assert.equal(await listening(port), false);
  assert.equal(await listening(context.sleeper.port), true);
});

test("the deadline ends a descendant that holds the pipes and keeps the partial output", windows, async () => {
  const context = await prepared();
  const started = performance.now();
  const { marker, running } = probe(context, "deadline", "hold");
  const result = await running;
  assert.ok(performance.now() - started >= 4_990);
  assert.equal(result.exitCode, null);
  assert.match(result.stdout, /probe 1\.2\.3/);
  const { port } = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(await listening(port), false);
  assert.equal(await listening(context.sleeper.port), true);
});

test("a descendant that releases the pipes lets the probe finish with the wrapper's code", windows, async () => {
  const context = await prepared();
  const { marker, running } = probe(context, "drain", "drain");
  await waitForFile(`${marker}.wrapper`);
  const { port } = await waitForFile(marker);
  assert.equal(await listening(port), true); // Connecting releases the descendant.
  const result = await running;
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /probe 1\.2\.3[\s\S]*drained/);
  assert.equal(await listening(context.sleeper.port), true);
});

test("output past the limit stops the probe and ends its descendants", windows, async () => {
  const context = await prepared();
  const { marker, running } = probe(context, "flood", "flood");
  const result = await running;
  assert.equal(result.exitCode, null);
  assert.ok(result.stdout.length + result.stderr.length > 64 * 1024);
  const { port } = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(await listening(port), false);
  assert.equal(await listening(context.sleeper.port), true);
});

test("a cancelled signal starts no owner", windows, async () => {
  const context = await prepared();
  const reason = new Error("cancelled");
  const { marker, running } = probe(context, "pre-cancelled", "hold", AbortSignal.abort(reason));
  await assert.rejects(running, error => error === reason);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("an owner that receives a short admission exits before starting anything", windows, async () => {
  const context = await prepared();
  const marker = join(context.directory, "short.json");
  const bytes = admission(context, marker);
  const owner = startOwner(context, [context.owner.node, context.owner.relay, String(bytes.byteLength)]);
  owner.child.stdin.end(bytes.subarray(0, bytes.byteLength >> 1));
  const result = await owner.closed;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /admission ended early/);
  assert.equal(result.stdout, "");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("malformed owner arguments and relay admissions start no command", windows, async () => {
  const context = await prepared();
  const { node, relay } = context.owner;
  for (const args of [[], [node, relay], [node, relay, "0"], [node, relay, "nope"], [node, relay, String(16 * 1024 * 1024 + 1)]]) {
    const owner = startOwner(context, args);
    owner.child.stdin.end();
    const result = await owner.closed;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid agent probe arguments/);
  }
  const bad = Buffer.from(JSON.stringify({ command: 1 }));
  const owner = startOwner(context, [node, relay, String(bad.byteLength)]);
  owner.child.stdin.write(bad);
  const result = await owner.closed;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid agent probe admission/);
});

// Kill-on-close starts when the owner dies, but nothing orders the caller's
// close after that termination, so this waits for the descendant to stop.
test("an owner killed mid-probe ends its job through kill-on-close", windows, async () => {
  const context = await prepared();
  const marker = join(context.directory, "owner-killed.json");
  const bytes = admission(context, marker);
  const owner = startOwner(context, [context.owner.node, context.owner.relay, String(bytes.byteLength)]);
  owner.child.stdin.write(bytes);
  const { port } = await waitForFile(marker);
  owner.child.kill();
  await owner.closed;
  while (await listening(port)) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await listening(context.sleeper.port), true);
});
