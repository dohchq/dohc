import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertReleaseFuses, compilePackagedApp } from "./fuse-smoke.mjs";
import { stageAppCompiler } from "./stage-app-compiler.mjs";

const require = createRequire(import.meta.url);
const { FuseState, FuseVersion, FuseV1Options } = require("@electron/fuses");
const configured = require("js-yaml").load(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8")).electronFuses;
const actual = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: FuseState.DISABLE,
  [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
  [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.ENABLE,
};

test("packaged fuse verification accepts the configured release wire", () => {
  assert.doesNotThrow(() => assertReleaseFuses(actual, configured));
});

test("packaged fuse verification rejects disabled hardening, missing settings and broken file loading", () => {
  for (const option of Object.keys(actual).filter(key => key !== "version")) {
    const mismatch = actual[option] === FuseState.ENABLE ? FuseState.DISABLE : FuseState.ENABLE;
    assert.throws(() => assertReleaseFuses({ ...actual, [option]: mismatch }, configured), /does not match/);
    const missing = { ...actual };
    delete missing[option];
    assert.throws(() => assertReleaseFuses(missing, configured), /does not match/);
  }
});

test("packaged fuse verification fails closed on unsupported wire versions and configuration", () => {
  assert.throws(() => assertReleaseFuses({ ...actual, version: "2" }, configured), /wire version/);
  assert.throws(() => assertReleaseFuses(actual, { ...configured, unknownFuse: true }), /Unsupported release fuse setting/);
  assert.throws(() => assertReleaseFuses(actual, { ...configured, runAsNode: "false" }), /Unsupported release fuse setting/);
});

test("packaged compile smoke builds through the arm64 owner and fails on a broken compiler",
  { skip: process.platform !== "darwin" || process.arch !== "arm64", timeout: 60000 }, async t => {
  const resources = await mkdtemp(join(tmpdir(), "dohc-fuse-smoke-compile-"));
  t.after(() => rm(resources, { recursive: true, force: true }));
  await stageAppCompiler({ destination: join(resources, "app-compiler") });
  await compilePackagedApp(resources);
  await writeFile(join(resources, "app-compiler/worker.mjs"), "process.exit(3);");
  await assert.rejects(compilePackagedApp(resources), /The packaged app compiler failed/);
});
