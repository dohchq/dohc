import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MANIFEST_SCHEMA, NO_UPDATE_FEED, hashTree, launchPreview, previewArgs, previewEnvironment, previewPaths,
  readManifest, startNoUpdateFeed, verifyDelivery } from "./preview-launch.mjs";
import { checkSmoke, packagingEnvironment, parseArgs, requirePinnedSource, signingStatus } from "./preview.mjs";

const sha = "a".repeat(40);
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dohc-preview-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

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

test("the manifest must name a full commit and an executable inside the package", async (t) => {
  const { root, manifest } = await delivery(t);
  for (const change of [{ source: { commit: "abc123" } }, { package: { ...manifest.package, executable: "../evil.exe" } },
    { package: { ...manifest.package, executable: "C:\\Windows\\notepad.exe" } }, { schema: 99 }]) {
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ ...manifest, ...change }));
    assert.throws(() => readManifest(root));
  }
});

test("the preview's environment keeps it away from the installed app's data and agent sign-ins", () => {
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
  writeFileSync(record, JSON.stringify({ args: process.argv.slice(2, -1), env: process.env, feed }));
});
setInterval(() => {}, 1000);
`;

test("the launcher starts the app isolated, then stops only the process it started", async (t) => {
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
      spawned = spawn(process.execPath, [script, ...args, record], options);
      return spawned;
    } });
  while (!existsSync(record)) await new Promise((done) => setTimeout(done, 20));
  const paths = previewPaths(root);
  const session = JSON.parse(readFileSync(paths.session, "utf8"));
  assert.equal(session.appPid, spawned.pid);
  assert.equal(session.launcherPid, process.pid);
  await assert.rejects(launchPreview(root, { log: () => {} }), /already running/u);
  const seen = JSON.parse(readFileSync(record, "utf8"));
  assert.deepEqual(seen.args, previewArgs(paths));
  assert.equal(seen.feed, NO_UPDATE_FEED);
  assert.equal(seen.env.USERPROFILE, paths.home);
  assert.equal(seen.env.DOHC_TEST_HOME, undefined);
  controller.abort();
  const result = await running;
  assert.equal(spawned.exitCode !== null || spawned.signalCode !== null, true);
  assert.equal(bystander.exitCode, null, "an unrelated process keeps running");
  assert.equal(existsSync(paths.session), false);
  assert.equal(result.feedRequests.length, 1);
  await assert.rejects(fetch(session.feed), "the feed stops with the launcher");
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
