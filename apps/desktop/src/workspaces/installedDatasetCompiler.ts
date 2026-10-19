import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { compileDatasetOperations } from "@dohc/app-backend-runtime/dataset-compiler";

/** Main selects installed resources; apps and renderers cannot supply these paths. */
export async function createInstalledDatasetCompiler(resourcesRoot: string) {
  if (!isAbsolute(resourcesRoot)) throw Error("Compiler resources path must be absolute.");
  // stage-app-compiler.mjs installs this esbuild binary on these platforms.
  const target = `${process.platform}-${process.arch}`;
  const binary = target === "win32-x64" ? join(target, "esbuild.exe")
    : ["darwin-arm64", "linux-arm64", "linux-x64"].includes(target) ? join(target, "bin", "esbuild") : undefined;
  if (!binary) throw Error("Creating Collection actions currently requires Windows x64, an Apple silicon Mac, or Linux.");
  const modulePath = pathToFileURL(join(resourcesRoot, "app-backend-runtime", "dataset-compiler.mjs")).href;
  const compiler = await import(/* @vite-ignore */ modulePath) as { compileDatasetOperations: typeof compileDatasetOperations };
  const executablePath = join(resourcesRoot, "app-compiler", "node_modules", "@esbuild", binary);
  return (source: string, path: string, signal: AbortSignal) => compiler.compileDatasetOperations(source, path, { executablePath, signal });
}
