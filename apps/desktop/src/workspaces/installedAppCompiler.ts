import { release } from "node:os";
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
  if (reason === "memory") return new Error("The app needs too much memory to build. Remove files the app does not use, then try again.");
  if (reason === "processes") return new Error("The app compiler started more processes than dohc allows, so dohc stopped it. Try again.");
  const detail = reason === "exit" ? diagnostics?.trim().split(/\r?\n/, 1)[0] : undefined;
  return new Error(detail || "The app compiler stopped before it finished. Try again.");
}

/**
 * Why this device cannot build apps, or undefined when it can. macOS 13.5 is
 * Darwin 22.6, the oldest release the pinned Node 24 runs on. `translated`
 * is true when Rosetta runs this x64 dohc on an Apple silicon Mac, where the
 * compiler's sandbox is unverified.
 */
export function appCompilerRefusal(platform: NodeJS.Platform, arch: string, kernel: string, translated: boolean): string | undefined {
  if (platform === "win32" && arch === "x64") return undefined;
  if (platform !== "darwin" || (arch !== "arm64" && arch !== "x64")) return "Publishing and opening apps needs Windows x64 or macOS 13.5 or later.";
  const [major = 0, minor = 0] = kernel.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 6)) return "Publishing and opening apps needs macOS 13.5 or later. Update macOS, then try again.";
  if (translated) return "This Intel version of dohc can't publish or open apps on an Apple silicon Mac. Download the Apple silicon version from github.com/dohchq/dohc/releases, then try again.";
  return undefined;
}

/**
 * resourcesRoot is chosen by Electron main, never by an app or renderer.
 * Main passes app.runningUnderARM64Translation, which reads sysctl.proc_translated.
 */
export async function createInstalledAppCompiler(resourcesRoot: string, translated: boolean) {
  if (!isAbsolute(resourcesRoot)) throw new Error("Compiler resources path must be absolute.");
  const root = join(resourcesRoot, "app-compiler");
  const refusal = appCompilerRefusal(process.platform, process.arch, release(), translated);
  if (refusal) throw new Error(refusal);
  // This installed module and its dependencies stay outside app.asar. It
  // resolves the worker and supervisor assets relative to its own location.
  const adapter = await import(/* @vite-ignore */ pathToFileURL(join(root, "adapter.mjs")).href);
  const runtime = process.platform === "win32"
    ? { nodeExecutable: join(root, "node.exe"), workerPath: join(root, "worker.mjs") }
    : { nodeExecutable: join(root, "node"), workerPath: join(root, "worker.mjs"), ownerExecutable: join(root, "compiler-owner") };
  return async (request: ClosedAppBuildRequest, bounds: CompilerProcessBounds, signal?: AbortSignal): Promise<ClosedAppBuild> => {
    try {
      return await adapter.compileClosedAppInProcess(runtime, request, bounds, signal);
    } catch (error) { throw appBuildError(error); }
  };
}
