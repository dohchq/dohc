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
  if (process.env.ESBUILD_BINARY_PATH || !["win32", "darwin", "linux"].includes(process.platform)) throw Error("Unsupported dataset compiler installation.");
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
  if (typeof source !== "string" || Buffer.byteLength(source) > SOURCE_BYTES || !/\.(?:js|ts)$/.test(path)) throw new DatasetCompilerError("invalid", "Dataset operations must be one JavaScript or TypeScript source within 256 KiB.");
  options.signal?.throwIfAborted();
  if (active >= 2) throw new DatasetCompilerError("conflict", "The dataset compiler is busy. Retry the approval.");
  const executablePath = options.executablePath ?? installedCompiler();
  if (!isAbsolute(executablePath)) throw Error("The dataset compiler must be an installed absolute path.");
  active++;
  try {
    const run = (args: string[], input?: string) => new Promise<string>((resolve, reject) => {
      const child = execFile(executablePath, args, { timeout: 10_000, maxBuffer: SOURCE_BYTES, windowsHide: true, encoding: "utf8", signal: options.signal }, (error, stdout) => {
        if (error) reject(new DatasetCompilerError("invalid", "Dataset operations could not compile within the host limits. Check the source and retry.", { cause: error }));
        else resolve(stdout);
      });
      child.stdin!.on("error", () => {}); child.stdin!.end(input);
    });
    if ((await run(["--version"])).trim() !== "0.28.1") throw Error("Unsupported dataset compiler version.");
    const compiled = await run([`--loader=${path.endsWith(".ts") ? "ts" : "js"}`, "--format=iife", "--platform=neutral", "--target=es2022",
      "--legal-comments=none", "--charset=utf8", "--log-level=error", '--tsconfig-raw={"compilerOptions":{"experimentalDecorators":false,"useDefineForClassFields":true}}'], source);
    options.signal?.throwIfAborted(); assertClosedScript(compiled); return compiled;
  } finally { active--; }
}
