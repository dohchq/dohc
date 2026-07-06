#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nativeTmpdir = process.platform === "win32" ? tmpdir() : "/tmp";
const rustManifest = join(repoRoot, "crates/workspace-kernel/Cargo.toml");
const kernelBin = join(
  repoRoot,
  `crates/workspace-kernel/target/release/dohc-workspace-kernel${
    process.platform === "win32" ? ".exe" : ""
  }`,
);
const MAX_FILES = 100_000;
const MAX_BYTES_PER_FILE = 1024 * 1024;
const MAX_ITERATIONS = 100;

function parseOptions(argv) {
  const options = {
    files: [1000, 10000],
    bytesPerFile: 1024,
    iterations: 3,
    keepFixture: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--keep-fixture") {
      options.keepFixture = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${value} requires a value`);
    }
    if (value === "--files") {
      options.files = next
        .split(",")
        .map((part) => parsePositiveInteger(value, part, MAX_FILES));
    } else if (value === "--bytes-per-file") {
      options.bytesPerFile = parsePositiveInteger(value, next, MAX_BYTES_PER_FILE);
    } else if (value === "--iterations") {
      options.iterations = parsePositiveInteger(value, next, MAX_ITERATIONS);
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
    index += 1;
  }
  return options;
}

function parsePositiveInteger(name, value, max) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} must be an integer >= 1`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new Error(`${name} must be <= ${max}`);
  }
  return parsed;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: nativeTmpdir },
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

async function createFixture({ files, bytesPerFile }) {
  const root = await mkdtemp(join(nativeTmpdir, "dohc-kernel-bench-"));
  try {
    for (let index = 0; index < files; index += 1) {
      await writeDeterministicFile(root, index, bytesPerFile, "x");
    }
    await mkdir(join(root, ".dohc"), { recursive: true });
    await writeFile(join(root, ".dohc", "hidden.txt"), "hidden");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "config"), "hidden");
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(join(root, "node_modules/pkg/index.js"), "hidden");
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function writeDeterministicFile(root, index, bytesPerFile, fill) {
  const path = join(root, `dir-${index % 50}`, `file-${index}.txt`);
  const prefix = `${index}:`;
  const suffix = "\n";
  const payloadBytes = bytesPerFile - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (payloadBytes < 0) throw new Error("--bytes-per-file is too small for fixture metadata");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${prefix}${fill.repeat(payloadBytes)}${suffix}`);
}

async function mutateFixture(root, files, bytesPerFile) {
  const changed = Math.min(10, files);
  for (let index = 0; index < changed; index += 1) {
    await writeDeterministicFile(root, index, bytesPerFile, "y");
  }
  for (let index = changed; index < Math.min(changed + 10, files); index += 1) {
    await unlink(join(root, `dir-${index % 50}`, `file-${index}.txt`));
  }
  for (let index = files; index < files + 10; index += 1) {
    await writeDeterministicFile(root, index, bytesPerFile, "z");
  }
}

function summarize(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    min_ms: Number(min.toFixed(2)),
    max_ms: Number(max.toFixed(2)),
    avg_ms: Number(avg.toFixed(2)),
  };
}

class KernelBenchClient {
  constructor(binaryPath) {
    this.token = randomBytes(32).toString("hex");
    this.child = spawn(binaryPath, [], {
      cwd: dirname(binaryPath),
      env: { ...process.env, DOHC_KERNEL_TOKEN: this.token },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.nextId = 1;
    this.pending = new Map();
    createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      console.error(`[kernel] ${line}`);
    });
    this.child.once("exit", (code, signal) => {
      const error = new Error(`kernel exited (${code ?? signal ?? "unknown"})`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  request(method, params) {
    return this.requestRaw(method, params).then((message) => message.result);
  }

  requestRaw(method, params) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, token: this.token, params })}\n`,
      );
    });
  }

  handleLine(line) {
    const message = JSON.parse(line);
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message);
  }

  async dispose() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    await new Promise((resolveDispose) => {
      const timer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
        resolveDispose();
      }, 2000);
      timer.unref();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolveDispose();
      });
    });
  }
}

function runTsScan(root) {
  return parseJson(
    run("pnpm", [
      "--dir",
      "packages/workspace-fs",
      "exec",
      "tsx",
      "../../scripts/workspace-kernel-spike/ts-scan.ts",
      "--root",
      root,
      "--json",
    ]),
  );
}

function runTsReconcile(root, manifestPath) {
  return parseJson(
    run("pnpm", [
      "--dir",
      "packages/workspace-fs",
      "exec",
      "tsx",
      "../../scripts/workspace-kernel-spike/ts-reconcile.ts",
      "--root",
      root,
      "--manifest",
      manifestPath,
      "--json",
    ]),
  );
}

function kernelTotalMs(response) {
  const total = response?.timingMs?.total;
  if (typeof total !== "number") throw new Error("kernel response did not include timingMs.total");
  return total;
}

const options = parseOptions(process.argv);
run("cargo", ["build", "--release", "--manifest-path", rustManifest], { stdio: "inherit" });

const rows = [];
for (const files of options.files) {
  let fixture;
  let client;
  let manifestDir;
  try {
    fixture = await createFixture({ files, bytesPerFile: options.bytesPerFile });
    client = new KernelBenchClient(kernelBin);
    await client.request("kernel.handshake", {});

    const manifestScan = await client.request("kernel.scan", { root: fixture });
    const manifest = manifestScan.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      mtime: 0,
    }));
    manifestDir = await mkdtemp(join(nativeTmpdir, "dohc-kernel-bench-manifest-"));
    const manifestPath = join(manifestDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await mutateFixture(fixture, files, options.bytesPerFile);

    const tsScanRuns = [];
    const kernelScanRuns = [];
    const tsReconcileRuns = [];
    const kernelReconcileRuns = [];
    for (let index = 0; index < options.iterations; index += 1) {
      tsScanRuns.push(runTsScan(fixture).metrics.scan_ms);
      // Use timingMs.total from the kernel response so persistent-process protocol overhead is excluded.
      kernelScanRuns.push(kernelTotalMs(await client.requestRaw("kernel.scan", { root: fixture })));
      tsReconcileRuns.push(runTsReconcile(fixture, manifestPath).metrics.reconcile_ms);
      kernelReconcileRuns.push(
        kernelTotalMs(await client.requestRaw("kernel.reconcile", { root: fixture, manifest })),
      );
    }

    rows.push({ operation: "scan", files, implementation: "TypeScript", ...summarize(tsScanRuns) });
    rows.push({ operation: "scan", files, implementation: "Kernel", ...summarize(kernelScanRuns) });
    rows.push({
      operation: "reconcile",
      files,
      implementation: "TypeScript",
      ...summarize(tsReconcileRuns),
    });
    rows.push({
      operation: "reconcile",
      files,
      implementation: "Kernel",
      ...summarize(kernelReconcileRuns),
    });
  } finally {
    if (client) await client.dispose();
    if (manifestDir) await rm(manifestDir, { recursive: true, force: true });
    if (!options.keepFixture && fixture) await rm(fixture, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ iterations: options.iterations, bytes_per_file: options.bytesPerFile, rows }, null, 2));
