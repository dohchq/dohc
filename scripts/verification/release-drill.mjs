// Release drill: proves that a bad build reaches a newer one through the
// recovery paths in the entry module, against a local update feed.
//
//   node scripts/verification/release-drill.mjs --scenario main-fails-to-load
//   node scripts/verification/release-drill.mjs --scenario main-crashes-every-launch
//
// It needs a built desktop app and the staged engine (`pnpm qa:prepare`). It
// copies apps/desktop/dist to a scratch app, injects the fault into that copy
// only, and serves a fixed newer build from 127.0.0.1. The shipped app reads
// no fault switch: the fault, the dialog recorder, and dev-app-update.yml
// exist only in the scratch copy. Windows only.
//
// It proves the check runs and the restart is offered. It stops there: the
// feed's installer is placeholder bytes, and nothing installs or relaunches.

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, run } from "./process.mjs";

export const SCENARIOS = ["main-fails-to-load", "main-crashes-every-launch"];
export const FEED_VERSION = "999.0.0";
const INSTALLER = `dohc-${FEED_VERSION}-setup.exe`;
const ENGINE = "dohc-workspace-engine.exe";
const desktopRoot = join(repoRoot, "apps/desktop");

// The product's own bounds (updates/updateAfterFailure.ts): 15 s for the feed
// to answer and 5 minutes for the download. A launch gets twice that, plus
// time to boot on a loaded machine.
const PRODUCT_WAIT_MS = 15_000 + 5 * 60_000;
const LAUNCH_BOUND_MS = 2 * PRODUCT_WAIT_MS + 2 * 60_000;

// Loaded first by the scratch entry module. It records every native dialog
// to the drill log and answers the way a person who reads and waits would:
// a download notice stays open until the app closes it, and the restart
// question stays open until the drill ends the process.
export const DIALOG_RECORDER = `import { appendFileSync } from "node:fs";
import { dialog } from "electron";
const record = (entry) => appendFileSync(process.env.DOHC_DRILL_LOG, JSON.stringify({ pid: process.pid, at: Date.now(), ...entry }) + "\\n");
record({ kind: "entry" });
dialog.showErrorBox = (title, content) => { record({ kind: "error-box", title, content }); };
dialog.showMessageBox = (...args) => {
  const options = args.length > 1 ? args[1] : args[0];
  const shown = { message: options.message, detail: options.detail, buttons: options.buttons };
  if (options.buttons?.length === 1) {
    record({ kind: "notice", ...shown });
    return new Promise((resolve) => {
      const close = () => resolve({ response: 0, checkboxChecked: false });
      if (options.signal?.aborted) close();
      else options.signal?.addEventListener("abort", close, { once: true });
    });
  }
  record({ kind: "dialog", ...shown });
  return new Promise(() => undefined);
};
`;

// The two faults, applied to the scratch copy of dist/main/app.js.
export function injectFault(scenario, appSource) {
  if (scenario === "main-fails-to-load") {
    return `throw new Error("release drill: main fails to load");\n`;
  }
  if (scenario === "main-crashes-every-launch") {
    return `import { app as drillApp } from "electron";
import { appendFileSync as drillRecord } from "node:fs";
drillRecord(process.env.DOHC_DRILL_LOG, JSON.stringify({ pid: process.pid, at: Date.now(), kind: "main-loaded" }) + "\\n");
drillApp.once("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", () => {
    drillRecord(process.env.DOHC_DRILL_LOG, JSON.stringify({ pid: process.pid, at: Date.now(), kind: "fault-exit" }) + "\\n");
    setTimeout(() => process.exit(70), 1_500);
  });
});
${appSource}`;
  }
  throw new Error(`Unknown scenario ${scenario}. Choose one of: ${SCENARIOS.join(", ")}.`);
}

