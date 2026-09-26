import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { parse } from "acorn";

const require = createRequire(import.meta.url);
const SOURCE_BYTES = 256 * 1024;
let active = 0;
export interface DatasetCompilerOptions { executablePath?: string; signal?: AbortSignal }
export class DatasetCompilerError extends Error {
  constructor(readonly code: "invalid" | "conflict", message: string, options?: ErrorOptions) { super(message, options); }
}

function installedCompiler(): string {
  if (process.env.ESBUILD_BINARY_PATH || !["win32", "darwin", "linux"].includes(process.platform)) throw Error("This copy of dohc cannot build Collection actions. Reinstall dohc.");
  const compilerRequire = createRequire(require.resolve("esbuild"));
  return compilerRequire.resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`);
}

function assertClosedScript(source: string): void {
  const nodes: unknown[] = [parse(source, { ecmaVersion: "latest", sourceType: "script" })];
  while (nodes.length) {
    const value = nodes.pop();
    if (!value || typeof value !== "object") continue;
    const node = value as Record<string, unknown>;
    if (node.type === "ImportExpression" || node.type === "ImportDeclaration" || node.type === "MetaProperty" ||
        node.type === "Identifier" && node.name === "require") throw new DatasetCompilerError("invalid", "Collection actions cannot import modules or use require.");
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) nodes.push(...child); else if (child && typeof child === "object") nodes.push(child);
    }
  }
}

/** One bounded stdin-only recipe for desktop, relay, recovery, and replicas. Never resolves app imports. */
export async function compileDatasetOperations(source: string, path: string, options: DatasetCompilerOptions = {}): Promise<string> {
  if (typeof source !== "string" || Buffer.byteLength(source) > SOURCE_BYTES || !/\.(?:js|ts)$/.test(path)) throw new DatasetCompilerError("invalid", "Collection actions must be one JavaScript or TypeScript file of 256 KiB or less.");
  options.signal?.throwIfAborted();
  if (active >= 2) throw new DatasetCompilerError("conflict", "dohc is building other Collection actions. Approve again in a moment.");
  const executablePath = options.executablePath ?? installedCompiler();
  if (!isAbsolute(executablePath)) throw Error("The dataset compiler must be an installed absolute path.");
  active++;
  try {
    const run = (args: string[], input?: string) => new Promise<string>((resolve, reject) => {
      const child = execFile(executablePath, args, { timeout: 10_000, maxBuffer: SOURCE_BYTES, windowsHide: true, encoding: "utf8", signal: options.signal }, (error, stdout) => {
        if (error) reject(new DatasetCompilerError("invalid", "dohc could not build these Collection actions within this host's limits. Check the source. Then approve again.", { cause: error }));
        else resolve(stdout);
      });
      child.stdin!.on("error", () => {}); child.stdin!.end(input);
    });
    if ((await run(["--version"])).trim() !== "0.28.1") throw Error("This copy of dohc cannot build Collection actions. Reinstall dohc.");
    const compiled = await run([`--loader=${path.endsWith(".ts") ? "ts" : "js"}`, "--format=iife", "--platform=neutral", "--target=es2022",
      "--legal-comments=none", "--charset=utf8", "--log-level=error", '--tsconfig-raw={"compilerOptions":{"experimentalDecorators":false,"useDefineForClassFields":true}}'], source);
    options.signal?.throwIfAborted(); assertClosedScript(compiled); return compiled;
  } finally { active--; }
}
