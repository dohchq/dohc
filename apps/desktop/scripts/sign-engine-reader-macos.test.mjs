import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { stageEngineReader, requireEngineReader } from "./stage-engine-reader.mjs";
import { installedReaderConfig } from "../src/workspaces/installedReaderConfig.ts";
import signReader from "./sign-engine-reader-macos.mjs";

const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve("electron-builder/package.json"));
builder("app-builder-lib");
const desktop = fileURLToPath(new URL("..", import.meta.url));
const { resolveFunction } = builder("app-builder-lib/out/util/resolve.js");
const config = load(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));

async function removeLayout(path) {
  const base = join(path, "engine-reader");
  await chmod(base, 0o700).catch(() => {});
  for (const entry of await readdir(base).catch(() => [])) await chmod(join(base, entry), 0o700).catch(() => {});
  await rm(path, { recursive: true, force: true });
}

test("packaged macOS reader signing", { timeout: 180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "dohc-reader-signing-")), source = join(root, "source");
  t.after(async () => { await removeLayout(source); await rm(root, { recursive: true, force: true }); });
  const staged = await stageEngineReader({ resources: source, platform: "darwin", arch: "arm64" });
  const sourceBase = join(source, "engine-reader");
  const stale = ["b".repeat(64), ".staging-leaked", ".selection-leaked.json"];
  for (const name of stale.slice(0, 2)) {
    await mkdir(join(sourceBase, name));
    await writeFile(join(sourceBase, name, "node"), "unselected executable");
    await chmod(join(sourceBase, name), 0o555);
  }
  await writeFile(join(sourceBase, stale[2]), "unselected");
  await writeFile(join(sourceBase, "node-LICENSE.txt"), "synthetic license fixture");
  const sourceEntries = (await readdir(sourceBase)).sort();
  let serial = 0;
  async function fixture(owner) {
    const name = `check-${++serial}`, app = join(root, `${name}.app`), resources = join(app, "Contents/Resources");
    await cp(source, resources, { recursive: true });
    const original = await requireEngineReader(resources, "darwin", "arm64");
    const context = { appOutDir: root, electronPlatformName: "darwin", arch: 3, packager: { appInfo: { productFilename: name } } };
    const modes = new Map();
    const setMode = async (path, mode) => { modes.set(path, mode); await chmod(path, mode); };
    owner.after(async () => { await removeLayout(resources); await rm(app, { recursive: true, force: true }); });
    async function prepare() {
      if (config.afterPack) {
        const hook = await resolveFunction("module", join(desktop, config.afterPack), "afterPack", desktop);
        await hook(context, { chmod: setMode });
      }
    }
    return { app, resources, original, modes, setMode, prepare };
  }
  await t.test("removes unselected generations only from the app copy", async sub => {
    const f = await fixture(sub);
    await f.prepare();
    assert.deepEqual((await readdir(join(f.resources, "engine-reader"))).sort(), [staged.generation, "selection.json", "node-LICENSE.txt"].sort());
    assert.deepEqual((await readdir(sourceBase)).sort(), sourceEntries);
    for (const name of stale.slice(0, 2)) assert.equal(await readFile(join(sourceBase, name, "node"), "utf8"), "unselected executable");
  });
  await t.test("makes reader assets readable by every account", async sub => {
    const f = await fixture(sub);
    await f.prepare();
    const base = join(f.resources, "engine-reader");
    for (const [path, mode] of [[base, 0o555], [dirname(f.original.node), 0o555], [join(base, "selection.json"), 0o444], [f.original.manifest, 0o444]]) {
      assert.equal(f.modes.get(path), mode, `requested POSIX mode for ${path}`);
      if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, mode);
    }
  });
  for (const scenario of ["compiler signing", "transient timestamp failures", "permanent signing failure", "verification failure", "ad hoc signing"]) {
    await t.test(`handles ${scenario}`, async sub => {
      const f = await fixture(sub);
      await f.prepare();
      let attempts = 0, verifications = 0, sealed = false;
      const waits = [];
      const options = { app: f.app, platform: "darwin", identity: scenario === "ad hoc signing" ? "-" : "synthetic-app-identity", keychain: "/synthetic.keychain",
        ignore: file => file.endsWith("already-ignored") };
      const operation = signReader(options, {}, {
        chmod: f.setMode,
        wait: async ms => { waits.push(ms); },
        run: async (command, args) => {
          assert.equal(command, "/usr/bin/codesign");
          if (args.includes("--sign")) {
            attempts++;
            if (scenario === "permanent signing failure" || scenario === "transient timestamp failures" && attempts < 3) throw Error("timestamp server unavailable");
            assert.equal(args[args.indexOf("--sign") + 1], options.identity);
            assert.equal(args[args.indexOf("--options") + 1], "runtime");
            assert.equal(args[args.indexOf("--keychain") + 1], options.keychain);
            assert.ok(args.includes(options.identity === "-" ? "--timestamp=none" : "--timestamp"));
            const plist = await readFile(args[args.indexOf("--entitlements") + 1], "utf8");
            assert.deepEqual([...plist.matchAll(/<key>([^<]+)<[/]key>/g)].map(match => match[1]), ["com.apple.security.cs.allow-jit"]);
            await writeFile(f.original.node, Buffer.concat([await readFile(f.original.node), Buffer.from("synthetic signature")]));
          } else {
            verifications++;
            assert.deepEqual(args, ["--verify", "--strict", f.original.node]);
            if (scenario === "verification failure") throw Error("invalid code signature");
          }
        },
        signApp: async signedOptions => {
          sealed = true;
          assert.equal(verifications, 1);
          const final = JSON.parse(installedReaderConfig(f.resources, "darwin", "arm64"));
          const finalManifest = JSON.parse(await readFile(final.manifest, "utf8"));
          assert.notEqual(final.node, f.original.node);
          assert.equal(finalManifest.runtime.sha256, createHash("sha256").update(await readFile(final.node)).digest("hex"));
          const { sources, buildSha256, ...identity } = finalManifest;
          assert.equal(buildSha256, createHash("sha256").update(JSON.stringify(identity)).digest("hex"));
          assert.equal(dirname(final.node), join(f.resources, "engine-reader", buildSha256));
          assert.ok(signedOptions.ignore(final.node));
          assert.equal(signedOptions.ignore(join(f.resources, "app-compiler/node")), false);
          assert.ok(signedOptions.ignore("already-ignored"));
          assert.equal(signedOptions.ignore(join(f.resources, "workspace-engine/dohc-workspace-engine")), false);
          assert.equal(signedOptions.optionsForFile, options.optionsForFile);
          for (const [path, mode] of [[join(f.resources, "engine-reader"), 0o555], [dirname(final.node), 0o555], [join(f.resources, "engine-reader/selection.json"), 0o444], [final.manifest, 0o444]]) {
            assert.equal(f.modes.get(path === final.manifest ? f.original.manifest : path), mode);
            if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, mode);
          }
        },
      });
      if (scenario === "permanent signing failure") {
        await assert.rejects(operation, /timestamp server unavailable/);
        assert.equal(attempts, 3);
        assert.equal(verifications, 0);
        assert.equal(sealed, false);
        assert.deepEqual(waits, [5000, 10000]);
      } else if (scenario === "verification failure") {
        await assert.rejects(operation, /invalid code signature/);
        assert.equal(attempts, 1);
        assert.equal(verifications, 1);
        assert.equal(sealed, false);
        assert.deepEqual(waits, []);
      } else {
        await operation;
        assert.equal(sealed, true);
        assert.equal(attempts, scenario === "transient timestamp failures" ? 3 : 1);
        assert.deepEqual(waits, scenario === "transient timestamp failures" ? [5000, 10000] : []);
      }
      await requireEngineReader(source, "darwin", "arm64");
    });
  }
});

