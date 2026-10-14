import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { freeDiskGb, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";

/** The typecheck can run before queueing only on the lockfile's installed dependencies. */
export function installedDependenciesMatch(root) {
  try {
    const installed = readFileSync(join(root, "node_modules/.pnpm/lock.yaml"));
    if (!installed.equals(readFileSync(join(root, "pnpm-lock.yaml")))) return false;
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const require = createRequire(join(root, "apps/desktop/package.json"));
    if (require("pnpm").version !== manifest.engines?.pnpm) return false;
    const modules = readFileSync(join(root, "node_modules/.modules.yaml"), "utf8");
    if (!modules.includes(`pnpm@${manifest.engines.pnpm}`)) return false;
    require.resolve("typescript/package.json");
    return true;
  } catch { return false; }
}

/** Host/tool failures can be rejected before waiting; installations stay after admission. */
export function admissionPreflight({ rust = false, native = false, root, pins = {}, platform = process.platform, nodeVersion = process.versions.node, command = execFileSync } = {}) {
  const [major, minor] = nodeVersion.split(".").map(Number);
  if (!(major > 24 || major === 24 && minor >= 16)) throw new Error("Verification requires Node 24.16 or newer.");
  const options = { encoding: "utf8", windowsHide: true, timeout: 10_000, env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" } };
  if (platform === "win32") {
    const version = command("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], options).trim();
    if (Number(version.split(".")[0]) < 7) throw new Error("Verification requires PowerShell 7 on PATH.");
  }
  if (native) for (const tool of ["rustc", "cargo"]) command(tool, ["--version"], options);
  if (rust) for (const [tool, key] of [["deny", "CARGO_DENY_VERSION"], ["audit", "CARGO_AUDIT_VERSION"], ["nextest", "CARGO_NEXTEST_VERSION"]]) {
    const version = command("cargo", [tool, "--version"], options).trim().split(/\r?\n/u)[0].split(/\s+/u)[1];
    if (!pins[key] || version !== pins[key]) throw new Error(`Install cargo-${tool} ${pins[key]} to match the workflow before queueing.`);
  }
  if (native && root) {
    const budget = resolveBuildBudget();
    const free = freeDiskGb(root);
    if (budget && (free === null || free < budget.diskFloorGb)) throw new Error(`Build needs ${budget.diskFloorGb} GB free; observed ${free ?? "unknown"}.`);
  }
}
