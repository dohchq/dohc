import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { buildDrillApp, DIALOG_RECORDER, FEED_VERSION, feedManifest, injectFault, readDrillLog } from "./release-drill.mjs";

function scratchDir(t) {
  const directory = mkdtempSync(join(tmpdir(), "release-drill-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeDesktop(root, entrySource = 'import "./shared.js";\nawait import("./app.js");\n') {
  const main = join(root, "desktop", "dist", "main");
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, "main.js"), entrySource);
  writeFileSync(join(main, "app.js"), 'import "./shared.js";\nexport const loaded = true;\n');
  writeFileSync(join(main, "shared.js"), "export {};\n");
  writeFileSync(join(root, "desktop", "package.json"), '{"type":"module"}\n');
  return join(root, "desktop");
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
    scenario: "main-fails-to-load", scratch: join(root, "scratch"), feedUrl: "http://127.0.0.1:1/", source,
  });
  const main = join(root, "scratch", "app", "dist", "main");
  assert.equal(entry, join(main, "main.js"));
  assert.match(readFileSync(entry, "utf8"), /^import "\.\/drill-dialogs\.mjs";\n/);
  assert.match(readFileSync(join(main, "app.js"), "utf8"), /release drill: main fails to load/);
  assert.match(readFileSync(join(main, "dev-app-update.yml"), "utf8"), /url: http:\/\/127\.0\.0\.1:1\//);
  assert.ok(existsSync(join(main, "shared.js")));
  assert.equal(readFileSync(join(source, "dist", "main", "app.js"), "utf8"), before);
  assert.ok(!existsSync(join(source, "dist", "main", "drill-dialogs.mjs")));
});

test("refuses an entry that loads the app module statically", (t) => {
  const root = scratchDir(t);
  const source = fakeDesktop(root, 'import "./app.js";\n');
  assert.throws(() => buildDrillApp({
    scenario: "main-fails-to-load", scratch: join(root, "scratch"), feedUrl: "http://127.0.0.1:1/", source,
  }), /dynamic import/);
});

test("records dialogs, holds the restart question, and closes the notice with its signal", async (t) => {
  const root = scratchDir(t);
  const electron = join(root, "node_modules", "electron");
  mkdirSync(electron, { recursive: true });
  writeFileSync(join(electron, "package.json"), '{"name":"electron","type":"module","main":"index.js"}\n');
  writeFileSync(join(electron, "index.js"), "export const dialog = { showErrorBox() {}, showMessageBox() {} };\n");
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(root, "recorder.mjs"), DIALOG_RECORDER);
  const log = join(root, "dialogs.jsonl");
  const previous = process.env.DOHC_DRILL_LOG;
  process.env.DOHC_DRILL_LOG = log;
  t.after(() => { if (previous === undefined) delete process.env.DOHC_DRILL_LOG; else process.env.DOHC_DRILL_LOG = previous; });
  await import(pathToFileURL(join(root, "recorder.mjs")).href);
  const { dialog } = await import(pathToFileURL(join(electron, "index.js")).href);

  dialog.showErrorBox("dohc failed to start", "boom");
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
  assert.deepEqual(readDrillLog(log).map((entry) => entry.kind), ["entry", "error-box", "notice", "dialog"]);
  assert.deepEqual(readDrillLog(log)[3].buttons, ["Restart now", "Quit"]);
});
