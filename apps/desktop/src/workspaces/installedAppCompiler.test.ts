import { expect, it } from "vitest";
import { CompilerProcessError } from "./compilerProcessSupervisor";
import { appBuildError, appCompilerRefusal } from "./installedAppCompiler";

const failure = (reason: CompilerProcessError["reason"], diagnostics?: string) =>
  Object.assign(new CompilerProcessError(reason, "Compiler exited (1)."), { diagnostics });

it("passes the compiler's reason on in place of the supervisor's code", () => {
  expect(appBuildError(failure("exit", "site/index.html links app.js, which is not in the app.\nstack"))).toEqual(new Error("site/index.html links app.js, which is not in the app."));
  expect(appBuildError(failure("exit", " "))).toEqual(new Error("The app compiler stopped before it finished. Try again."));
  expect(appBuildError(failure("timeout"))).toEqual(new Error("The app took too long to build. Remove files the app does not use, then try again."));
  expect(appBuildError(failure("memory"))).toEqual(new Error("The app needs too much memory to build. Remove files the app does not use, then try again."));
  expect(appBuildError(failure("processes"))).toEqual(new Error("The app compiler started more processes than dohc allows, so dohc stopped it. Try again."));
  const cancelled = failure("cancelled"), other = new Error("Invalid compiler response.");
  expect(appBuildError(cancelled)).toBe(cancelled);
  expect(appBuildError(other)).toBe(other);
});

it("builds apps on Windows x64 and Apple silicon Macs with macOS 13.5 or later only", () => {
  expect(appCompilerRefusal("win32", "x64", "10.0.26100")).toBeUndefined();
  // macOS 13.5 is Darwin 22.6, the oldest release the pinned Node runs on.
  for (const kernel of ["22.6.0", "22.10.0", "23.0.0", "27.0.0"]) expect(appCompilerRefusal("darwin", "arm64", kernel)).toBeUndefined();
  for (const kernel of ["21.6.0", "22.5.0"]) {
    expect(appCompilerRefusal("darwin", "arm64", kernel)).toBe("Publishing and opening apps needs macOS 13.5 or later. Update macOS, then try again.");
  }
  // dohc ships no Intel build, so an x64 Mac process refuses whatever its macOS.
  for (const arch of ["x64", "ia32"]) {
    for (const kernel of ["21.6.0", "27.0.0"]) {
      expect(appCompilerRefusal("darwin", arch, kernel)).toBe("Publishing and opening apps needs an Apple silicon Mac with macOS 13.5 or later.");
    }
  }
  for (const [platform, arch] of [["win32", "arm64"], ["linux", "x64"], ["linux", "arm64"]] as const) {
    expect(appCompilerRefusal(platform, arch, "27.0.0")).toBe("Publishing and opening apps needs Windows x64, or an Apple silicon Mac with macOS 13.5 or later.");
  }
});
