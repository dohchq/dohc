#!/usr/bin/env node
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nativeTmpdir = process.platform === "win32" ? tmpdir() : "/tmp";
const rustManifest = join(repoRoot, "crates/workspace-kernel-spike/Cargo.toml");
const MAX_FILES = 100_000;
const MAX_BYTES_PER_FILE = 1024 * 1024;
const MAX_ITERATIONS = 100;
const rustBin = join(
  repoRoot,
  `crates/workspace-kernel-spike/target/release/dohc-workspace-kernel-spike${
    process.platform === "win32" ? ".exe" : ""
  }`,
);

function parseOptions(argv) {
  const options = {
    files: 1000,
    bytesPerFile: 1024,
    iterations: 3,
    keepFixture: false,
  };
  const flags = new Map([
    ["--files", ["files", MAX_FILES]],
    ["--bytes-per-file", ["bytesPerFile", MAX_BYTES_PER_FILE]],
    ["--iterations", ["iterations", MAX_ITERATIONS]],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--keep-fixture") {
      options.keepFixture = true;
      continue;
    }
    const option = flags.get(value);
    if (!option) throw new Error(`unknown argument: ${value}`);
    const [key, max] = option;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${value} requires a value`);
    }
    options[key] = parsePositiveInteger(value, next, max);
    index += 1;
  }
  return options;
}

function parsePositiveInteger(name, value, max) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} must be an integer >= 1`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be <= ${Number.MAX_SAFE_INTEGER}`);
  }
  if (parsed > max) {
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
    const trim = (value) => {
      const text = String(value ?? "");
      return text.length > 2000 ? `${text.slice(0, 2000)}\n<truncated>` : text;
    };
    throw new Error(
      `${command} ${args.join(" ")} failed\n${trim(result.stdout)}\n${trim(result.stderr)}`,
    );
  }
  return result.stdout;
}

async function createFixture({ files, bytesPerFile }) {
  const root = await mkdtemp(join(nativeTmpdir, "dohc-kernel-spike-"));
  const payload = "x".repeat(bytesPerFile);
  for (let index = 0; index < files; index += 1) {
    const path = join(root, `dir-${index % 50}`, `file-${index}.txt`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${index}:${payload}\n`);
  }
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(join(root, ".dohc", "hidden.txt"), "hidden");
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git", "config"), "hidden");
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(join(root, "node_modules/pkg/index.js"), "hidden");
  return root;
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function summarize(runs) {
  const values = runs.map((run) => run.metrics.scan_ms);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    min_ms: Number(min.toFixed(2)),
    max_ms: Number(max.toFixed(2)),
    avg_ms: Number(avg.toFixed(2)),
    files: runs[0]?.metrics.files ?? 0,
    bytes: runs[0]?.metrics.bytes ?? 0,
  };
}

const options = parseOptions(process.argv);
const files = options.files;
const bytesPerFile = options.bytesPerFile;
const iterations = options.iterations;
const keepFixture = options.keepFixture;

if (!Number.isInteger(files) || files < 1) {
  throw new Error("--files must be an integer >= 1");
}
if (!Number.isInteger(bytesPerFile) || bytesPerFile < 1) {
  throw new Error("--bytes-per-file must be an integer >= 1");
}
if (!Number.isInteger(iterations) || iterations < 1) {
  throw new Error("--iterations must be an integer >= 1");
}

const fixture = await createFixture({ files, bytesPerFile });

try {
  run("cargo", ["build", "--release", "--manifest-path", rustManifest], {
    stdio: "inherit",
  });

  const rustRuns = [];
  const tsRuns = [];
  for (let index = 0; index < iterations; index += 1) {
    rustRuns.push(parseJson(run(rustBin, ["scan", "--root", fixture, "--json"])));
    tsRuns.push(
      parseJson(
        run("pnpm", [
          "--dir",
          "packages/workspace-fs",
          "exec",
          "tsx",
          "../../scripts/workspace-kernel-spike/ts-scan.ts",
          "--root",
          fixture,
          "--json",
        ]),
      ),
    );
  }

  const result = {
    fixture: {
      root: keepFixture ? fixture : "<temp>",
      files,
      bytes_per_file: bytesPerFile,
      iterations,
    },
    rust: summarize(rustRuns),
    typescript: summarize(tsRuns),
    notes: [
      "Rust spike and TypeScript baseline both skip .dohc, .git, and node_modules.",
      "Numbers are local-machine smoke data, not release budgets.",
    ],
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (!keepFixture) {
    await rm(fixture, { recursive: true, force: true });
  }
}
