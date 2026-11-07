// Starts a fixed preview build that `pnpm qa:preview` delivered.
//
// The builder copies this file into the delivery folder as launch.mjs, so it
// imports only Node's own modules and never reads the checkout. It refuses to
// start a package whose files differ from the manifest, or whose packaged
// smoke did not pass.
//
// The app gets its own profile, home, APPDATA and LOCALAPPDATA under the
// delivery folder, and an update feed on 127.0.0.1 that offers nothing for as
// long as this launcher runs. This separates the preview's data from the
// installed app's. It is not an OS sandbox: the app still runs as the current
// user and can open any file that user can.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_SCHEMA = 1;
// The feed answers every request with a version older than any build and no
// files, so the updater finds nothing to download.
export const NO_UPDATE_FEED = "version: 0.0.0\nfiles: []\npath: unavailable.exe\nsha512: AA==\nreleaseDate: 2020-01-01T00:00:00.000Z\n";
// Settings that would point the preview at the installed app's data, the
// tester's file-based agent configuration, or a different runtime mode.
const DROPPED = new Set(["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "HOMEDRIVE", "HOMEPATH"]);

async function hashFileInto(hash, path) {
  for await (const chunk of createReadStream(path)) hash.update(chunk);
}

export async function fileSha256(path) {
  const hash = createHash("sha256");
  await hashFileInto(hash, path);
  return hash.digest("hex");
}

// One digest over every file below `root`: relative path, NUL, bytes, NUL, in
// sorted path order. A link or other special entry is refused.
export async function hashTree(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
      else throw new Error(`The package holds an entry that is not a file or folder: ${path}`);
    }
  };
  visit(root);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file + "\0");
    await hashFileInto(hash, join(root, file));
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), files: files.length };
}

export function readManifest(deliveryDir) {
  const manifest = JSON.parse(readFileSync(join(deliveryDir, "manifest.json"), "utf8"));
  if (manifest.schema !== MANIFEST_SCHEMA) throw new Error(`This launcher reads manifest schema ${MANIFEST_SCHEMA}, not ${manifest.schema}.`);
  if (!/^[a-f\d]{40}$/u.test(manifest.source?.commit ?? "")) throw new Error("The manifest names no full source commit.");
  const executable = manifest.package?.executable;
  if (typeof executable !== "string" || executable.includes("..") || /^[\\/]|^[a-z]:/iu.test(executable)) {
    throw new Error("The manifest's package executable must be a path inside the package.");
  }
  return manifest;
}

// The package must be byte-for-byte what was built and smoked.
export async function verifyDelivery(deliveryDir, manifest = readManifest(deliveryDir)) {
  if (manifest.smoke?.status !== "passed") {
    throw new Error(`This preview's packaged smoke is ${manifest.smoke?.status ?? "missing"}, so it will not start.`);
  }
  const packageDir = join(deliveryDir, manifest.package.directory);
  const tree = await hashTree(packageDir);
  if (tree.sha256 !== manifest.package.treeSha256 || tree.files !== manifest.package.files) {
    throw new Error(`The package in ${packageDir} differs from its manifest (${tree.files} files, ${tree.sha256}; expected ${manifest.package.files}, ${manifest.package.treeSha256}).`);
  }
  if (manifest.smoke.packageTreeSha256 !== tree.sha256) throw new Error("The smoke ran against a different package.");
  return { packageDir, executable: join(packageDir, manifest.package.executable), tree };
}

export function previewPaths(deliveryDir) {
  const data = join(deliveryDir, "data");
  const home = join(data, "home");
  return { data, home, profile: join(data, "profile"), appData: join(home, "AppData", "Roaming"),
    localAppData: join(home, "AppData", "Local"), logs: join(data, "logs"), session: join(data, "session.json") };
}

export function previewEnvironment(inherited, paths, feedUrl) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([name]) => {
    const key = name.toUpperCase();
    return !key.startsWith("DOHC_") && !DROPPED.has(key);
  }));
  return { ...env, HOME: paths.home, USERPROFILE: paths.home, APPDATA: paths.appData, LOCALAPPDATA: paths.localAppData,
    DOHC_UPDATE_URL: feedUrl };
}

export function previewArgs(paths) {
  return [`--user-data-dir=${paths.profile}`, "--dohc-isolated-test", "--enable-logging"];
}

