import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { DatasetHostError } from "@dohc/app-backend-runtime/dataset-host";

const require = createRequire(import.meta.url);
const sourceBytes = 256 * 1024;
let active = 0;

/** Transform captured source in a bounded compiler process without resolving imports or reading app files. */
export async function compileDatasetOperations(source: string, path: string): Promise<string> {
  if (typeof source !== "string" || Buffer.byteLength(source) > sourceBytes || !/\.(?:js|ts)$/.test(path)) throw new DatasetHostError("invalid", "Dataset operations must be one JavaScript or TypeScript source within 256 KiB.");
  if (process.env.ESBUILD_BINARY_PATH || !["win32", "darwin", "linux"].includes(process.platform)) throw new Error("Unsupported dataset compiler installation.");
  if (active >= 2) throw new DatasetHostError("conflict", "The dataset compiler is busy. Retry the approval.");
  const compilerRequire = createRequire(require.resolve("esbuild"));
  const binary = compilerRequire.resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`);
  active++;
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = execFile(binary, [`--loader=${path.endsWith(".ts") ? "ts" : "js"}`, "--format=iife", "--platform=neutral", "--target=es2022", "--log-level=error"],
        {timeout: 10_000, maxBuffer: sourceBytes, windowsHide: true, encoding: "utf8"}, (error, stdout) => {
          if (error) reject(new DatasetHostError("invalid", "Dataset operations could not compile within the host limits. Check the source and retry."));
          else resolve(stdout);
        });
      child.stdin!.on("error", () => {});
      child.stdin!.end(source);
    });
  } finally { active--; }
}
