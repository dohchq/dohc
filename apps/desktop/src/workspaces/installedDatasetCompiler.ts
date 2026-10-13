import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { compileDatasetOperations } from "@dohc/app-backend-runtime/dataset-compiler";

/** Main selects installed resources; apps and renderers cannot supply these paths. */
export async function createInstalledDatasetCompiler(resourcesRoot: string) {
  if (!isAbsolute(resourcesRoot)) throw Error("Compiler resources path must be absolute.");
  // stage-app-compiler.mjs installs this esbuild binary on these platforms.
  const binary = process.arch !== "x64" ? undefined
    : process.platform === "win32" ? join("win32-x64", "esbuild.exe")
    : process.platform === "linux" ? join("linux-x64", "bin", "esbuild") : undefined;
  if (!binary) throw Error("Creating Collection actions currently requires Windows x64 or Linux x64.");
  const modulePath = pathToFileURL(join(resourcesRoot, "app-backend-runtime", "dataset-compiler.mjs")).href;
  const compiler = await import(/* @vite-ignore */ modulePath) as { compileDatasetOperations: typeof compileDatasetOperations };
  const executablePath = join(resourcesRoot, "app-compiler", "node_modules", "@esbuild", binary);
  return (source: string, path: string, signal: AbortSignal) => compiler.compileDatasetOperations(source, path, { executablePath, signal });
}
