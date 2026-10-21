import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInstalledAppCompiler } from "../src/workspaces/installedAppCompiler.ts";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { getCurrentFuseWire, FuseState, FuseVersion, FuseV1Options } = require("@electron/fuses");
const FUSE_OPTION = {
  runAsNode: FuseV1Options.RunAsNode,
  enableCookieEncryption: FuseV1Options.EnableCookieEncryption,
  enableNodeOptionsEnvironmentVariable: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
  enableNodeCliInspectArguments: FuseV1Options.EnableNodeCliInspectArguments,
  enableEmbeddedAsarIntegrityValidation: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
  onlyLoadAppFromAsar: FuseV1Options.OnlyLoadAppFromAsar,
  grantFileProtocolExtraPrivileges: FuseV1Options.GrantFileProtocolExtraPrivileges,
};

export function assertReleaseFuses(actual, configured) {
  if (actual.version !== FuseVersion.V1) throw new Error("Unsupported packaged fuse wire version.");
  // A packaging instruction beside the fuses, not a fuse in the wire.
  const { resetAdHocDarwinSignature: _resign, ...fuses } = configured;
  for (const [name, enabled] of Object.entries(fuses)) {
    if (!Object.hasOwn(FUSE_OPTION, name) || typeof enabled !== "boolean") {
      throw new Error(`Unsupported release fuse setting: ${name}`);
    }
    const expected = enabled ? FuseState.ENABLE : FuseState.DISABLE;
    if (actual[FUSE_OPTION[name]] !== expected) {
      throw new Error(`Packaged release fuse does not match electron-builder.yml: ${name}`);
    }
  }
}

/**
 * Builds one small app through the package's own signed owner, Node and
 * esbuild, which proves signing, entitlements and the sandbox in the bundle.
 */
export async function compilePackagedApp(resourcesRoot) {
  const compile = await createInstalledAppCompiler(resourcesRoot);
  const bytes = Buffer.from('document.body.textContent = "packaged compile";');
  const request = { entryPath: "main.js", inputs: [{ path: "main.js", bytes, sha256: createHash("sha256").update(bytes).digest("hex") }],
    bounds: { maxInputFiles: 8, maxInputBytes: 8192, maxOutputBytes: 16384 } };
  const bounds = { timeoutMs: 60_000, maxMemoryBytes: 1024 * 1024 * 1024, maxProcesses: 8, maxInputBytes: 16384, maxOutputBytes: 32768, maxErrorBytes: 65536 };
  const result = await compile(request, bounds).catch(error => { throw new Error(`The packaged app compiler failed: ${error.message}`); });
  const bundle = result.files.find(file => file.path === "bundle.js");
  if (!bundle || !Buffer.from(bundle.bytes).toString("utf8").includes("packaged compile")) throw new Error("The packaged app compiler built the wrong bundle.");
}

// electron-builder's unpacked output for each platform the smoke boots. A Mac
// package is the .app bundle; @electron/fuses reads its Electron Framework.
const PACKAGES = {
  linux: { name: "Linux", directory: "release/linux-unpacked", binary: "dohc-desktop", asar: "resources/app.asar", fuses: "dohc-desktop" },
  darwin: {
    name: "macOS",
    directory: "release/mac-arm64/dohc.app",
    binary: "Contents/MacOS/dohc",
    asar: "Contents/Resources/app.asar",
    fuses: ".",
  },
};

async function smoke() {
  const target = PACKAGES[process.platform];
  if (!target) throw new Error("Fuse smoke supports Linux and macOS packages only.");
  const packageDir = resolve(process.env.DOHC_SMOKE_PACKAGE_DIRECTORY ?? join(desktopDir, target.directory));
  const binary = join(packageDir, target.binary);
  if (!existsSync(binary) || !existsSync(join(packageDir, target.asar))) {
    throw new Error(`${target.name} package missing: ${packageDir}. Run electron-builder before fuse smoke.`);
  }
  const configured = require("js-yaml").load(readFileSync(join(desktopDir, "electron-builder.yml"), "utf8")).electronFuses;
  assertReleaseFuses(await getCurrentFuseWire(join(packageDir, target.fuses)), configured);
  // Apple silicon will not load a framework whose signature no longer matches
  // its bytes, which is what a fuse flip without a re-sign leaves behind.
  if (process.platform === "darwin") {
    const signature = spawnSync("codesign", ["--verify", "--deep", "--strict", packageDir], { encoding: "utf8" });
    if (signature.status !== 0) throw new Error(`The macOS package's signature does not verify:\n${signature.stderr}`);
    await compilePackagedApp(join(packageDir, "Contents/Resources"));
    console.log("Packaged app compile passed through the signed arm64 owner.");
  }

  const profile = mkdtempSync(join(tmpdir(), "dohc-fuse-smoke-"));
  try {
    const result = spawnSync(process.execPath, [join(desktopDir, "scripts/smoke-test.mjs")], {
      cwd: join(desktopDir, "../.."),
      stdio: "inherit",
      env: {
        ...process.env,
        DOHC_SMOKE_ELECTRON: binary,
        DOHC_SMOKE_USER_DATA_DIR: join(profile, "user-data"),
        XDG_CONFIG_HOME: join(profile, "config"),
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Fuse smoke failed: the packaged app did not boot.");
    console.log("Fuse smoke passed: the packaged app boots with verified release fuse values.");
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await smoke().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
