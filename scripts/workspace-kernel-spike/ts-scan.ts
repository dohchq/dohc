import { performance } from "node:perf_hooks";
import { scanWorkspaceFiles } from "../../packages/workspace-fs/src/scan";

type Args = {
  root: string;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  let root = "";
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
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!root) throw new Error("--root is required");
  return { root, json };
}

const args = parseArgs(process.argv.slice(2));
const started = performance.now();
const files = await scanWorkspaceFiles(args.root);
const scanMs = performance.now() - started;
const bytes = files.reduce((sum, file) => sum + file.size, 0);

const output = {
  root: args.root,
  metrics: {
    files: files.length,
    bytes,
    scan_ms: scanMs,
  },
};

if (args.json) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`scanned ${files.length} files / ${bytes} bytes in ${scanMs.toFixed(2)}ms`);
}
