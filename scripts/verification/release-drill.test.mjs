import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  buildDrillApp, DIALOG_RECORDER, downloadedOnlyAfterAnswer, FEED_VERSION, feedManifest, injectFault, launchApp, readDrillLog, runDrill,
} from "./release-drill.mjs";

function scratchDir(t) {
  const directory = mkdtempSync(join(tmpdir(), "release-drill-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// The fake app sits at <root>/ws/desktop, so a scratch app under
// <root>/apps shares its grandparent, as .dohc-dev and apps/desktop do.
function fakeDesktop(root, entrySource = 'import "./shared.js";\nawait import("./app.js");\n') {
  const main = join(root, "ws", "desktop", "dist", "main");
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, "main.js"), entrySource);
  writeFileSync(join(main, "app.js"), 'import "./shared.js";\nexport const loaded = true;\n');
  writeFileSync(join(main, "shared.js"), "export {};\n");
  writeFileSync(join(root, "ws", "desktop", "package.json"), '{"type":"module"}\n');
  return join(root, "ws", "desktop");
}

test("injects each fault into the app module only", () => {
  assert.match(injectFault("main-fails-to-load", "export const loaded = true;"), /^throw new Error/);
  const crashing = injectFault("main-crashes-every-launch", "export const loaded = true;");
  assert.match(crashing, /process\.exit\(70\), 1_500/);
  assert.ok(crashing.endsWith("export const loaded = true;"));
  assert.throws(() => injectFault("renderer-crash-loop", ""), /Unknown scenario/);
});

test("describes the placeholder installer with its real hash and size", () => {
  const installer = Buffer.from("placeholder");
  const manifest = feedManifest(installer);
  const sha512 = createHash("sha512").update(installer).digest("base64");
  assert.match(manifest, new RegExp(`^version: ${FEED_VERSION}$`, "m"));
  assert.equal(manifest.split(`sha512: ${sha512}`).length - 1, 2);
  assert.match(manifest, new RegExp(`size: ${installer.length}`));
});

test("builds a scratch copy and leaves the real build unchanged", (t) => {
  const root = scratchDir(t);
  const source = fakeDesktop(root);
  const before = readFileSync(join(source, "dist", "main", "app.js"), "utf8");
  const { entry } = buildDrillApp({
    scenario: "main-fails-to-load", app: join(root, "apps", "drill"), feedUrl: "http://127.0.0.1:1/", source,
  });
  const main = join(root, "apps", "drill", "dist", "main");
  assert.equal(entry, join(main, "main.js"));
  assert.match(readFileSync(entry, "utf8"), /^import "\.\/drill-dialogs\.mjs";\n/);
  assert.match(readFileSync(join(main, "app.js"), "utf8"), /release drill: main fails to load/);
  assert.match(readFileSync(join(main, "dev-app-update.yml"), "utf8"), /url: http:\/\/127\.0\.0\.1:1\//);
  assert.ok(existsSync(join(main, "shared.js")));
  assert.equal(readFileSync(join(source, "dist", "main", "app.js"), "utf8"), before);
  assert.ok(!existsSync(join(source, "dist", "main", "drill-dialogs.mjs")));
});

test("refuses a scratch app whose pnpm links would resolve elsewhere", (t) => {
  const root = scratchDir(t);
  const source = fakeDesktop(root);
  assert.throws(() => buildDrillApp({
    scenario: "main-fails-to-load", app: join(root, "apps", "deeper", "drill"), feedUrl: "http://127.0.0.1:1/", source,
  }), /grandparent/);
});

test("resolves pnpm's relative links from the scratch app", (t) => {
  const root = scratchDir(t);
  const source = fakeDesktop(root);
  mkdirSync(join(root, "node_modules", ".pnpm", "zod"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".pnpm", "zod", "index.js"), "zod\n");
  mkdirSync(join(source, "node_modules"));
  try {
    symlinkSync(join("..", "..", "..", "node_modules", ".pnpm", "zod"), join(source, "node_modules", "zod"), "dir");
  } catch (error) {
    if (error.code === "EPERM") { t.skip("this account cannot create symbolic links"); return; }
    throw error;
  }
  const app = join(root, "apps", "drill");
  buildDrillApp({ scenario: "main-fails-to-load", app, feedUrl: "http://127.0.0.1:1/", source });
  assert.equal(readFileSync(join(app, "node_modules", "zod", "index.js"), "utf8"), "zod\n");
});

test("refuses an entry that loads the app module statically", (t) => {
  const root = scratchDir(t);
  const source = fakeDesktop(root, 'import "./app.js";\n');
  assert.throws(() => buildDrillApp({
    scenario: "main-fails-to-load", app: join(root, "apps", "drill"), feedUrl: "http://127.0.0.1:1/", source,
  }), /dynamic import/);
});

test("records dialogs and requests, presses Download only once the drill answers, and closes the notice with its signal", async (t) => {
  const root = scratchDir(t);
  const electron = join(root, "node_modules", "electron");
  mkdirSync(electron, { recursive: true });
  writeFileSync(join(electron, "package.json"), '{"name":"electron","type":"module","main":"index.js"}\n');
  writeFileSync(join(electron, "index.js"),
    "export const dialog = { showErrorBox() {}, showMessageBox() {} };\nexport const net = { request: (options) => ({ sent: options }) };\n");
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(root, "recorder.mjs"), DIALOG_RECORDER);
  const log = join(root, "dialogs.jsonl");
  const answer = join(root, "answer");
  const previous = { DOHC_DRILL_LOG: process.env.DOHC_DRILL_LOG, DOHC_DRILL_ANSWER: process.env.DOHC_DRILL_ANSWER };
  Object.assign(process.env, { DOHC_DRILL_LOG: log, DOHC_DRILL_ANSWER: answer });
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  t.mock.timers.enable({ apis: ["setInterval"] });
  await import(pathToFileURL(join(root, "recorder.mjs")).href);
  const { dialog, net } = await import(pathToFileURL(join(electron, "index.js")).href);
  const installer = { path: `/dohc-${FEED_VERSION}-setup.exe` };

  dialog.showErrorBox("dohc failed to start", "boom");
  let pressed = false;
  const question = dialog.showMessageBox({ message: "Update 2.0.0 is available.", buttons: ["Download", "Quit"] })
    .then((result) => { pressed = true; return result; });
  // A download that does not wait for the answer.
  assert.deepEqual(net.request(installer), { sent: installer });
  t.mock.timers.tick(1_000);
  await new Promise((done) => setImmediate(done));
  assert.equal(pressed, false);
  writeFileSync(answer, "Download\n");
  t.mock.timers.tick(100);
  assert.equal((await question).response, 0);
  net.request(installer);
  assert.equal(downloadedOnlyAfterAnswer(readDrillLog(log)), false);

  const signal = new AbortController();
  let noticeClosed = false;
  const notice = dialog.showMessageBox({ message: "Downloading update 2.0.0.", buttons: ["Quit"], signal: signal.signal })
    .then(() => { noticeClosed = true; });
  let answered = false;
  void dialog.showMessageBox({ message: "Update 2.0.0 is downloaded.", buttons: ["Restart now", "Quit"] })
    .then(() => { answered = true; });
  await new Promise((done) => setImmediate(done));
  assert.equal(noticeClosed, false);
  signal.abort();
  await notice;
  assert.equal(answered, false);
  const entries = readDrillLog(log);
  assert.deepEqual(entries.map((entry) => entry.kind),
    ["entry", "error-box", "question", "request", "answered", "request", "notice", "dialog"]);
  assert.equal(entries[3].path, installer.path);
  assert.deepEqual(entries[7].buttons, ["Restart now", "Quit"]);
});

test("counts a download as asked for only when every installer request follows Download", () => {
  const manifest = { kind: "request", path: "/latest.yml" };
  const installer = { kind: "request", path: `/dohc-${FEED_VERSION}-setup.exe` };
  const question = { kind: "question" };
  const answered = { kind: "answered" };
  assert.equal(downloadedOnlyAfterAnswer([manifest, question, answered, installer]), true);
  assert.equal(downloadedOnlyAfterAnswer([manifest, installer, question, answered, installer]), false);
  assert.equal(downloadedOnlyAfterAnswer([manifest, question, installer, answered, installer]), false);
  assert.equal(downloadedOnlyAfterAnswer([manifest, question, answered]), false);
  assert.equal(downloadedOnlyAfterAnswer([manifest, answered, installer]), false);
});

test("a failed setup closes the feed and deletes the scratch app, keeping only evidence", async (t) => {
  const root = scratchDir(t);
  const source = join(root, "ws", "desktop");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "package.json"), '{"type":"module"}\n');
  const engine = join(root, "engine.exe");
  writeFileSync(engine, "engine");
  let feedUrl = null;
  await assert.rejects(
    runDrill({ scenario: "main-fails-to-load", source, engine, tempRoot: root, appsRoot: join(root, "apps"), onFeed: (feed) => { feedUrl = feed.url; } }),
    /pnpm qa:prepare/,
  );
  assert.ok(feedUrl, "the feed started before the failure");
  await assert.rejects(fetch(`${feedUrl}latest.yml`), /fetch failed/);
  const left = readdirSync(root).filter((name) => name.startsWith("dohc-release-drill-"));
  assert.equal(left.length, 1);
  assert.match(left[0], /^dohc-release-drill-evidence-/);
  const evidence = join(root, left[0]);
  assert.deepEqual(readdirSync(evidence).sort(), ["result.json"]);
  const result = JSON.parse(readFileSync(join(evidence, "result.json"), "utf8"));
  assert.equal(result.passed, false);
  assert.match(result.error, /pnpm qa:prepare/);
  assert.deepEqual(readdirSync(join(root, "apps")), []);
});

