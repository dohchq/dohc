import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MANIFEST_SCHEMA, NO_UPDATE_FEED, hashTree, launchPreview, previewArgs, previewEnvironment, previewPaths,
  readManifest, startNoUpdateFeed, verifyDelivery } from "./preview-launch.mjs";
import { checkSmoke, engineBuildEnvironment, packagingEnvironment, parseArgs, requirePinnedSource, signingStatus, TRY_IT_COMMAND } from "./preview.mjs";
import { resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";

const sha = "a".repeat(40);
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dohc-preview-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function until(predicate) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("The fake app did not produce its evidence.");
    await new Promise((done) => setTimeout(done, 20));
  }
}

// A delivery folder whose "app" is a script the test runs with Node.
async function delivery(t, { smoke = "passed" } = {}) {
  const root = scratch(t);
  const app = join(root, "app");
  mkdirSync(join(app, "resources"), { recursive: true });
  writeFileSync(join(app, "dohc.exe"), "fake app");
  writeFileSync(join(app, "resources/app.asar"), "fake asar");
  const tree = await hashTree(app);
  const manifest = { schema: MANIFEST_SCHEMA, source: { commit: sha, pr: 7 },
    package: { directory: "app", executable: "dohc.exe", files: tree.files, treeSha256: tree.sha256 },
    smoke: { status: smoke, packageTreeSha256: tree.sha256 } };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  return { root, app, manifest };
}

test("the package tree hash names every file's path and bytes", async (t) => {
  const { app } = await delivery(t);
  const first = await hashTree(app);
  assert.deepEqual(await hashTree(app), first);
  writeFileSync(join(app, "dohc.exe"), "fake apq");
  assert.notEqual((await hashTree(app)).sha256, first.sha256);
});

for (const [name, tamper] of [
  ["a changed file", (app) => writeFileSync(join(app, "resources/app.asar"), "changed")],
  ["an added file", (app) => writeFileSync(join(app, "resources/extra.dll"), "")],
  ["a removed file", (app) => rmSync(join(app, "resources/app.asar"))],
]) {
  test(`the launcher refuses a package with ${name}`, async (t) => {
    const { root, app } = await delivery(t);
    await verifyDelivery(root);
    tamper(app);
    await assert.rejects(verifyDelivery(root), /differs from its manifest/u);
  });
}

test("the launcher refuses a package whose smoke did not pass", async (t) => {
  const { root } = await delivery(t, { smoke: "failed" });
  await assert.rejects(verifyDelivery(root), /smoke is failed/u);
});

test("the launcher command reports an abnormal app exit as a failure", { skip: process.platform !== "win32" }, async (t) => {
  const { root, app, manifest } = await delivery(t);
  // Node rejects the app's Electron flags and exits nonzero without opening a window.
  copyFileSync(process.execPath, join(app, "dohc.exe"));
  const tree = await hashTree(app);
  Object.assign(manifest.package, { files: tree.files, treeSha256: tree.sha256 });
  manifest.smoke.packageTreeSha256 = tree.sha256;
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  copyFileSync(new URL("./preview-launch.mjs", import.meta.url), join(root, "launch.mjs"));
  const result = spawnSync(process.execPath, [join(root, "launch.mjs")], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.match(result.stdout, /The preview ended \(exit [1-9]\d*\)/u);
  assert.notEqual(result.status, 0, "Try it.cmd must keep the failure message visible.");
  assert.equal(existsSync(previewPaths(root).session), false);
});

test("the manifest must name a full commit and an executable inside the package", async (t) => {
  const { root, manifest } = await delivery(t);
  for (const change of [{ source: { commit: "abc123" } }, { package: { ...manifest.package, executable: "../evil.exe" } },
    { package: { ...manifest.package, executable: "C:\\Windows\\notepad.exe" } }, { schema: 99 }]) {
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ ...manifest, ...change }));
    assert.throws(() => readManifest(root));
  }
});

test("the preview's environment separates the installed app's data and agent configuration files", () => {
  const paths = previewPaths("C:\\previews\\one");
  const env = previewEnvironment({ PATH: "bin", HOME: "C:\\Users\\me", USERPROFILE: "C:\\Users\\me", APPDATA: "C:\\Users\\me\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\me", DOHC_TEST_HOME: "x", dohc_update_url: "https://example.com",
    CLAUDE_CONFIG_DIR: "c", CODEX_HOME: "c", XDG_CONFIG_HOME: "c", NODE_OPTIONS: "--inspect", ELECTRON_RUN_AS_NODE: "1" }, paths, "http://127.0.0.1:9");
  assert.deepEqual(env, { PATH: "bin", HOME: paths.home, USERPROFILE: paths.home, APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData, DOHC_UPDATE_URL: "http://127.0.0.1:9" });
  for (const path of [paths.home, paths.appData, paths.localAppData, paths.profile]) assert.ok(path.startsWith(paths.data));
  assert.deepEqual(previewArgs(paths), [`--user-data-dir=${paths.profile}`, "--dohc-isolated-test", "--enable-logging"]);
});

