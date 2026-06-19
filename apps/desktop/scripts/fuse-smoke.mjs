import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Packaged-fuse boot gate: copies the Electron dist, flips the EXACT fuse
// values from electron-builder.yml (the same flip electron-builder performs
// at package time), packs dist/ into resources/app.asar, and runs the
// regular boot smoke against that binary. This is the only gate that can see
// fuse-dependent breakage — e.g. grantFileProtocolExtraPrivileges: false
// CORS-blocks the file:// module scripts and ships a blank window — without
// a full electron-builder run. Linux layout only (where the dev gates run).
// Headless environments need: DOHC_E2E_NO_CHROMIUM_SANDBOX=1 xvfb-run -a.

if (process.platform !== "linux") {
  console.error("fuse-smoke supports the linux Electron dist layout only.");
  process.exit(1);
}

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktopDir, "scripts/fuse-smoke.mjs"));

// Resolve a dependency's package root from its entry point (pnpm-safe).
function packageRoot(name) {
  const marker = join("node_modules", name) + sep;
  const resolved = require.resolve(name);
  const index = resolved.lastIndexOf(marker);
  if (index === -1) throw new Error(`cannot locate package root for ${name}`);
  return resolved.slice(0, index + marker.length);
}

const fuses = require("js-yaml").load(
  require("node:fs").readFileSync(join(desktopDir, "electron-builder.yml"), "utf8"),
).electronFuses;

const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
const FUSE_OPTION = {
  runAsNode: FuseV1Options.RunAsNode,
  enableCookieEncryption: FuseV1Options.EnableCookieEncryption,
  enableNodeOptionsEnvironmentVariable: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
  enableNodeCliInspectArguments: FuseV1Options.EnableNodeCliInspectArguments,
  // Asar integrity is enforced on mac/win only, so flipping it on cannot
  // reject our unhashed test asar here on linux.
  enableEmbeddedAsarIntegrityValidation: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
  onlyLoadAppFromAsar: FuseV1Options.OnlyLoadAppFromAsar,
  grantFileProtocolExtraPrivileges: FuseV1Options.GrantFileProtocolExtraPrivileges,
};

const stage = mkdtempSync(join(tmpdir(), "dohc-fuse-smoke-"));
try {
  const electronDir = join(stage, "electron");
  cpSync(join(packageRoot("electron"), "dist"), electronDir, { recursive: true });

  // Stage the app exactly as packaging ships it: package.json + dist/** plus
  // zod, the only externalized npm dep main.js loads at boot (electron-updater
  // and typescript are lazy and gated off in the smoke).
  const appDir = join(stage, "app");
  mkdirSync(appDir);
  writeFileSync(
    join(appDir, "package.json"),
    JSON.stringify({ name: "dohc-fuse-smoke", version: "0.0.0", main: "dist/main/main.js" }),
  );
  cpSync(join(desktopDir, "dist"), join(appDir, "dist"), { recursive: true });
  cpSync(packageRoot("zod"), join(appDir, "node_modules", "zod"), {
    recursive: true,
    dereference: true,
  });
  await require("@electron/asar").createPackage(appDir, join(electronDir, "resources", "app.asar"));

  const config = { version: FuseVersion.V1 };
  for (const [fuse, value] of Object.entries(fuses)) {
    if (!(fuse in FUSE_OPTION)) throw new Error(`unmapped fuse in electron-builder.yml: ${fuse}`);
    config[FUSE_OPTION[fuse]] = value;
  }
  await flipFuses(join(electronDir, "electron"), config);

  const result = spawnSync(process.execPath, [join(desktopDir, "scripts/smoke-test.mjs")], {
    cwd: join(desktopDir, "../.."),
    stdio: "inherit",
    env: {
      ...process.env,
      DOHC_SMOKE_ELECTRON: join(electronDir, "electron"),
      // Hermetic userData (and single-instance lock) for the packaged boot.
      XDG_CONFIG_HOME: join(stage, "config"),
    },
  });
  if (result.status !== 0) {
    console.error("Fuse smoke FAILED: built app does not boot with release fuse values.");
    process.exit(result.status ?? 1);
  }
  console.log("Fuse smoke passed: built app boots with release fuse values.");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
