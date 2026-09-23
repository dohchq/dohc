import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { compileDatasetOperations } from "@dohc/app-backend-runtime/dataset-compiler";

/** Main selects installed resources; apps and renderers cannot supply these paths. */
export async function createInstalledDatasetCompiler(resourcesRoot: string) {
  if (!isAbsolute(resourcesRoot)) throw Error("Compiler resources path must be absolute.");
  if (process.platform !== "win32" || process.arch !== "x64") throw Error("Creating Collection actions currently requires Windows x64.");
  const modulePath = pathToFileURL(join(resourcesRoot, "app-backend-runtime", "dataset-compiler.mjs")).href;
  const compiler = await import(/* @vite-ignore */ modulePath) as { compileDatasetOperations: typeof compileDatasetOperations };
  const executablePath = join(resourcesRoot, "app-compiler", "node_modules", "@esbuild", "win32-x64", "esbuild.exe");
  return (source: string, path: string, signal: AbortSignal) => compiler.compileDatasetOperations(source, path, { executablePath, signal });
}
