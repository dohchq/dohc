import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Static packaging gate: asserts the built tree and electron-builder config
// are release-ready WITHOUT running electron-builder (no network, no heavy
// packaging). Run after `electron-vite build`.

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function check(ok, label) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
}

// --- build outputs ---------------------------------------------------------
for (const output of ["dist/main/main.js", "dist/preload/preload.cjs", "dist/renderer/index.html"]) {
  check(existsSync(join(desktopDir, output)), `build output exists: ${output}`);
}

// --- package metadata ------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
check(pkg.name.includes("dohc"), `package name carries dohc (${pkg.name})`);
check(pkg.main === "dist/main/main.js", "package main points at the built entry");
check(typeof pkg.version === "string" && pkg.version.length > 0, "package version set (artifact naming)");

// --- electron-builder config ----------------------------------------------
// js-yaml ships in the workspace through electron-builder's own tree;
// resolved at runtime instead of adding a direct dependency for one parse.
let config = null;
try {
  const require = createRequire(import.meta.url);
  const yaml = require("js-yaml");
  config = yaml.load(readFileSync(join(desktopDir, "electron-builder.yml"), "utf8"));
} catch (error) {
  check(false, `electron-builder.yml parses (${error.message})`);
}

if (config) {
  check(true, "electron-builder.yml parses");
  check(config.productName === "dohc", "productName is dohc");
  check(typeof config.appId === "string" && config.appId.includes("dohc"), `appId carries dohc (${config.appId})`);
  check(config.asar === true, "asar is enabled");
  check(Array.isArray(config.files) && config.files.includes("dist/**"), "files ship the built dist tree");

  // Fuse hardening intent: electron-builder >=24.12 flips these itself via
  // @electron/fuses at package time — no afterPack hook needed.
  const FUSE_EXPECTATIONS = {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // true is load-bearing: the renderer is module scripts over file://
    // (CORS-mode fetches). scripts/fuse-smoke.mjs proves the boot behavior.
    grantFileProtocolExtraPrivileges: true,
  };
  for (const [fuse, expected] of Object.entries(FUSE_EXPECTATIONS)) {
    check(config.electronFuses?.[fuse] === expected, `electronFuses.${fuse} === ${expected}`);
  }

  // Signing safety: never fake a signature, never hard-require one in the
  // committed config (release pipelines opt in with -c.forceCodeSigning=true).
  check(config.mac?.identity === undefined, "mac.identity is not hard-coded");
  check(config.forceCodeSigning !== true, "forceCodeSigning stays a release-pipeline opt-in");
  check(config.publish?.provider === "generic" && typeof config.publish?.url === "string",
    "publish stub present (generic provider)");
  const fileExtensions = config.fileAssociations?.flatMap((entry) =>
    Array.isArray(entry.ext) ? entry.ext : [entry.ext],
  ) ?? [];
  for (const ext of ["md", "markdown", "txt", "csv", "json"]) {
    check(fileExtensions.includes(ext), `Open with dohc association includes .${ext}`);
  }
}

// --- signing labeling ------------------------------------------------------
// A production-signed release is never implied: without CSC credentials the
// build is loudly unsigned, and a release that REQUIRES signing fails here.
const hasSigningCredentials = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK);
if (process.env.DOHC_REQUIRE_SIGNING === "1") {
  check(hasSigningCredentials, "DOHC_REQUIRE_SIGNING=1 demands CSC_LINK/WIN_CSC_LINK in the env");
}
console.log(hasSigningCredentials
  ? "SIGNING: credentials present (CSC env set)"
  : "SIGNING: unsigned (dev)");

if (failures.length > 0) {
  console.error(`\nPackage smoke FAILED (${failures.length} check${failures.length === 1 ? "" : "s"}).`);
  process.exit(1);
}
console.log("\nPackage smoke passed.");