test("a failure after linking the real app deletes the links, not what they point at", async (t) => {
  const root = scratchDir(t);
  const source = fakeDesktop(root);
  mkdirSync(join(source, "node_modules", "kept"), { recursive: true });
  writeFileSync(join(source, "node_modules", "kept", "index.js"), "kept\n");
  // A directory passes the existence check and then fails to copy.
  const engine = join(root, "engine-directory");
  mkdirSync(engine);
  await assert.rejects(runDrill({ scenario: "main-crashes-every-launch", source, engine, tempRoot: root, appsRoot: join(root, "apps") }));
  assert.deepEqual(readdirSync(join(root, "apps")), []);
  assert.deepEqual(readdirSync(root).filter((name) => /^dohc-release-drill-(?!evidence)/.test(name)), []);
  assert.equal(readFileSync(join(source, "node_modules", "kept", "index.js"), "utf8"), "kept\n");
});

// A stand-in for the job owner: it exits by itself after `exitAfterMs`, or
// when it is killed.
function fakeLaunch({ exitAfterMs = null } = {}) {
  const events = [];
  const child = { exitCode: null, signalCode: null, kill: (signal) => { events.push(`kill:${signal}`); exit(null, signal); } };
  let exit = () => undefined;
  const start = (onSpawn) => {
    onSpawn(child);
    return new Promise((resolve) => {
      exit = (code, signal) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.exitCode = code;
        child.signalCode = signal;
        events.push("exited");
        resolve(signal ? { error: `killed by ${signal}` } : { code });
      };
      if (exitAfterMs !== null) setTimeout(() => exit(70, null), exitAfterMs);
    });
  };
  return { start, events };
}

