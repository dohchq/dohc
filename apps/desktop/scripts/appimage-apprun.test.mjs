import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const { generateAppRunScript } = builderRequire("app-builder-lib/out/targets/appimage/appImageUtil.js");
const { default: AppImageTarget } = builderRequire("app-builder-lib/out/targets/appimage/AppImageTarget.js");

// patches/app-builder-lib@26.15.3.patch replaces the launcher's --no-sandbox fallback.
test("the AppImage launcher refuses to start without the sandbox instead of disabling it", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-apprun-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appDir = join(root, "AppDir"), record = join(root, "argv.txt");
  await mkdir(appDir);
  await writeFile(join(appDir, "AppRun"), generateAppRunScript({ ExecutableName: "dohc-desktop", ProductFilename: "dohc", ProductName: "dohc" }), { mode: 0o755 });
  await writeFile(join(appDir, "dohc-desktop"),`#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`, { mode: 0o755 });
  const bash = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
  const launch = async (unshare, args) => {
    await rm(record, { force: true });
    const tools = await mkdtemp(join(root, "tools-"));
    await symlink(bash, join(tools, "bash"));
    if (unshare !== undefined) await writeFile(join(tools, "unshare"), `#!/bin/sh\nexit ${unshare}\n`, { mode: 0o755 });
    const result = spawnSync(join(appDir, "AppRun"), args, { env: { PATH: tools, APPDIR: appDir, APPIMAGE: join(root, "dohc.AppImage") }, encoding: "utf8" });
    const argv = await readFile(record, "utf8").then(text => text.split("\n").slice(0, -1), () => null);
    return { started: result.status === 0, argv, stdout: result.stdout };
  };
  // A failed probe and a missing unshare both refuse.
  for (const [unshare, args] of [[1, []], [1, ["notes.md"]], [undefined, ["notes.md"]]]) {
    const refused = await launch(unshare, args);
    assert.deepEqual([refused.started, refused.argv], [false, null]);
    // Without zenity, kdialog or Xdialog, the launcher prints the reason.
    if (!["zenity", "kdialog", "Xdialog"].some(name => spawnSync("test", ["-x", `/usr/bin/${name}`]).status === 0)) {
      assert.match(refused.stdout, /can't start its security sandbox because it can't create user namespaces on this system\. On Ubuntu or Debian, install the dohc \.deb package instead\. Elsewhere, allow this AppImage/);
    }
  }
  const started = async (unshare, args) => { const { started, argv } = await launch(unshare, args); return { started, argv }; };
  assert.deepEqual(await started(0, ["--enable-logging", "notes.md"]), { started: true, argv: ["--enable-logging", "notes.md"] });
  // A person who passes --no-sandbox chose it; the launcher adds nothing.
  assert.deepEqual(await started(1, ["--no-sandbox"]), { started: true, argv: ["--no-sandbox"] });
});

test("the AppImage desktop entry passes no launch arguments", async () => {
  const config = load(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const packager = { platformSpecificBuildOptions: config.linux, config, appInfo: { buildVersion: "0.0.0" } };
  const target = new AppImageTarget(null, packager, { computeDesktopEntry: (_options, exec) => exec }, "release");
  assert.equal(await target.desktopEntry.value, "AppRun %U");
});
