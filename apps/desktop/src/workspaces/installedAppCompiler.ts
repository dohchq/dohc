import { readFile } from "node:fs/promises";
import { release } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "./closedAppCompiler";
import type { CompilerProcessBounds } from "./compilerProcessSupervisor";

/** The compiler's own reason reaches the person; the supervisor's codes do not. */
export function appBuildError(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== "CompilerProcessError") return error;
  const { reason, diagnostics, details } = error as Error & { reason?: string; diagnostics?: string; details?: string };
  if (reason === "cancelled") return error;
  if (reason === "timeout") {
    const timeout = new Error("The app took too long to build. Remove files the app does not use, then try again.");
    timeout.name = "AppCompilerTimeoutError";
    return Object.assign(timeout, { details });
  }
  if (reason === "memory") return new Error("The app needs too much memory to build. Remove files the app does not use, then try again.");
  if (reason === "processes") return new Error("The app compiler started more processes than dohc allows, so dohc stopped it. Try again.");
  const detail = reason === "exit" ? diagnostics?.trim().split(/\r?\n/, 1)[0] : undefined;
  return new Error(detail || "The app compiler stopped before it finished. Try again.");
}

/**
 * Why this device cannot build apps, or undefined when it can. macOS 13.5 is
 * Darwin 22.6, the oldest release the pinned Node 24 runs on. Linux 5.13
 * added Landlock, which confines the compiler there, and `securityModules`
 * lists the modules the running kernel turned on, when it can be read.
 */
export function appCompilerRefusal(platform: NodeJS.Platform, arch: string, kernel: string, securityModules?: string): string | undefined {
  const [major = 0, minor = 0] = kernel.split(".").map(Number);
  const before = (wanted: number, wantedMinor: number) => major < wanted || (major === wanted && minor < wantedMinor);
  if (platform === "win32" && arch === "x64") return undefined;
  if (platform === "linux" && arch === "x64") {
    if (before(5, 13)) return "Publishing and opening apps needs Linux 5.13 or later. Update Linux, then try again.";
    if (securityModules?.trim() && !securityModules.split(",").map(name => name.trim()).includes("landlock")) {
      return "Publishing and opening apps needs Landlock, which this Linux kernel leaves off. Add landlock to its lsm boot option and restart, or use a kernel that includes Landlock.";
    }
    return undefined;
  }
  if (platform !== "darwin") return "Publishing and opening apps needs Windows x64, an Apple silicon Mac with macOS 13.5 or later, or Linux x64.";
  if (arch !== "arm64") return "Publishing and opening apps needs an Apple silicon Mac with macOS 13.5 or later.";
  if (before(22, 6)) return "Publishing and opening apps needs macOS 13.5 or later. Update macOS, then try again.";
  return undefined;
}

/** resourcesRoot is chosen by Electron main, never by an app or renderer. */
export async function createInstalledAppCompiler(resourcesRoot: string) {
  if (!isAbsolute(resourcesRoot)) throw new Error("Compiler resources path must be absolute.");
  const root = join(resourcesRoot, "app-compiler");
  const securityModules = process.platform === "linux" ? await readFile("/sys/kernel/security/lsm", "utf8").catch(() => undefined) : undefined;
  const refusal = appCompilerRefusal(process.platform, process.arch, release(), securityModules);
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
