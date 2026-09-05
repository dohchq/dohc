import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { prepare, assertPrepared } from "./build.mjs";
import { repoRoot } from "./process.mjs";

const require = createRequire(join(repoRoot, "apps/desktop/package.json"));
const { _electron: electron } = require("playwright");
const directory = join(repoRoot, ".agent-artifacts/debug", randomUUID());
const profile = join(directory, "profile");
const home = join(directory, "home");
const workspace = join(directory, "workspace");
let app;
const logs = [];
try {
  await prepare();
  for (const path of [profile, home, workspace]) await mkdir(path, { recursive: true });
  await writeFile(join(workspace, "debug.md"), "# Debug workspace\n\nThis workspace belongs to this debug session.\n");
  const env = { ...process.env, DOHC_DESKTOP_TEST: "1", DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: workspace };
  if (process.argv.includes("--native-dialogs")) delete env.DOHC_TEST_PICK_PATH;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require("electron"), cwd: join(repoRoot, "apps/desktop"),
    args: [`--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", join(repoRoot, "apps/desktop/dist/main/main.js")], env, artifactsDir: directory });
  const record = (source, text) => logs.push({ at: new Date().toISOString(), source, text: String(text) });
  app.process().stdout?.on("data", (text) => record("main.stdout", text));
  app.process().stderr?.on("data", (text) => record("main.stderr", text));
  const page = await app.firstWindow();
  page.on("console", (entry) => record(`renderer.${entry.type()}`, entry.text()));
  page.on("pageerror", (error) => record("renderer.error", error.message));
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  const mainPort = await app.evaluate(() => process.debugPort);
  const rendererPort = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0];
  const instance = { root: repoRoot, supervisorPid: process.pid, electronPid: app.process().pid, workspace, profile, home,
    mainInspector: `http://127.0.0.1:${mainPort}/json/list`, rendererInspector: `http://127.0.0.1:${rendererPort}/json/list`, build: assertPrepared(), directory };
  for (const address of [instance.mainInspector, instance.rendererInspector]) {
    const response = await fetch(address, { signal: AbortSignal.timeout(5000) });
    if (!response.ok || !(await response.json()).some((target) => target.webSocketDebuggerUrl)) throw new Error(`Debugger endpoint is unavailable: ${address}`);
  }
  await writeFile(join(directory, "instance.json"), JSON.stringify(instance, null, 2) + "\n");
  console.log(JSON.stringify(instance, null, 2));
  console.log("Close the debug app or press Ctrl+C to stop this session and save its evidence.");
  await new Promise((done) => {
    const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); done(); };
    app.once("close", stop); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    if (process.argv.includes("--probe")) stop();
  });
} catch (error) { console.error(error.message); logs.push({ source: "launcher", text: String(error) }); process.exitCode = 1; }
finally {
  if (app) {
    for (const page of app.windows()) await page.screenshot({ path: join(directory, "last-screen.png"), timeout: 5000 }).catch(() => undefined);
    await app.context().tracing.stop({ path: join(directory, "trace.zip") }).catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "desktop.jsonl"), logs.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  console.log(`[debug] Evidence retained at ${directory}`);
}