export function feedManifest(installer) {
  const sha512 = createHash("sha512").update(installer).digest("base64");
  return [
    `version: ${FEED_VERSION}`,
    "files:",
    `  - url: ${INSTALLER}`,
    `    sha512: ${sha512}`,
    `    size: ${installer.length}`,
    `path: ${INSTALLER}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-01-01T00:00:00.000Z'",
    "",
  ].join("\n");
}

// Reads complete lines only: the app may still be writing the last one.
export function readDrillLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
}

// The scratch app links these to the real app. They are removed as links
// first, so deleting the scratch app never reaches the real app.
const LINKED = ["node_modules", "resources", "build"];

// Where scratch apps go: in the checkout, git-ignored, two levels below the
// repository root like apps/desktop.
export const DRILL_APPS_ROOT = join(repoRoot, ".dohc-dev");

/**
 * Builds the scratch app in `app`: a copy of dist with the fault, linked to
 * the real dependencies. pnpm's links inside node_modules are relative and
 * climb to the workspace root, so they resolve from the scratch app only when
 * it sits under the same grandparent as the real app.
 */
export function buildDrillApp({ scenario, app, feedUrl, source = desktopRoot }) {
  if (resolve(app, "../..") !== resolve(source, "../..")) {
    throw new Error(`The scratch app ${app} must share its grandparent with ${source}, or pnpm's relative links in node_modules resolve elsewhere.`);
  }
  const main = join(app, "dist", "main");
  const entry = join(source, "dist", "main", "main.js");
  const appModule = join(source, "dist", "main", "app.js");
  if (!existsSync(entry) || !existsSync(appModule)) {
    throw new Error("The drill needs a desktop build with the entry module. Run `pnpm qa:prepare` first.");
  }
  const entrySource = readFileSync(entry, "utf8");
  if (!/import\(\s*["']\.\/app\.js["']\s*\)/.test(entrySource) || /(?:from|import)\s*["']\.\/app\.js["']/.test(entrySource)) {
    throw new Error("dist/main/main.js must load app.js only through a dynamic import, or the fault would reach the entry.");
  }
  cpSync(join(source, "dist"), join(app, "dist"), { recursive: true });
  copyFileSync(join(source, "package.json"), join(app, "package.json"));
  for (const name of LINKED) {
    if (existsSync(join(source, name))) symlinkSync(join(source, name), join(app, name), "junction");
  }
  writeFileSync(join(main, "drill-dialogs.mjs"), DIALOG_RECORDER);
  writeFileSync(join(main, "main.js"), `import "./drill-dialogs.mjs";\n${entrySource}`);
  writeFileSync(join(main, "app.js"), injectFault(scenario, readFileSync(appModule, "utf8")));
  // Unpackaged, electron-updater reads its cache name from this file.
  writeFileSync(join(main, "dev-app-update.yml"),
    `provider: generic\nurl: ${feedUrl}\nupdaterCacheDirName: dohc-release-drill-updater\n`);
  return { app, entry: join(main, "main.js") };
}

function removeApp(app) {
  for (const name of LINKED) {
    const link = join(app, name);
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  remove(app);
}

function readCrashReport(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function remove(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

function startFeed(directory, logPath) {
  const requests = [];
  let published = false;
  const server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1));
    const entry = { at: Date.now(), name, published };
    requests.push(entry);
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
    const path = join(directory, name);
    if (!published || name.includes("..") || !existsSync(path)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(path));
  });
  const close = () => new Promise((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });
  return new Promise((resolveFeed, rejectFeed) => {
    server.once("error", rejectFeed);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveFeed({ url: `http://127.0.0.1:${port}/`, requests, publish: () => { published = true; }, close });
    });
  });
}

