import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, hostname, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readGit } from "../../tools/rust-engine-program/git-read.mjs";
import { requireCiPassVerdict } from "../../tools/rust-engine-program/require-ci-pass-verdict.mjs";
import { classifyTreeProvenance } from "../../tools/rust-engine-program/tree-provenance.mjs";

const executedSteps = ["cargo-deny-version", "cargo-audit-version", "cargo-nextest-version", "rust", "rust-verdict"];
const hash = value => createHash("sha256").update(value).digest("hex");
const renderer = path => path.startsWith("apps/desktop/src/renderer/");

// Renderer code is not consumed by the native gate. Every other tracked input
// remains in this comparison, including unknown inputs and verification code.
export function rustGitInputs(root, commit) {
  const entries = readGit(["ls-tree", "-rz", "--full-tree", commit], root).split("\0").filter(Boolean);
  return hash(entries.filter(entry => !renderer(entry.slice(entry.indexOf("\t") + 1))).join("\0"));
}

export function rustIdentity({root, engine, tools, env = process.env}) {
  for (const name of ["rustc", "cargo", "deny", "audit", "nextest"]) {
    if (!tools[name]) throw new Error(`Rust evidence cannot identify ${name}.`);
  }
  const environment = Object.entries(env).map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value])
    .filter(([key]) => /^(CARGO_|RUST|NEXTEST_|DOHC_|CC(?:_|$)|CXX(?:_|$)|AR(?:_|$)|CFLAGS(?:_|$)|CXXFLAGS(?:_|$)|PATH$|NODE_OPTIONS$|CI$|HOME$|USERPROFILE$|TEMP$|TMP$|TMPDIR$|LIB$|LIBPATH$|INCLUDE$|SDKROOT$|MACOSX_DEPLOYMENT_TARGET$|VSCMD_|VSINSTALLDIR$|WINDOWSSDKDIR$|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|SSL_CERT_)/u.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  return {version: 1, platform: process.platform, arch: process.arch, node: process.version,
    host: hash(`${hostname()}\0${release()}\0${availableParallelism()}`), environment: hash(JSON.stringify(environment)), engine, tools,
    configuration: hash(JSON.stringify([".config/nextest.toml", "deny.toml", ".cargo/audit.toml"].map(path => {
      const file = resolve(root, path);
      return [path, existsSync(file) ? hash(readFileSync(file)) : null];
    }))),
    inputs: rustGitInputs(root, "HEAD")};
}

function completeOriginal(report) {
  if (report.mode !== "pr" || report.gates?.rust !== true || !["PASS", "FAIL"].includes(report.verdict) || !report.finishedAt || report.dirty !== false
    || !/^[a-f0-9]{40}$/u.test(report.commit) || report.rustError || report.cleanupError
    || /interrupted|cancelled/iu.test(report.error ?? "")) throw new Error("Rust reuse requires a completed, clean, uninterrupted canonical PR report.");
  const readings = report.treeReadings;
  if (!Array.isArray(readings) || readings.length < 2 || readings.at(-1).step !== "rust-receipt:finish"
    || readings.some(row => row.state?.head !== report.commit || row.state?.dirty?.length !== 0)
    || classifyTreeProvenance(readings).status !== "PASS" || report.provenance?.status !== "PASS") {
    throw new Error("Rust reuse requires final clean tree provenance on the original commit.");
  }
  for (const name of executedSteps) {
    const steps = report.steps.filter(step => step.name === name);
    if (steps.length !== 1 || steps[0].verdict !== "PASS" || !steps[0].finishedAt || !Number.isFinite(steps[0].seconds)
      || steps[0].reused) throw new Error(`Rust reuse requires an executed, complete PASS for ${name}.`);
  }
}