test("the update feed listens on loopback and offers nothing to install", async (t) => {
  const feed = await startNoUpdateFeed();
  t.after(feed.close);
  assert.match(feed.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
  const response = await fetch(`${feed.url}/latest.yml`);
  assert.equal(await response.text(), NO_UPDATE_FEED);
  assert.match(NO_UPDATE_FEED, /^version: 0\.0\.0\nfiles: \[\]\n/u);
  assert.deepEqual(feed.requests.map((request) => request.url), ["/latest.yml"]);
});

// The fake app records what it received and asks the feed for an update, as
// the packaged updater does, then waits to be closed.
const fakeApp = `
const { writeFileSync } = require("node:fs");
const [record] = process.argv.slice(-1);
fetch(process.env.DOHC_UPDATE_URL + "/latest.yml").then(r => r.text()).then(feed => {
  console.log("fixture-running");
  writeFileSync(record, JSON.stringify({ args: process.argv.slice(2, -1), env: process.env, feed }));
});
process.on("message", message => {
  if (message === "ping") process.send("pong");
  if (message === "quit") process.exit(0);
});
setInterval(() => {}, 1000);
`;

test("the launcher keeps the app open after cancellation until it quits itself", { timeout: 10_000 }, async (t) => {
  const { root } = await delivery(t);
  const script = join(root, "fake-app.cjs"), record = join(root, "record.json");
  writeFileSync(script, fakeApp);
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => bystander.kill());
  const controller = new AbortController();
  let spawned;
  const running = launchPreview(root, { signal: controller.signal, log: () => {}, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DOHC_TEST_HOME: "x" },
    spawnApp: (executable, args, options) => {
      assert.equal(executable, join(root, "app", "dohc.exe"));
      assert.equal(options.windowsHide, false, "Windows must show the preview's GUI on its first launch.");
      spawned = spawn(process.execPath, [script, ...args, record], {
        ...options, windowsHide: true, stdio: [...options.stdio, "ipc"],
      });
      return spawned;
    } });
  try {
    await until(() => existsSync(record));
    const paths = previewPaths(root);
    const session = JSON.parse(readFileSync(paths.session, "utf8"));
    assert.equal(session.appPid, spawned.pid);
    assert.equal(session.launcherPid, process.pid);
    await until(() => existsSync(session.log) && readFileSync(session.log, "utf8").includes("fixture-running"));
    await assert.rejects(launchPreview(root, { log: () => {} }), /already running/u);
    const seen = JSON.parse(readFileSync(record, "utf8"));
    assert.deepEqual(seen.args, previewArgs(paths));
    assert.equal(seen.feed, NO_UPDATE_FEED);
    assert.equal(seen.env.USERPROFILE, paths.home);
    assert.equal(seen.env.DOHC_TEST_HOME, undefined);
    controller.abort();
    const reply = new Promise((resolve, reject) => {
      spawned.once("message", resolve);
      spawned.send("ping", error => { if (error) reject(error); });
    });
    assert.equal(await reply, "pong", "The app must still be able to protect unsaved work.");
    assert.equal(spawned.exitCode, null);
    spawned.send("quit");
    const result = await running;
    assert.equal(result.code, 0);
    assert.equal(bystander.exitCode, null, "an unrelated process keeps running");
    assert.equal(existsSync(paths.session), false);
    assert.equal(result.feedRequests.length, 1);
    await assert.rejects(fetch(session.feed), "the feed stops with the launcher");
  } finally {
    if (spawned?.exitCode === null && spawned.signalCode === null) spawned.kill();
    await running;
  }
});

