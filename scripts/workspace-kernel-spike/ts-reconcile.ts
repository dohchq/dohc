import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { scanWorkspaceFiles, type ScannedWorkspaceFile } from "../../packages/workspace-fs/src/scan";

type ManifestEntry = {
  path: string;
  sha256: string;
  size: number;
  mtime: number;
};

type Args = {
  root: string;
  manifest: string;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  let root = "";
  let manifest = "";
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--root requires a path");
      }
      root = value;
      index += 1;
      continue;
    }
    if (arg === "--manifest") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--manifest requires a path");
      }
      manifest = value;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!root) throw new Error("--root is required");
  if (!manifest) throw new Error("--manifest is required");
  return { root, manifest, json };
}

function reconcile(files: ScannedWorkspaceFile[], manifest: ManifestEntry[]) {
  const prior = new Map(manifest.map((entry) => [entry.path, entry]));
  let changed = 0;
  let added = 0;

  for (const file of files) {
    const entry = prior.get(file.path);
    prior.delete(file.path);
    if (!entry) {
      added += 1;
    } else if (entry.size !== file.size || entry.sha256 !== file.sha256) {
      changed += 1;
    }
  }

  return {
    changed,
    added,
    removed: prior.size,
  };
}

const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(await readFile(args.manifest, "utf8")) as ManifestEntry[];
const started = performance.now();
const files = await scanWorkspaceFiles(args.root);
const counts = reconcile(files, manifest);
const reconcileMs = performance.now() - started;

const output = {
  root: args.root,
  metrics: {
    reconcile_ms: reconcileMs,
  },
  ...counts,
};

if (args.json) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(
    `reconciled ${files.length} files in ${reconcileMs.toFixed(2)}ms (${counts.changed} changed, ${counts.added} added, ${counts.removed} removed)`,
  );
}