for (const [name, force, identity, signature, failure] of [
  ["required signing rejects a missing identity", true, "bad-synthetic-identity", "missing", /unsigned app/],
  ["required signing rejects an ad hoc authority", true, "bad-synthetic-identity", "adhoc", /Developer ID/],
  ["required signing accepts a verified Developer ID", true, "bad-synthetic-identity", "developer", undefined],
  ["unsigned development skips signature checks", false, "bad-synthetic-identity", "missing", undefined],
  ["explicit null identity permits unsigned development", false, null, "missing", undefined],
  ["explicit null identity refuses required signing", true, null, "missing", /forceCodeSigning/],
]) test(`electron-builder sign path: ${name}`, async t => {
  const { MacPackager } = builder("app-builder-lib/out/macPackager.js");
  const { MacTargetHelper } = builder("app-builder-lib/out/mac/MacTargetHelper.js");
  const { PlatformPackager } = builder("app-builder-lib/out/platformPackager.js");
  const codesign = builder("app-builder-lib/out/codeSign/macCodeSign.js");
  t.mock.method(codesign, "isSignAllowed", () => true);
  t.mock.method(codesign, "findIdentity", async () => null);
  const root = await mkdtemp(join(tmpdir(), "dohc-reader-sign-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dohc.app"));
  assert.ok(config.mac.sign);
  let checks = 0, afterSign = 0;
  const packager = {
    forceCodeSigning: force, platformSpecificBuildOptions: { ...config.mac, identity, type: "distribution" },
    codeSigningInfo: { value: Promise.resolve({}) }, appInfo: { productFilename: "dohc" },
    computeAsarOptions: async () => null,
    sign: MacPackager.prototype.sign, signApp: MacPackager.prototype.signApp,
    doSign: () => assert.fail("custom signer must never run without a resolved identity"),
    info: { emitAfterSign: async context => {
      afterSign++;
      if (!config.afterSign) return;
      const hook = await resolveFunction("module", join(desktop, config.afterSign), "afterSign", desktop);
      await hook(context, { run: async (command, args) => {
        checks++;
        assert.equal(command, "/usr/bin/codesign");
        assert.equal(args.at(-1), join(root, "dohc.app"));
        if (args.includes("--verify")) {
          assert.deepEqual(args, ["--verify", "--strict", join(root, "dohc.app")]);
          if (signature === "missing") throw Error("unsigned app");
          return { stdout: "", stderr: "" };
        }
        assert.deepEqual(args, ["--display", "--verbose=2", join(root, "dohc.app")]);
        return { stdout: "", stderr: signature === "developer" ? "Authority=Developer ID Application: Synthetic (SYNTHETIC1)\nTeamIdentifier=SYNTHETIC1\n" : "Signature=adhoc\nTeamIdentifier=not set\n" };
      } });
    } },
  };
  packager.helper = new MacTargetHelper(packager);
  const operation = PlatformPackager.prototype.doSignAfterPack.call(packager, root, root, "darwin", 3, config.mac, []);
  if (failure) await assert.rejects(operation, failure); else await operation;
  if (identity !== null) assert.equal(afterSign, 1, "the real signApp return emits afterSign even without an identity");
  if (!force) assert.equal(checks, 0, "development needs no signature tools or accounts");
  else if (identity !== null) assert.equal(checks, signature === "missing" ? 1 : 2);
});
