import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "./closedAppCompiler";
import type { CompilerProcessBounds } from "./compilerProcessSupervisor";

/** The compiler's own reason reaches the person; the supervisor's codes do not. */
export function appBuildError(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== "CompilerProcessError") return error;
  const { reason, diagnostics } = error as Error & { reason?: string; diagnostics?: string };
  if (reason === "cancelled") return error;
  if (reason === "timeout") return new Error("The app took too long to build. Remove files the app does not use, then try again.");
  const detail = reason === "exit" ? diagnostics?.trim().split(/\r?\n/, 1)[0] : undefined;
  return new Error(detail || "The app compiler stopped before it finished. Try again.");
}

/** resourcesRoot is chosen by Electron main, never by an app or renderer. */
export async function createInstalledAppCompiler(resourcesRoot: string) {
  if (!isAbsolute(resourcesRoot)) throw new Error("Compiler resources path must be absolute.");
  const root = join(resourcesRoot, "app-compiler");
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Publishing apps currently requires Windows x64.");
  }
  // This installed module and its dependencies stay outside app.asar. It
  // resolves the worker and supervisor assets relative to its own location.
  const adapter = await import(/* @vite-ignore */ pathToFileURL(join(root, "adapter.mjs")).href);
  return async (request: ClosedAppBuildRequest, bounds: CompilerProcessBounds, signal?: AbortSignal): Promise<ClosedAppBuild> => {
    try {
      return await adapter.compileClosedAppInProcess({
        nodeExecutable: join(root, "node.exe"), workerPath: join(root, "worker.mjs"),
      }, request, bounds, signal);
    } catch (error) { throw appBuildError(error); }
  };
}
