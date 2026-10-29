import { describe, expect, it } from "vitest";
import { resolveDohcNodeExecutable } from "./dohcNodeExecutable";

describe("resolveDohcNodeExecutable", () => {
  it.each([
    ["win32", "x64", "C:\\Ice Test\\Icé\\resources", "C:\\Ice Test\\Icé\\resources\\app-compiler\\node.exe"],
    ["darwin", "arm64", "/Applications/dohc.app/Contents/Resources", "/Applications/dohc.app/Contents/Resources/app-compiler/node"],
    ["linux", "x64", "/opt/dohc/resources", null],
    ["linux", "arm64", "/opt/dohc/resources", null],
  ] as const)("resolves %s-%s without consulting files or PATH", (platform, arch, resourcesPath, expected) => {
    expect(resolveDohcNodeExecutable({ resourcesPath, platform, arch })).toBe(expected);
  });
  it.each(["relative", "", "C:resources", "\\resources"])("rejects a relative Windows resources path: %s", (resourcesPath) => {
    expect(() => resolveDohcNodeExecutable({ resourcesPath, platform: "win32", arch: "x64" })).toThrow(/absolute/);
  });
  it("uses the selected platform's path rules", () => {
    expect(() => resolveDohcNodeExecutable({ resourcesPath: "C:\\resources", platform: "linux", arch: "x64" })).toThrow(/absolute/);
  });
  it.each([["darwin", "x64"], ["win32", "arm64"], ["linux", "ia32"], ["freebsd", "x64"]] as const)("rejects unsupported %s-%s", (platform, arch) => {
    expect(() => resolveDohcNodeExecutable({ resourcesPath: platform === "win32" ? "C:\\resources" : "/resources", platform, arch })).toThrow(/Unsupported/);
  });
});
