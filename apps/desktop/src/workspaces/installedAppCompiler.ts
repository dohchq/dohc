import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "./closedAppCompiler";
import type { CompilerProcessBounds } from "./compilerProcessSupervisor";

/** resourcesRoot is chosen by Electron main, never by an app or renderer. */
export async function createInstalledAppCompiler(resourcesRoot: string) {
  if (!isAbsolute(resourcesRoot)) throw new Error("Compiler resources path must be absolute.");
  const root = join(resourcesRoot, "app-compiler");
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("App compilation is not available on this platform.");
  }
  // This installed module and its dependencies stay outside app.asar. It
  // resolves the worker and supervisor assets relative to its own location.
  const adapter = await import(/* @vite-ignore */ pathToFileURL(join(root, "adapter.mjs")).href);
  return (request: ClosedAppBuildRequest, bounds: CompilerProcessBounds, signal?: AbortSignal): Promise<ClosedAppBuild> => {
    return adapter.compileClosedAppInProcess({
      nodeExecutable: join(root, "node.exe"), workerPath: join(root, "worker.mjs"),
    }, request, bounds, signal);
  };
}
