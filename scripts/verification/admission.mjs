import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { freeDiskGb, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";

// These suites use ordinary Vitest workers, without native or service setup.
// Unknown suites retain the full lane. Keep this list with their resource inputs.
const lightPackages = new Set(["@dohc/site", "@dohc/collection-views", "@dohc/live-session-contract", "@dohc/security-contract", "@dohc/workspace-contracts"]);
const desktopFiles = new Set(["src/renderer/tokens.test.ts", "src/renderer/workbench/ChatLane.test.tsx", "src/renderer/workbench/ProductDemo.test.tsx"]);
const typecheck = /^tsc --noEmit(?: -p [\w./-]+)?(?: && tsc --noEmit(?: -p [\w./-]+)?)*$/u;
const exactlyFalse = (object, keys) => object && Object.keys(object).length === keys.length && keys.every(key => object[key] === false);

/** Cold or unverifiable dependencies remain under the full build budget. */
export function installedDependenciesMatch(root) {
  try {
    const installed = readFileSync(join(root, "node_modules/.pnpm/lock.yaml"));
    if (!installed.equals(readFileSync(join(root, "pnpm-lock.yaml")))) return false;
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const require = createRequire(join(root, "apps/desktop/package.json"));
    if (require("pnpm").version !== manifest.engines?.pnpm) return false;
    const modules = readFileSync(join(root, "node_modules/.modules.yaml"), "utf8");
    if (!modules.includes(`pnpm@${manifest.engines.pnpm}`)) return false;
    for (const name of ["typescript", "vitest", "js-yaml"]) require.resolve(`${name}/package.json`);
    return true;
  } catch { return false; }
}

/** Eligibility describes resources, never which verification coverage to omit. */
export function verificationAdmission({ gates, javascript }, packages, dependenciesReady) {
  const full = reason => ({ lightweight: false, reason });
  if (!gates?.js || gates.rust || !javascript || javascript.full !== false) return full("Full or native verification.");
  if (!dependenciesReady) return full("Dependencies need installation or cannot be verified.");
  if (javascript.repository !== "source" || javascript.desktopScripts !== false ||
      !exactlyFalse(javascript.needs, ["engine", "desktop", "postgres"]) ||
      !exactlyFalse(javascript.proofs, ["accounts", "selfHostNative", "desktop", "statesPage"])) return full("Build, service, browser, or repository contracts selected.");
  if (!Array.isArray(javascript.packages) || javascript.packages.length < 1 || javascript.packages.length > 2 ||
      new Set(javascript.packages).size !== javascript.packages.length) return full("Package count is outside the light budget.");
  if (packages.some(pkg => pkg.manifest.scripts?.typecheck && (!typecheck.test(pkg.manifest.scripts.typecheck) || pkg.manifest.scripts.pretypecheck || pkg.manifest.scripts.posttypecheck))) return full("A workspace typecheck has an unbounded custom command.");
  for (const name of javascript.packages) {
    const pkg = packages.find(pkg => pkg.name === name);
    const script = pkg?.manifest.scripts?.[name === "@dohc/desktop" ? "test:unit" : "test"];
    if (script !== "vitest run") return full(`Unbounded or unknown test command: ${name}.`);
    if (name === "@dohc/desktop") {
      const files = javascript.testFiles?.[name];
      if (!Array.isArray(files) || !files.length || files.some(file => !desktopFiles.has(file))) return full("Desktop suite requires the full lane.");
    } else if (!lightPackages.has(name)) return full(`No audited light resource contract: ${name}.`);
    if (Object.keys(pkg.manifest.scripts).some(key => /^(?:pre|post)(?:test(?::unit)?|typecheck)$/u.test(key))) return full(`Custom test or typecheck hook: ${name}.`);
  }
  return { lightweight: true, reason: "Warm dependencies, audited suites, sequential commands, one test worker." };
}

/** Host/tool failures can be rejected before waiting; installations stay after admission. */
export function admissionPreflight({ rust = false, native = false, root, pins = {}, platform = process.platform, nodeVersion = process.versions.node, command = execFileSync } = {}) {
  const [major, minor] = nodeVersion.split(".").map(Number);
  if (!(major > 24 || major === 24 && minor >= 14)) throw new Error("Verification requires Node 24.14 or newer.");
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