export async function startNoUpdateFeed() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ at: new Date().toISOString(), url: request.url });
    response.writeHead(200, { "content-type": "text/yaml" });
    response.end(NO_UPDATE_FEED);
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

// Stops the app this launcher started, with its descendants, and nothing else.
export async function stopOwnedApp(child, exited, graceMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // A process without a window cannot be asked to close, so taskkill fails at once.
    const asked = spawnSync("taskkill", ["/PID", String(child.pid), "/T"], { windowsHide: true, stdio: "ignore" }).status === 0;
    const timer = new Promise((done) => setTimeout(done, asked ? graceMs : 0).unref());
    if (await Promise.race([exited.then(() => true), timer.then(() => false)])) return;
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
    const timer = new Promise((done) => setTimeout(done, graceMs).unref());
    if (await Promise.race([exited.then(() => true), timer.then(() => false)])) return;
    child.kill("SIGKILL");
  }
  await exited;
}

const defaultSpawn = (executable, args, options) => spawn(executable, args, options);

export async function launchPreview(deliveryDir, { spawnApp = defaultSpawn, signal, log = console.log, env = process.env } = {}) {
  signal?.throwIfAborted();
  deliveryDir = resolve(deliveryDir);
  const manifest = readManifest(deliveryDir);
  log(`Checking the preview package for ${describe(manifest)}...`);
  const { executable, tree } = await verifyDelivery(deliveryDir, manifest);
  const paths = previewPaths(deliveryDir);
  for (const path of [paths.profile, paths.appData, paths.localAppData, paths.logs]) mkdirSync(path, { recursive: true });
  if (existsSync(paths.session)) {
    const previous = JSON.parse(readFileSync(paths.session, "utf8"));
    if (alive(previous.launcherPid)) throw new Error(`This preview is already running (launcher PID ${previous.launcherPid}, app PID ${previous.appPid}). If no preview is running, delete data\\session.json and try again.`);
  }
  const feed = await startNoUpdateFeed();
  const startedAt = new Date().toISOString();
  const logPath = join(paths.logs, `${startedAt.replaceAll(":", "-")}.log`);
  let child;
  let exited;
  let output;
  let logError;
  try {
    signal?.throwIfAborted();
    child = spawnApp(executable, previewArgs(paths), { cwd: paths.data, env: previewEnvironment(env, paths, feed.url),
      stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
    // Descendants can keep inherited output pipes open after the app exits.
    child.once("exit", () => setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, 500).unref());
    exited = new Promise((done) => {
      child.once("close", (code, exitSignal) => done({ code, signal: exitSignal }));
      child.once("error", (error) => done({ error: error.message }));
    });
    const stop = () => stopOwnedApp(child, exited);
    output = createWriteStream(logPath);
    output.on("error", (error) => { logError = error; void stop(); });
    for (const stream of [child.stdout, child.stderr]) stream?.pipe(output, { end: false });
    const session = { launcherPid: process.pid, appPid: child.pid, startedAt, feed: feed.url, packageTreeSha256: tree.sha256, log: logPath };
    writeFileSync(paths.session, JSON.stringify(session, null, 2) + "\n");
    log(`Started ${describe(manifest)} as PID ${child.pid}. Its data is in ${paths.data}.`);
    log("Quit dohc to end the preview, or press Ctrl+C here to close it.");
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) void stop();
    const result = await exited;
    signal?.removeEventListener("abort", stop);
    await new Promise((done) => { if (output.destroyed) done(); else output.end(done); });
    if (logError) throw logError;
    return { ...result, session, feedRequests: feed.requests };
  } finally {
    if (child && exited && child.exitCode === null && child.signalCode === null) await stopOwnedApp(child, exited);
    output?.destroy();
    await feed.close();
    rmSync(paths.session, { force: true });
  }
}

function describe(manifest) {
  const change = manifest.source.pr ? `PR #${manifest.source.pr}` : "the change";
  return `${change} at ${manifest.source.commit.slice(0, 12)}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(name, () => controller.abort());
  launchPreview(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)), { signal: controller.signal })
    .then((result) => {
      console.log(`The preview ended (${result.error ?? `exit ${result.code ?? result.signal}`}).`);
      if (result.error || result.signal || (result.code ?? 0) !== 0) process.exitCode = 1;
    })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
