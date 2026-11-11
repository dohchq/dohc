import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { insideFolder } from "./inside-folder.mjs";

test("a folder reached through a symlink matches its real path either way", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dohc-inside-folder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, "real");
  const home = join(real, "home");
  const appData = join(home, "Library", "Application Support");
  mkdirSync(appData, { recursive: true });
  mkdirSync(join(real, "home2"));
  // As macOS's /var points at /private/var. A junction needs no rights on Windows.
  const link = join(root, "link");
  symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");

  assert.equal(insideFolder(join(link, "home", "Library", "Application Support"), home), true);
  assert.equal(insideFolder(appData, join(link, "home")), true);
  assert.equal(insideFolder(join(link, "home"), home), true);
  assert.equal(insideFolder(join(real, "home2"), join(link, "home")), false);
  assert.equal(insideFolder(real, home), false);
});