test("the app can still write its log after the launcher closes", { timeout: 10_000 }, async (t) => {
  const { root } = await delivery(t);
  const record = join(root, "app.json");
  const script = join(root, "app.cjs");
  writeFileSync(script, `
    const { createServer } = require("node:http");
    const { writeFileSync } = require("node:fs");
    const server = createServer((request, response) => {
      console.log("app log after launcher exit");
      response.end("running");
      if (request.url === "/quit") server.close(() => process.exit(0));
    });
    server.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, port: server.address().port })));
  `);
  const driver = join(root, "driver.mjs");
  writeFileSync(driver, `
    import { spawn } from "node:child_process";
    import { launchPreview } from ${JSON.stringify(new URL("./preview-launch.mjs", import.meta.url).href)};
    await launchPreview(${JSON.stringify(root)}, { log: () => {}, spawnApp: (_executable, _args, options) =>
      spawn(process.execPath, [${JSON.stringify(script)}, ${JSON.stringify(record)}], options) });
  `);
  const launcher = spawn(process.execPath, [driver], { stdio: "ignore", windowsHide: true });
  let app;
  try {
    await until(() => existsSync(record));
    app = JSON.parse(readFileSync(record, "utf8"));
    const session = JSON.parse(readFileSync(previewPaths(root).session, "utf8"));
    const closed = new Promise(resolve => launcher.once("close", resolve));
    launcher.kill();
    await closed;
    assert.equal(await (await fetch(`http://127.0.0.1:${app.port}`)).text(), "running");
    assert.match(readFileSync(session.log, "utf8"), /app log after launcher exit/u);
    await fetch(`http://127.0.0.1:${app.port}/quit`);
    await until(() => { try { process.kill(app.pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } });
    app = undefined;
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
    if (app) { try { process.kill(app.pid); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  }
});

test("the launcher finishes when the app exits but a descendant keeps its log open", { skip: process.platform !== "win32", timeout: 10_000 }, async (t) => {
  const { root } = await delivery(t);
  const record = join(root, "descendant.pid");
  const script = join(root, "descendant.cjs");
  writeFileSync(script, 'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 5000);');
  let descendantPid;
  const started = Date.now();
  try {
    const result = await launchPreview(root, { log: () => {}, spawnApp: (_executable, _args, options) => {
      const child = spawn(process.env.ComSpec, ["/d", "/q"], {
        ...options, windowsHide: true, stdio: ["pipe", options.stdio[1], options.stdio[2]],
      });
      child.stdin.end(`@echo off\r\nstart "" /b "${process.execPath}" "${script}" "${record}"\r\nexit\r\n`);
      return child;
    } });
    assert.equal(result.code, 0);
    assert.ok(Date.now() - started < 3_000, "The launcher must not wait for the descendant's five-second exit.");
    await until(() => existsSync(record));
    descendantPid = Number(readFileSync(record, "utf8"));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    process.kill(descendantPid, 0);
    assert.equal(existsSync(previewPaths(root).session), false);
  } finally {
    if (descendantPid) {
      try { process.kill(descendantPid); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
});

test("cancelling while the package is being checked never starts the app", async (t) => {
  const { root } = await delivery(t);
  const controller = new AbortController();
  let spawned = false;
  await assert.rejects(launchPreview(root, {
    signal: controller.signal,
    log: () => queueMicrotask(() => controller.abort()),
    spawnApp: () => { spawned = true; throw new Error("Unexpected app launch"); },
  }), { name: "AbortError" });
  assert.equal(spawned, false);
  assert.equal(existsSync(previewPaths(root).session), false);
});

test("an already cancelled launch never starts the app", async (t) => {
  const { root } = await delivery(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(launchPreview(root, {
    signal: controller.signal,
    spawnApp: () => { throw new Error("Unexpected app launch"); },
  }), { name: "AbortError" });
});

test("cancellation after spawn leaves the app's quit decision with the app", { timeout: 5_000 }, async (t) => {
  const { root } = await delivery(t);
  const controller = new AbortController();
  let child;
  t.after(() => child?.kill());
  const running = launchPreview(root, { signal: controller.signal, log: () => {},
    spawnApp: (_executable, _args, options) => {
      child = spawn(process.execPath, ["-e", 'process.on("message", () => process.exit(0)); process.send("ready"); setInterval(() => {}, 1000);'], {
        ...options, windowsHide: true, stdio: [...options.stdio, "ipc"],
      });
      controller.abort();
      return child;
    } });
  await until(() => child !== undefined);
  await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("exit", () => reject(new Error("The launcher stopped the app before it could decide to quit.")));
  });
  child.send("quit");
  const result = await running;
  assert.equal(result.code, 0);
  assert.equal(result.session.appPid, child.pid);
  assert.equal(existsSync(previewPaths(root).session), false);
});

test("Try it.cmd uses the delivered runtime when Node is absent from PATH", { skip: process.platform !== "win32" }, (t) => {
  const root = scratch(t);
  const runtime = join(root, "app/resources/app-compiler/node.exe");
  mkdirSync(join(root, "app/resources/app-compiler"), { recursive: true });
  copyFileSync(process.execPath, runtime);
  writeFileSync(join(root, "Try it.cmd"), TRY_IT_COMMAND);
  writeFileSync(join(root, "launch.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync("launched.json", JSON.stringify({ runtime: process.execPath }));`);
  const result = spawnSync(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/q"], {
    cwd: root, env: { ...process.env, PATH: "" }, input: 'call ".\\Try it.cmd"\r\nexit\r\n',
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(root, "launched.json"), "utf8")).runtime.toLowerCase(), runtime.toLowerCase());
});

test("builder options require a full commit and a base", () => {
  assert.throws(() => parseArgs(["--commit", "abc", "--base", "origin/main"]), /full 40-character/u);
  assert.throws(() => parseArgs(["--commit", sha]), /--base is required/u);
  assert.throws(() => parseArgs(["--commit", sha, "--base", "main", "--pr", "x"]), /pull request number/u);
  assert.throws(() => parseArgs(["--commit", sha, "--base", "main", "--package-commit", sha]), /Unknown option/u);
  const options = parseArgs(["--commit", sha, "--base", "origin/main", "--pr", "12", "--output", "out"]);
  assert.equal(options.id, `pr-12-${sha.slice(0, 12)}`);
  assert.equal(options.pr, 12);
});

test("the builder packages only a clean checkout at the named commit", (t) => {
  const root = scratch(t);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
  writeFileSync(join(root, "a.txt"), "a");
  git("add", "a.txt");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "two");
  const head = git("rev-parse", "HEAD");
  assert.equal(requirePinnedSource(root, head).commit, head);
  assert.throws(() => requirePinnedSource(root, git("rev-parse", "HEAD~1")), /not/u);
  writeFileSync(join(root, "a.txt"), "changed");
  assert.throws(() => requirePinnedSource(root, head), /uncommitted/u);
  git("checkout", "--", "a.txt");
  writeFileSync(join(root, "new.txt"), "");
  assert.throws(() => requirePinnedSource(root, head), /uncommitted/u);
});

test("packaging never sees a signing identity, telemetry key or build override", () => {
  assert.deepEqual(packagingEnvironment({ PATH: "bin", WIN_CSC_LINK: "x", CSC_LINK: "x", csc_key_password: "x", APPLE_ID: "x",
    DOHC_POSTHOG_KEY: "x", VITE_FLAG: "x", NODE_OPTIONS: "x", NODE_ENV: "development" }), { PATH: "bin", CSC_IDENTITY_AUTO_DISCOVERY: "false" });
});

test("the engine's own admission receives the configured shared slot root and disk floor", () => {
  const env = engineBuildEnvironment({ DOHC_BUILD_SLOT_ROOT: "C:\\preview-budget", DOHC_GATE_DISK_FLOOR_GB: "71",
    DOHC_TEST_ENGINE_BINARY: "wrong.exe", CSC_LINK: "signing-key", CI: "0" });
  const budget = resolveBuildBudget(env, { platform: "win32", cores: 16 });
  assert.equal(budget.root, "C:\\preview-budget");
  assert.equal(budget.diskFloorGb, 71);
  assert.equal(env.DOHC_TEST_ENGINE_BINARY, undefined);
  assert.equal(env.CSC_LINK, undefined);
});

test("signing status comes from dohc's own binaries, not a vendor's", () => {
  const vendor = { path: "resources/app-compiler/node.exe", status: "Valid", signer: "CN=OpenJS Foundation" };
  const exe = { path: "dohc.exe", status: "NotSigned" }, engine = { path: "resources/workspace-engine/dohc-workspace-engine.exe", status: "NotSigned" };
  assert.equal(signingStatus([exe, engine, vendor]).status, "unsigned");
  assert.equal(signingStatus([{ ...exe, status: "Valid" }, engine]).status, "dohc.exe: Valid, resources/workspace-engine/dohc-workspace-engine.exe: NotSigned");
  assert.throws(() => signingStatus([exe, vendor]), /missing/u);
});

test("a smoke passes only when it completed against the package's own files", () => {
  const critical = { executable: "e", asar: "a", engine: "n" };
  const result = { status: "complete", binarySha256: "e", asarSha256: "a", engineSha256: "n" };
  checkSmoke(result, critical);
  assert.throws(() => checkSmoke({ ...result, status: "failed" }, critical), /status is failed/u);
  assert.throws(() => checkSmoke({ ...result, engineSha256: "other" }, critical), /engineSha256/u);
  assert.throws(() => checkSmoke(null, critical), /status is missing/u);
});
