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

it("builds apps on Windows x64 and macOS 13.5 or later only", () => {
  expect(appCompilerRefusal("win32", "x64", "10.0.26100", false)).toBeUndefined();
  // macOS 13.5 is Darwin 22.6, the oldest release the pinned Node runs on.
  for (const kernel of ["22.6.0", "22.10.0", "23.0.0", "27.0.0"]) {
    for (const arch of ["arm64", "x64"]) expect(appCompilerRefusal("darwin", arch, kernel, false)).toBeUndefined();
  }
  for (const kernel of ["21.6.0", "22.5.0"]) {
    expect(appCompilerRefusal("darwin", "arm64", kernel, false)).toBe("Publishing and opening apps needs macOS 13.5 or later. Update macOS, then try again.");
  }
  for (const [platform, arch] of [["win32", "arm64"], ["linux", "x64"], ["darwin", "ia32"]] as const) {
    expect(appCompilerRefusal(platform, arch, "27.0.0", false)).toBe("Publishing and opening apps needs Windows x64 or macOS 13.5 or later.");
  }
});

it("refuses an x64 dohc that Rosetta translates, and only on macOS", () => {
  expect(appCompilerRefusal("darwin", "x64", "27.0.0", true)).toBe("This Intel version of dohc can't publish or open apps on an Apple silicon Mac. Download the Apple silicon version from github.com/dohchq/dohc/releases, then try again.");
  // A native Intel Mac keeps the full path, and Windows keeps its own.
  expect(appCompilerRefusal("darwin", "x64", "27.0.0", false)).toBeUndefined();
  expect(appCompilerRefusal("win32", "x64", "10.0.26100", true)).toBeUndefined();
});
