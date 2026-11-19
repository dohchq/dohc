import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builderRequire } from "./electron-builder.testSupport.mjs";

// patches/app-builder-lib@26.15.3.patch keeps an .rpm upgrade from removing the new package's link.
test(
  "the .rpm's after-remove script removes the dohc-desktop link on an erase, not while a copy stays installed",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "dohc-after-remove-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const template = await readFile(
      builderRequire.resolve("app-builder-lib/templates/linux/after-remove.tpl"),
      "utf8",
    );
    const script = join(root, "after-remove.sh");
    await writeFile(
      script,
      template
        .replaceAll("${executable}", "dohc-desktop")
        .replaceAll("${sanitizedProductName}", "dohc")
        .replaceAll("/etc/apparmor.d/", `${root}/`),
    );
    const calls = join(root, "calls.txt");
    await writeFile(
      join(root, "update-alternatives"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`,
      { mode: 0o755 },
    );
    const bash = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
    const run = async (argument) => {
      await rm(calls, { force: true });
      const result = spawnSync(bash, [script, argument], { env: { PATH: root }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return readFile(calls, "utf8").then(
        (text) => text.split("\n").slice(0, -1),
        () => [],
      );
    };
    assert.deepEqual(await run("1"), []);
    assert.deepEqual(await run("2"), []);
    assert.deepEqual(await run("0"), ["--remove dohc-desktop /opt/dohc/dohc-desktop"]);
  },
);
