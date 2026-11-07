// Builds a fixed, unsigned Windows package of one commit into a delivery
// folder that someone can open beside their installed dohc.
//
//   pnpm qa:preview --commit <full SHA> --base <ref> [--pr <number>] [--output <new folder>]
//
// The checkout must be clean and at --commit. The builder packages it,
// copies the package into the delivery folder, smokes that copy with the
// release workflow's packaged benchmark, and records the hashes in
// manifest.json. `Try it.cmd` in the folder runs launch.mjs, which checks
// those hashes before it starts the app with its own data and no updates.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { sourceFingerprint } from "./build.mjs";
import { git, pnpm, repoRoot, run } from "./process.mjs";
import { MANIFEST_SCHEMA, fileSha256, hashTree } from "./preview-launch.mjs";

const launcherSource = join(import.meta.dirname, "preview-launch.mjs");
const unpacked = join(repoRoot, "apps/desktop/release/win-unpacked");
export const CRITICAL_FILES = {
  executable: "dohc.exe",
  asar: "resources/app.asar",
  engine: "resources/workspace-engine/dohc-workspace-engine.exe",
  runtime: "resources/app-compiler/node.exe",
};
export const TRY_IT_COMMAND = '@echo off\r\n"%~dp0app\\resources\\app-compiler\\node.exe" "%~dp0launch.mjs"\r\nif errorlevel 1 pause\r\n';
const usage = "Usage: pnpm qa:preview --commit <full SHA> --base <ref> [--pr <number>] [--output <new folder>]";

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    const key = { "--commit": "commit", "--base": "base", "--pr": "pr", "--output": "output" }[flag];
    if (!key) throw new Error(`Unknown option: ${flag}\n${usage}`);
    if (options[key] !== undefined) throw new Error(`Duplicate option: ${flag}`);
    if (!value || value.startsWith("--")) throw new Error(`Missing value: ${flag}`);
    options[key] = value;
  }
  if (!/^[a-f\d]{40}$/u.test(options.commit ?? "")) throw new Error(`--commit must be the full 40-character commit SHA.\n${usage}`);
  if (!options.base) throw new Error(`--base is required.\n${usage}`);
  if (options.pr !== undefined && !/^[1-9]\d*$/u.test(options.pr)) throw new Error("--pr must be a pull request number.");
  const id = `${options.pr ? `pr-${options.pr}-` : ""}${options.commit.slice(0, 12)}`;
  return { ...options, pr: options.pr ? Number(options.pr) : null, id,
    output: resolve(options.output ?? join(homedir(), "dohc-previews", id)) };
}

// The package may come only from the named commit with nothing changed,
// added or deleted. Ignored build output is not source.
export function requirePinnedSource(root, commit) {
  const head = git(["rev-parse", "HEAD"], root);
  if (head !== commit) throw new Error(`The checkout is at ${head}, not ${commit}.`);
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], root);
  if (status) throw new Error(`The checkout has uncommitted changes:\n${status}`);
  return { commit: head, tree: git(["rev-parse", "HEAD^{tree}"], root) };
}

export function resolveBase(root, base, commit) {
  const sha = git(["rev-parse", "--verify", `${base}^{commit}`], root);
  return { ref: base, commit: sha, mergeBase: git(["merge-base", sha, commit], root) };
}

