import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";
import { SOCKET_PATH_BYTES, makeDebugHome, removeDebugHome } from "./debug-home.mjs";

if (process.argv[2] === "fixture") {
  const root = process.argv[3];
  const signal = process.argv[4];
  const phase = process.argv[5];
  const probe = process.argv[6];
  const hold = async (at) => {
    if (at !== phase) return;
    const released = new Promise((resolve) => process.once("message", resolve));
    process.send({ phase: at, listeners: process.listenerCount(signal) });
    await released;
  };
  globalThis.debugFixtureHold = hold;
  if (process.platform === "win32") process.on("message", (message) => {
    if (message === "signal") process.emit(signal); // Windows has no POSIX signal delivery.
  });
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "../../apps/desktop/src/shutdownBudgets.ts") {
        return { url: new URL(specifier, import.meta.url).href, shortCircuit: true };
      }
      if (specifier === "node:fs/promises" && context.parentURL?.endsWith("/debug.mjs")) {
        return { url: pathToFileURL(join(root, "fs-adapter.mjs")).href, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  const child = spawn(process.execPath, ["-e", `
    const { writeFileSync } = require('node:fs');
    process.on('disconnect', () => { writeFileSync(process.argv[1], 'supervisor disconnected'); process.exit(0); });
    process.on('message', () => process.exit(0));
    process.send('ready');
  `, join(root, "child-disconnected")], { detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  await new Promise((resolve) => child.once("message", resolve));
  process.send({ phase: "launched", pid: child.pid });
  const childClosed = new Promise((resolve) => child.once("close", resolve));
  const app = new EventEmitter();
  const page = new EventEmitter();
  page.screenshot = async () => hold("cleanup");
  if (probe === "utf8") Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() });
  app.process = () => child;
  app.firstWindow = async () => {
    if (probe === "utf8") {
      const ended = Promise.all([once(child.stdout, "end"), once(child.stderr, "end")]);
      const stdout = Buffer.from("stdout café 😀");
      const stderr = Buffer.from("stderr 東京 🧪");
      for (let index = 0; index < Math.max(stdout.length, stderr.length); index++) {
        if (index < stdout.length) child.stdout.write(stdout.subarray(index, index + 1));
        if (index < stderr.length) child.stderr.write(stderr.subarray(index, index + 1));
      }
      child.stdout.end(Buffer.from([0xe2, 0x82]));
      child.stderr.end();
      await ended;
    }
    return page;
  };
  app.windows = () => [page];
  app.context = () => ({ tracing: { start: async () => {}, stop: async () => {} } });
  app.evaluate = async (fn) => String(fn).includes("debugPort") ? 1234 : child.pid;
  app.close = async () => {
    child.send("close");
    await childClosed;
    writeFileSync(join(root, "app-closed"), "owned fixture child exited");
    app.emit("close");
  };
  globalThis.debugFixtureElectron = { launch: async (options) => {
    // Playwright's Electron launcher handles SIGINT for the app's life: it closes the app, then calls process.exit(130).
    if (phase === "playwright") { process.once("SIGINT", () => process.exit(130)); await hold("playwright"); }
    else await hold("launch");
    assert.ok(options.args.includes("--dohc-isolated-test"), "debug must preserve the installed protocol handler");
    const profile = options.args.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
    assert.ok(isAbsolute(profile), "debug needs an absolute isolated profile");
    writeFileSync(join(profile, "DevToolsActivePort"), "1235\n");
    return app;
  } };
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://fixture" }] });
  globalThis.WebSocket = class extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(text) {
      const expression = JSON.parse(text).params.expression;
      const value = expression === "process.pid" ? (probe === "fail" ? -1 : child.pid) : "object";
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: 1, result: { result: { value } } }) })));
    }
    close() {}
  };
  const log = console.log;
  console.log = (...args) => {
    log(...args);
    if (String(args[0]).startsWith("Close the debug app")) process.send({ phase: "ready" });
  };
  if (probe !== "none") process.argv.push("--probe");
  try { await import(pathToFileURL(join(root, "debug.mjs")).href); }
  finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await childClosed; }
    writeFileSync(join(root, "outcome.json"), JSON.stringify({ listeners: [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")] }));
    process.disconnect();
  }
} else {
  async function fixture(t, { signal = "SIGINT", phase = "none", probe = "none" }) {
    const root = mkdtempSync(join(tmpdir(), "dohc-debug-test-"));
    // Run the actual launcher and close helper. Only build, Git and Electron/debugger I/O are adapters.
    for (const file of ["debug.mjs", "debug-home.mjs", "close-electron.mjs", "desktop-close-policy.mjs"]) copyFileSync(join(import.meta.dirname, file), join(root, file));
    writeFileSync(join(root, "build.mjs"), `export async function prepare() {}\nexport function assertPrepared() { return { desktop: { commit: 'earlier-build-head' } }; }`);
    writeFileSync(join(root, "process.mjs"), `import assert from 'node:assert/strict'; export const repoRoot = import.meta.dirname; export function git(args) { assert.deepEqual(args, ['rev-parse', 'HEAD']); return 'current-checkout-head'; }`);
    writeFileSync(join(root, "fs-adapter.mjs"), `export { readFile } from 'node:fs/promises'; import { mkdir as make, writeFile as write } from 'node:fs/promises'; export async function mkdir(path, ...args) { if (String(path).endsWith('workspace')) await globalThis.debugFixtureHold('startup'); return make(path, ...args); } export async function writeFile(path, ...args) { if (String(path).endsWith('desktop.jsonl')) await globalThis.debugFixtureHold('evidence'); return write(path, ...args); }`);
    for (const [name, source] of [["playwright", "module.exports = { _electron: globalThis.debugFixtureElectron };"], ["electron", "module.exports = 'fixture-electron';"]]) {
      const directory = join(root, "node_modules", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "index.js"), source);
    }
    const links = () => new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("dohc-debug-home-")));
    const linksBefore = links();
    const child = spawn(process.execPath, [import.meta.filename, "fixture", root, signal, phase, probe], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    let protectedCleanup;
    let launcherPid;
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const interrupt = () => process.platform === "win32" ? child.send("signal") : child.kill(signal);
    child.on("message", (message) => {
      if (message.phase === "launched") launcherPid = message.pid;
      if (message.phase === "ready" && probe === "none") interrupt();
      if (message.phase === phase) {
        protectedCleanup = message.listeners > 0;
        interrupt();
        child.send("release");
      }
    });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, exitSignal) => resolve({ code, exitSignal }));
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const result = await closed;
      t.diagnostic(JSON.stringify({ ...result, supervisorPid: child.pid, launcherPid, phase, protectedCleanup, appClosed: existsSync(join(root, "app-closed")), supervisorDisconnected: existsSync(join(root, "child-disconnected")) }));
      if (phase === "startup" || phase === "playwright") {
        // A signal that ends the launcher before its cleanup runs leaves no link to the session's home.
        assert.equal(result.code, signal === "SIGTERM" ? 143 : 130, output);
        assert.equal(protectedCleanup, true, "the launcher listens for the signal during startup");
        assert.deepEqual([...links()].filter((name) => !linksBefore.has(name)), [], "no link to the session's home remains");
        return;
      }
      assert.equal(result.exitSignal, null, output);
      assert.equal(result.code, probe === "fail" ? 1 : 0, output);
      if (phase !== "none") assert.equal(protectedCleanup, true, "signal handlers must remain through cleanup and evidence writes");
      assert.ok(existsSync(join(root, "app-closed")), "actual close helper must close its retained child");
      const match = output.match(/\[debug\] Evidence retained at (.+)/);
      assert.ok(match, output);
      const directory = match[1].trim();
      assert.ok(existsSync(join(directory, "desktop.jsonl")));
      assert.deepEqual(JSON.parse(readFileSync(join(root, "outcome.json"), "utf8")).listeners, [0, 0]);
      const instance = JSON.parse(readFileSync(join(directory, "instance.json"), "utf8"));
      assert.equal(instance.commit, "current-checkout-head", "launch provenance must not reuse the build commit");
      assert.equal(instance.homeFiles, join(directory, "home"));
      assert.ok(existsSync(instance.homeFiles), "the home's files stay with the evidence");
      if (process.platform === "win32") assert.equal(instance.home, instance.homeFiles);
      else {
        assert.ok(!instance.home.startsWith(directory), "a Mac or Linux session gives the app a short link in the temp folder");
        assert.equal(existsSync(instance.home), false, "the session removes the link");
      }
      assert.equal(instance.build.desktop.commit, "earlier-build-head");
      if (probe === "utf8") {
        const logs = readFileSync(join(directory, "desktop.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        const text = (source) => logs.filter((entry) => entry.source === source).map((entry) => entry.text).join("");
        assert.equal(text("main.stdout"), "stdout café 😀�");
        assert.equal(text("main.stderr"), "stderr 東京 🧪");
      }
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
      rmSync(root, { recursive: true, force: true });
    }
  }
  if (process.platform !== "win32") for (const signal of ["SIGINT", "SIGTERM"]) {
    test(`debug ${signal} during startup leaves no link to the session's home`, { timeout: 30_000 }, async (t) => fixture(t, { signal, phase: "startup" }));
    test(`debug ${signal} during launch closes the app, keeps the evidence and removes the link`, { timeout: 30_000 }, async (t) => fixture(t, { signal, phase: "launch" }));
  }
  if (process.platform !== "win32") {
    test("debug SIGINT under Playwright's own handler leaves no link to the session's home", { timeout: 30_000 }, async (t) => fixture(t, { signal: "SIGINT", phase: "playwright" }));
  }
  for (const signal of ["SIGINT", "SIGTERM"]) for (const phase of ["cleanup", "evidence"]) {
    test(`debug repeated ${signal} during ${phase} (${process.platform === "win32" ? "synthetic Windows events" : "native POSIX signals"})`, { timeout: 30_000 }, async (t) => fixture(t, { signal, phase }));
  }
  for (const probe of ["pass", "fail"]) {
    test(`debug probe ${probe} retains cleanup and separate launch provenance`, { timeout: 30_000 }, async (t) => fixture(t, { probe }));
  }
  test("a debug session's home has a short link on macOS and Linux, and Windows uses the folder itself", () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-debug-test-"));
    try {
      const directory = join(root, ".agent-artifacts", "debug", "0".repeat(36));
      for (const [platform, limit] of Object.entries(SOCKET_PATH_BYTES)) {
        const session = makeDebugHome(directory, platform);
        try {
          assert.equal(session.files, join(directory, "home"));
          const socket = join(session.home, "dohc-cli.sock");
          assert.ok(Buffer.byteLength(socket) <= limit, `${socket} is ${Buffer.byteLength(socket)} bytes, over ${platform}'s ${limit}`);
          assert.equal(realpathSync(session.home), realpathSync(session.files), "the link leads to the session's files");
        } finally { removeDebugHome(session); }
        assert.equal(existsSync(session.link), false, "removing the home removes the link");
        assert.ok(existsSync(session.files), "and keeps the files");
      }
      // A temp folder too long for the socket falls back to /tmp.
      const fallback = makeDebugHome(directory, "darwin", join(root, "t".repeat(80)));
      try { assert.ok(fallback.link.startsWith("/tmp/dohc-debug-home-"), fallback.link); } finally { removeDebugHome(fallback); }
      assert.deepEqual(makeDebugHome(directory, "win32"), { files: join(directory, "home"), home: join(directory, "home"), link: null });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("debug evidence preserves split UTF8 in independent streams and flushes an incomplete final character", { timeout: 30_000 }, async (t) => fixture(t, { probe: "utf8" }));
}
