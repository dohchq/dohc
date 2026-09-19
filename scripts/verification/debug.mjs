import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { prepare, assertPrepared } from "./build.mjs";
import { git, repoRoot } from "./process.mjs";
import { closeDebugApplication } from "./close-electron.mjs";

async function evaluateDebugger(url, expression) {
  const socket = new WebSocket(url);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Debugger evaluation timed out: ${url}`)), 5000);
      socket.addEventListener("error", () => reject(new Error(`Debugger connection failed: ${url}`)), { once: true });
      socket.addEventListener("close", () => reject(new Error(`Debugger connection closed: ${url}`)), { once: true });
      socket.addEventListener("open", () => {
        try {
          socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
        } catch (error) { reject(error); }
      }, { once: true });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.id !== 1) return;
          if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)));
          else resolve(message.result.result.value);
        } catch (error) { reject(error); }
      });
    });
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}

const require = createRequire(join(repoRoot, "apps/desktop/package.json"));
const { _electron: electron } = require("playwright");
const directory = join(repoRoot, ".agent-artifacts/debug", randomUUID());
const profile = join(directory, "profile");
const home = join(directory, "home");
const workspace = join(directory, "workspace");
let app;
let processHandle;
let stop;
const logs = [];
try {
  await prepare();
  for (const path of [profile, home, workspace]) await mkdir(path, { recursive: true });
  await writeFile(join(workspace, "debug.md"), "# Debug workspace\n\nThis workspace belongs to this debug session.\n");
  const env = { ...process.env, DOHC_DESKTOP_TEST: "1", DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: workspace };
  if (process.argv.includes("--native-dialogs")) delete env.DOHC_TEST_PICK_PATH;
  delete env.ELECTRON_RUN_AS_NODE;
  const commit = git(["rev-parse", "HEAD"]);
  app = await electron.launch({ executablePath: require("electron"), cwd: join(repoRoot, "apps/desktop"),
    args: [`--user-data-dir=${profile}`, "--dohc-isolated-test", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", join(repoRoot, "apps/desktop/dist/main/main.js")], env, artifactsDir: directory });
  processHandle = app.process();
  const stopped = new Promise((done) => {
    stop = () => {
      app.off("close", stop); processHandle.off("exit", stop);
      done();
    };
    app.once("close", stop); processHandle.once("exit", stop);
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) stop();
  });
  const record = (source, text) => logs.push({ at: new Date().toISOString(), source, text: String(text) });
  app.process().stdout?.setEncoding("utf8").on("data", (text) => record("main.stdout", text));
  app.process().stderr?.setEncoding("utf8").on("data", (text) => record("main.stderr", text));
  const page = await app.firstWindow();
  page.on("console", (entry) => record(`renderer.${entry.type()}`, entry.text()));
  page.on("pageerror", (error) => record("renderer.error", error.message));
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  const mainPort = await app.evaluate(() => process.debugPort);
  const rendererPort = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
  const instance = { root: repoRoot, commit, supervisorPid: process.pid, launcherPid: app.process().pid,
    electronPid: await app.evaluate(() => process.pid), workspace, profile, home,
    mainInspector: `http://127.0.0.1:${mainPort}/json/list`, rendererInspector: `http://127.0.0.1:${rendererPort}/json/list`, build: assertPrepared(), directory };
  const debuggerTargets = {};
  for (const [kind, address] of [["main", instance.mainInspector], ["renderer", instance.rendererInspector]]) {
    const response = await fetch(address, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Debugger endpoint is unavailable: ${address}`);
    const target = (await response.json()).find((target) => target.webSocketDebuggerUrl && (kind === "main" || target.type === "page"));
    if (!target) throw new Error(`Debugger endpoint is unavailable: ${address}`);
    debuggerTargets[kind] = target.webSocketDebuggerUrl;
  }
  await writeFile(join(directory, "instance.json"), JSON.stringify(instance, null, 2) + "\n");
  console.log(JSON.stringify(instance, null, 2));
  if (process.argv.includes("--probe")) {
    assert.equal(await evaluateDebugger(debuggerTargets.main, "process.pid"), instance.electronPid);
    assert.equal(await evaluateDebugger(debuggerTargets.renderer, "typeof document"), "object");
    console.log("[debug] Independent debugger connections verified the Electron PID and renderer context.");
  }
  console.log("Close the debug app or press Ctrl+C to stop this session and save its evidence.");
  if (process.argv.includes("--probe")) stop();
  await stopped;
} catch (error) { console.error(error.message); logs.push({ source: "launcher", text: String(error) }); process.exitCode = 1; }
finally {
  stop?.();
  try {
    if (app && processHandle) await closeDebugApplication(app, processHandle, directory);
  } catch (error) {
    console.error(error.message);
    logs.push({ source: "cleanup", text: String(error) });
    process.exitCode = 1;
  } finally {
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "desktop.jsonl"), logs.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      console.log(`[debug] Evidence retained at ${directory}`);
    } finally {
      if (stop) { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
    }
  }
}