// No signing identity, telemetry key or build override reaches the package.
export function packagingEnvironment(source) {
  const env = Object.fromEntries(Object.entries(source).filter(([name]) =>
    !/^(?:VITE_|DOHC_|CSC_|WIN_CSC_|APPLE_|NODE_OPTIONS$|NODE_ENV$|ELECTRON_RUN_AS_NODE$)/iu.test(name)));
  return { ...env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
}

// The engine entry point owns admission. Keep its configured slot and disk floor.
export function engineBuildEnvironment(source) {
  const env = packagingEnvironment(source);
  for (const name of ["DOHC_BUILD_SLOT_ROOT", "DOHC_GATE_DISK_FLOOR_GB"]) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

// The smoke must have finished against these exact package files.
export function checkSmoke(result, critical) {
  const problems = [];
  if (result?.status !== "complete") problems.push(`status is ${result?.status ?? "missing"}`);
  for (const [field, name] of [["binarySha256", "executable"], ["asarSha256", "asar"], ["engineSha256", "engine"]]) {
    if (result?.[field] !== critical[name]) problems.push(`${field} ${result?.[field]} is not the package's ${critical[name]}`);
  }
  if (problems.length) throw new Error(`The packaged smoke did not pass: ${problems.join("; ")}.`);
}

export function tryItText({ output, manifestSha256, manifest }) {
  const change = manifest.source.pr ? `PR #${manifest.source.pr}` : "this change";
  return [
    `Try ${change} at ${manifest.source.commit}:`,
    `  Open "${join(output, "Try it.cmd")}"`,
    "",
    "Start only with Try it.cmd. Opening app\\dohc.exe directly uses the installed app's profile and link handler.",
    `The launcher keeps its profile and home in ${join(output, "data")}, and offers no product updates.`,
    "Open only a new folder or a copy of a workspace. Opening a workspace used by installed dohc can upgrade it so that build cannot open it.",
    `Package: ${manifest.package.files} files, ${manifest.package.treeSha256}`,
    `Manifest: ${manifestSha256}`,
    `Signing: ${manifest.signing.status}. Smoke: ${manifest.smoke.status}.`,
    "Deleting this folder removes only what is inside it. Workspaces opened elsewhere stay there.",
  ].join("\n");
}

// Every executable and library, with its signer. Vendors such as Node and
// Microsoft sign some of the files electron-builder copies in.
async function authenticode(packageDir) {
  const script = `$root = '${packageDir.replaceAll("'", "''")}'
@(Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll' } | ForEach-Object {
  $s = Get-AuthenticodeSignature -LiteralPath $_.FullName
  [pscustomobject]@{ path = $_.FullName.Substring($root.Length + 1).Replace('\\', '/'); status = $s.Status.ToString(); signer = $s.SignerCertificate.Subject }
}) | ConvertTo-Json -Compress`;
  // An encoded command keeps the script's quotes and lines intact through the job wrapper.
  const { stdout } = await run("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { quietStdout: true });
  return [JSON.parse(stdout.trim())].flat();
}

// dohc's own binaries decide the status. A vendor's signature is recorded but does not count.
export function signingStatus(binaries) {
  const own = binaries.filter((binary) => [CRITICAL_FILES.executable, CRITICAL_FILES.engine].includes(binary.path));
  if (own.length !== 2) throw new Error("The package's executable or engine is missing from the signature check.");
  return { status: own.every((binary) => binary.status === "NotSigned") ? "unsigned" : own.map((binary) => `${binary.path}: ${binary.status}`).join(", "), binaries };
}

async function criticalHashes(packageDir) {
  return Object.fromEntries(await Promise.all(Object.entries(CRITICAL_FILES)
    .map(async ([name, path]) => [name, await fileSha256(join(packageDir, path))])));
}

async function main(options) {
  if (process.platform !== "win32") throw new Error("qa:preview packages Windows previews only.");
  const source = requirePinnedSource(repoRoot, options.commit);
  const base = resolveBase(repoRoot, options.base, options.commit);
  if (existsSync(options.output)) throw new Error(`${options.output} already exists. Choose a new --output.`);
  mkdirSync(options.output, { recursive: true });
  const evidence = join(options.output, "evidence");
  const manifestPath = join(options.output, "manifest.json");
  const fingerprints = () => ({ engine: sourceFingerprint("engine"), desktop: sourceFingerprint("desktop") });
  const before = fingerprints();
  const manifest = {
    schema: MANIFEST_SCHEMA, id: options.id, createdAt: new Date().toISOString(), status: "building",
    source: { commit: source.commit, tree: source.tree, pr: options.pr, base,
      checkout: repoRoot, verified: "HEAD matched --commit and git status was empty before and after packaging; source fingerprints matched." },
    host: { platform: process.platform, arch: process.arch, node: process.version },
    build: { version: JSON.parse(readFileSync(join(repoRoot, "apps/desktop/package.json"), "utf8")).version,
      fingerprints: before, steps: [] },
    package: { directory: "app", executable: CRITICAL_FILES.executable },
    signing: { status: "unknown" },
    smoke: { status: "not run" },
    isolation: "Own --user-data-dir, HOME, USERPROFILE, APPDATA and LOCALAPPDATA under data/; DOHC_* and agent config variables removed; --dohc-isolated-test. A data boundary, not an OS sandbox.",
    updates: "The launcher points DOHC_UPDATE_URL at a 127.0.0.1 feed that offers version 0.0.0 with no files, for as long as it runs.",
  };
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  save();
  const step = async (name, command, args, env) => {
    const log = join(evidence, `${name}.log`), started = Date.now();
    try { await run(command, args, { env, log }); }
    finally {
      manifest.build.steps.push({ name, command: [command, ...args].join(" "), seconds: (Date.now() - started) / 1000,
        log: `evidence/${name}.log`, logSha256: existsSync(log) ? await fileSha256(log) : null });
      save();
    }
  };
  try {
    const env = packagingEnvironment(process.env);
    await step("install", ...pnpm(["install", "--frozen-lockfile", "--config.confirm-modules-purge=false"]), env);
    await step("desktop", ...pnpm(["--filter", "@dohc/desktop", "build"]), env);
    await step("engine", process.execPath,
      [join(repoRoot, "apps/desktop/scripts/build-workspace-engine.mjs")], engineBuildEnvironment(process.env));
    await step("package", ...pnpm(["--filter", "@dohc/desktop", "exec", "electron-builder", "--dir", "--publish", "never"]), env);
    requirePinnedSource(repoRoot, options.commit);
    const after = fingerprints();
    if (after.engine !== before.engine || after.desktop !== before.desktop) throw new Error("Source inputs changed while packaging.");

    const packageDir = join(options.output, manifest.package.directory);
    cpSync(unpacked, packageDir, { recursive: true, errorOnExist: true, force: false });
    const [built, copied] = await Promise.all([hashTree(unpacked), hashTree(packageDir)]);
    if (built.sha256 !== copied.sha256) throw new Error("The copied package differs from electron-builder's output.");
    const critical = await criticalHashes(packageDir);
    Object.assign(manifest.package, { files: copied.files, treeSha256: copied.sha256, critical });
    manifest.signing = signingStatus(await authenticode(packageDir));
    copyFileSync(launcherSource, join(options.output, "launch.mjs"));
    manifest.launcher = { file: "launch.mjs", sha256: await fileSha256(join(options.output, "launch.mjs")) };
    writeFileSync(join(options.output, "Try it.cmd"), TRY_IT_COMMAND);
    manifest.status = "smoking";
    manifest.smoke = { status: "running" };
    save();

    // The release workflow's Windows packaged smoke: edit, persist and
    // restart in a fresh profile, with its own no-update feed.
    const smokeOutput = join(evidence, "smoke");
    const smokeArgs = [join(repoRoot, "tools/perf-profiling/packaged-benchmark.mjs"), "--package-dir", packageDir,
      "--package-commit", source.commit, "--output", smokeOutput, "--label", "candidate",
      "--runs", "1", "--idle-seconds", "1", "--keystrokes", "5", "--switches", "1"];
    manifest.smoke = { status: "failed", command: ["node", ...smokeArgs].join(" "), result: "evidence/smoke/result.json" };
    try { await run(process.execPath, smokeArgs, { env, log: join(evidence, "smoke.log"), timeoutMs: 15 * 60_000 }); }
    finally {
      const resultPath = join(smokeOutput, "result.json");
      if (existsSync(resultPath)) manifest.smoke.resultSha256 = await fileSha256(resultPath);
      save();
    }
    checkSmoke(JSON.parse(readFileSync(join(smokeOutput, "result.json"), "utf8")), critical);
    const smoked = await hashTree(packageDir);
    if (smoked.sha256 !== copied.sha256) throw new Error("The package changed during its smoke.");
    Object.assign(manifest.smoke, { status: "passed", packageTreeSha256: smoked.sha256 });
    manifest.status = "ready";
    save();
  } catch (error) {
    manifest.status = "failed";
    manifest.error = error.message;
    save();
    throw error;
  }
  const manifestSha256 = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  console.log("\n" + tryItText({ output: options.output, manifestSha256, manifest }));
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try { await main(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