function launchEnv(scratch, logPath, feedUrl) {
  const env = {
    ...process.env,
    DOHC_DESKTOP_TEST: "1",
    DOHC_TEST_HOME: join(scratch, "home"),
    DOHC_DESKTOP_MOCK_UPDATES: "1",
    DOHC_UPDATE_URL: feedUrl,
    DOHC_DRILL_LOG: logPath,
    // The updater caches downloads under LOCALAPPDATA; keep them in scratch.
    LOCALAPPDATA: join(scratch, "localappdata"),
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function sleep(ms, signal) {
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function waitFor(check, deadlineMs, describe, signal) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (signal.aborted) throw new Error(`Stopped waiting for ${describe}.`);
    const found = check();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out after ${deadlineMs} ms waiting for ${describe}.`);
    await sleep(250, signal);
  }
}

/**
 * Runs one launch of the app. Without `until`, it waits for the app to exit
 * by itself, bounded by the runner's timeout. With `until`, it waits until
 * the drill log shows what `until` looks for, then ends the app. Either way
 * the app has ended, with every process it started, when this settles.
 */
export async function launchApp({ start, until, readLog, boundMs, describe, onEnded }) {
  let child = null;
  const exited = start((spawned) => { child = spawned; });
  const polling = new AbortController();
  try {
    if (!until) {
      await exited;
      return null;
    }
    return await Promise.race([
      waitFor(() => until(readLog()), boundMs, describe, polling.signal),
      exited.then((outcome) => { throw new Error(`The app ended before ${describe}: ${JSON.stringify(outcome)}`); }),
    ]);
  } finally {
    polling.abort();
    // The job object owns the app and every process it started, so ending
    // the job owner ends them all.
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    onEnded?.(await exited);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Runs one scenario. Every resource it acquires is released before it
 * settles: each launch ends and awaits its app, the feed closes, and the
 * scratch app, engine copy, profile, and updater cache are deleted. A failed
 * run keeps only its small evidence directory. --keep keeps everything from
 * a passing run.
 */
export async function runDrill({
  scenario,
  keep = false,
  source = desktopRoot,
  engine = join(desktopRoot, "target", "debug", ENGINE),
  tempRoot = tmpdir(),
  appsRoot = DRILL_APPS_ROOT,
  onFeed,
}) {
  assert(SCENARIOS.includes(scenario), `Choose --scenario ${SCENARIOS.join(" or ")}.`);
  assert(existsSync(engine), `The drill needs the staged engine at ${engine}. Run \`pnpm qa:prepare\` first.`);
  const electron = createRequire(join(desktopRoot, "package.json"))("electron");

  const evidence = mkdtempSync(join(tempRoot, "dohc-release-drill-evidence-"));
  const logPath = join(evidence, "dialogs.jsonl");
  const result = { scenario, feedVersion: FEED_VERSION, evidence, launches: [], checks: [], passed: false };
  const check = (name, condition, detail) => {
    result.checks.push({ name, passed: Boolean(condition), ...(detail === undefined ? {} : { detail }) });
    assert(condition, `${name} failed${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  };
  let scratch = null;
  let app = null;
  let feed = null;

  const launch = (number, { entry, profile, until }) => {
    const started = Date.now();
    return launchApp({
      start: (onSpawn) => run(electron, [`--user-data-dir=${profile}`, "--dohc-isolated-test", entry], {
        env: launchEnv(scratch, logPath, feed.url),
        log: join(evidence, `launch-${number}.log`),
        onSpawn,
        quietStdout: true,
        timeoutMs: LAUNCH_BOUND_MS,
      }).then((done) => ({ code: done.code }), (error) => ({ error: error.message })),
      until,
      readLog: () => readDrillLog(logPath),
      boundMs: LAUNCH_BOUND_MS,
      describe: `launch ${number} to offer the restart`,
      onEnded: (outcome) => result.launches.push({ number, ms: Date.now() - started, ...outcome }),
    });
  };

  try {
    scratch = mkdtempSync(join(tempRoot, "dohc-release-drill-"));
    const feedDir = join(scratch, "feed");
    for (const directory of [feedDir, join(scratch, "home"), join(scratch, "localappdata")]) mkdirSync(directory, { recursive: true });
    const installer = randomBytes(64 * 1024);
    writeFileSync(join(feedDir, INSTALLER), installer);
    writeFileSync(join(feedDir, "latest.yml"), feedManifest(installer));
    feed = await startFeed(feedDir, join(evidence, "feed.jsonl"));
    onFeed?.(feed);
    mkdirSync(appsRoot, { recursive: true });
    app = mkdtempSync(join(appsRoot, "release-drill-"));
    const { entry } = buildDrillApp({ scenario, app, feedUrl: feed.url, source });
    mkdirSync(join(app, "target", "debug"), { recursive: true });
    copyFileSync(engine, join(app, "target", "debug", ENGINE));
    const profile = join(scratch, "profile");
    const markerPath = join(profile, "dohc-launch.json");
    const offered = (entries) => entries.find((logged) => logged.kind === "dialog");

    if (scenario === "main-fails-to-load") {
      feed.publish();
      const dialog = await launch(1, { entry, profile, until: offered });
      const entries = readDrillLog(logPath);
      check("reports that dohc failed to start", entries.some((logged) => logged.kind === "error-box" && logged.title === "dohc failed to start"));
      check("offers the restart into the newer build", dialog.message === `Update ${FEED_VERSION} is downloaded.` &&
        JSON.stringify(dialog.buttons) === JSON.stringify(["Restart now", "Quit"]), dialog);
      // DOHC_TEST_HOME is main's state directory in a test run, so the report
      // lands where the next dohc's store reads it.
      const report = readCrashReport(join(scratch, "home", "crash-report.json"));
      check("keeps the failure in the crash report", report?.problems?.some((problem) => problem.source === "main" &&
        problem.text.includes("What happened: The main module failed to load")), report);
    } else {
      for (const number of [1, 2]) {
        await launch(number, { entry, profile });
        const entries = readDrillLog(logPath);
        check(`launch ${number} loads main and exits after its first window loads`,
          entries.filter((logged) => logged.kind === "fault-exit").length === number);
        check(`launch ${number} offers nothing`, !entries.some((logged) => logged.kind === "dialog" || logged.kind === "error-box"));
        const marker = JSON.parse(readFileSync(markerPath, "utf8"));
        check(`launch ${number} leaves ${number} unfinished`, marker.unfinished === number, marker);
      }
      // The corrective build is published after the bad one broke.
      feed.publish();
      const dialog = await launch(3, { entry, profile, until: offered });
      const entries = readDrillLog(logPath);
      check("launch 3 checks before main loads", entries.filter((logged) => logged.kind === "main-loaded").length === 2);
      check("launch 3 offers the restart into the newer build", dialog.message === "dohc closed before it finished starting." &&
        dialog.detail?.startsWith(`Update ${FEED_VERSION} is downloaded.`) &&
        JSON.stringify(dialog.buttons) === JSON.stringify(["Restart now", "Quit"]), dialog);
    }
    check("the feed served the manifest and the installer", ["latest.yml", INSTALLER].every((name) =>
      feed.requests.some((request) => request.published && request.name === name)), feed.requests);
    result.passed = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    // Each launch has already ended and awaited its app before this runs.
    await feed?.close();
    result.dialogs = readDrillLog(logPath);
    if (keep && result.passed) Object.assign(result, { scratch, app });
    writeFileSync(join(evidence, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    const cleanup = [];
    if (app && !result.app) cleanup.push(() => removeApp(app));
    if (scratch && !result.scratch) cleanup.push(() => remove(scratch));
    const failures = [];
    for (const step of cleanup) {
      try {
        step();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      // Keep result.json, marked failed, so the cleanup failure has its evidence.
      result.passed = false;
      result.cleanupErrors = failures.map((error) => (error instanceof Error ? error.message : String(error)));
      writeFileSync(join(evidence, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
      for (const message of result.cleanupErrors) console.error(`release drill cleanup: ${message}`);
      // A drill that already failed keeps its own error.
      if (!("error" in result)) throw failures[0];
    } else if (result.passed && !keep) {
      remove(evidence);
    }
  }
  return result;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const scenarioIndex = process.argv.indexOf("--scenario");
  const scenario = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : undefined;
  const keep = process.argv.includes("--keep");
  const drill = process.platform === "win32"
    ? runDrill({ scenario, keep })
    : Promise.reject(new Error("The release drill runs on Windows only."));
  drill.then((result) => {
    console.log(`[release-drill] ${scenario}: passed. ${result.checks.map((check) => check.name).join("; ")}.`);
    if (keep) console.log(`[release-drill] Evidence: ${result.evidence}. Scratch app: ${result.app}. Scratch data: ${result.scratch}.`);
  }, (error) => {
    console.error(`[release-drill] ${scenario ?? "(no scenario)"}: failed. ${error.message}`);
    process.exitCode = 1;
  });
}