test("a launch with nothing to wait for runs until the app exits by itself", async () => {
  const app = fakeLaunch({ exitAfterMs: 50 });
  const ended = [];
  const seen = await launchApp({
    start: app.start, readLog: () => [], boundMs: 60_000, describe: "nothing", onEnded: (outcome) => ended.push(outcome),
  });
  assert.equal(seen, null);
  assert.deepEqual(app.events, ["exited"]);
  assert.deepEqual(ended, [{ code: 70 }]);
});

test("a launch waiting for a dialog ends the app once the dialog shows", async () => {
  const app = fakeLaunch();
  const log = [];
  setTimeout(() => log.push({ kind: "dialog", message: "offered" }), 50);
  const ended = [];
  const seen = await launchApp({
    start: app.start, until: (entries) => entries.find((entry) => entry.kind === "dialog"), readLog: () => log,
    boundMs: 60_000, describe: "the dialog", onEnded: (outcome) => ended.push(outcome),
  });
  assert.equal(seen.message, "offered");
  assert.deepEqual(app.events, ["kill:SIGKILL", "exited"]);
  assert.equal(ended.length, 1);
});

test("a launch waiting for a dialog fails when the app exits first", async () => {
  const app = fakeLaunch({ exitAfterMs: 50 });
  await assert.rejects(launchApp({
    start: app.start, until: () => null, readLog: () => [], boundMs: 60_000, describe: "the dialog",
  }), /The app ended before the dialog/);
  assert.deepEqual(app.events, ["exited"]);
});