function gateLog(report) {
  const step = report.steps.find(row => row.name === "rust");
  if (resolve(step.log) !== resolve(report.output, "rust.log")) throw new Error("Rust gate log is outside its canonical report.");
  const log = readFileSync(step.log, "utf8");
  requireCiPassVerdict(log, () => report.commit);
  const line = log.split(/\r?\n/u).find(row => row.includes("| run-rust-checks |"));
  if (!line.includes(" clean,") || !line.split(" | ")[2].startsWith(`${process.platform}/${process.arch} (`)) {
    throw new Error("Rust gate must report a clean native run on this platform.");
  }
  if (!log.includes("== summary ==")) throw new Error("Rust gate summary is missing.");
  return hash(log);
}

export function sealRustEvidence(report, identity) {
  completeOriginal(report);
  for (const name of ["rustc", "cargo"]) {
    const check = report.doctor?.checks.find(row => row.name === name && row.state === "PASS");
    if (!check || check.detail !== identity.tools[name]) throw new Error(`Original ${name} tool identity is missing or changed.`);
  }
  const logs = Object.fromEntries(executedSteps.map(name => {
    const step = report.steps.find(row => row.name === name);
    if (resolve(step.log) !== resolve(report.output, `${name}.log`)) throw new Error(`Original ${name} log is outside its report.`);
    const content = readFileSync(step.log);
    if (name.startsWith("cargo-")) {
      const tool = name.slice(6, -8);
      if (content.toString().trim() !== identity.tools[tool]) throw new Error(`Original ${tool} version log does not match its identity.`);
    }
    return [name, hash(content)];
  }));
  return {kind: "executed", identity, logSha256: gateLog(report), logs};
}

export function readRustReuse(path, {root, identity}) {
  if (readGit(["status", "--porcelain", "--untracked-files=all"], root).trim()) {
    throw new Error("Rust reuse requires a clean current checkout.");
  }
  const file = resolve(path);
  const report = JSON.parse(readFileSync(file, "utf8"));
  if (file !== resolve(report.output ?? "", "result.json") || dirname(dirname(dirname(file))) !== resolve(report.root ?? "", ".agent-artifacts")) {
    throw new Error("Rust reuse requires the original canonical result.json in its verification directory.");
  }
  completeOriginal(report);
  if (report.rustEvidence?.kind !== "executed" || report.rustEvidence.identity?.version !== 1) {
    throw new Error("This report has no original Rust identity. Run a fresh Rust job.");
  }
  if (report.rustEvidence.identity.inputs !== rustGitInputs(root, report.commit)) {
    throw new Error("Original Rust input identity does not match its recorded Git commit.");
  }
  const sealed = sealRustEvidence(report, report.rustEvidence.identity);
  if (JSON.stringify(sealed.logs) !== JSON.stringify(report.rustEvidence.logs) || sealed.logSha256 !== report.rustEvidence.logSha256) {
    throw new Error("Original Rust gate log or tool evidence changed.");
  }
  if (JSON.stringify(report.rustEvidence.identity) !== JSON.stringify(identity)) {
    throw new Error("Rust source, configuration, environment, platform, or tools changed. Run a fresh Rust job.");
  }
  const changedFiles = readGit(["diff", "--name-only", "-z", report.commit, "HEAD"], root).split("\0").filter(Boolean);
  if (changedFiles.some(path => !renderer(path))) throw new Error("A native gate input changed. Run a fresh Rust job.");
  return {kind: "reused", report: file, reportSha256: hash(readFileSync(file)), commit: report.commit,
    log: report.steps.find(step => step.name === "rust").log, logSha256: report.rustEvidence.logSha256,
    changedFiles, reason: "Native inputs and execution identity match; changed paths contain only renderer source.",
    identity};
}

export async function refreshRustReuse(path, {root, identity, step}) {
  const evidence = readRustReuse(path, {root, identity});
  await step("cargo-deny-refresh", "cargo", ["deny", "check"]);
  await step("cargo-audit-refresh", "cargo", ["audit"]);
  return {...evidence, security: "cargo-deny and cargo-audit passed in this run"};
}
