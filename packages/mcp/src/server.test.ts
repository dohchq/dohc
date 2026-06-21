import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "./server";

describe("parseArgs", () => {
  it("trims explicit path and package arguments", () => {
    expect(
      parseArgs([
        "--workspace",
        " /tmp/workspace ",
        "--home",
        " /tmp/home ",
        "--sdk-package-json",
        " /tmp/sdk/package.json ",
        "--sdk-dependency-range",
        " ^0.1.0 ",
      ]),
    ).toMatchObject({
      root: "/tmp/workspace",
      home: "/tmp/home",
      sdkPackageJsonPath: "/tmp/sdk/package.json",
      sdkDependencyRange: "^0.1.0",
    });
  });

  it("rejects blank explicit path and package arguments", () => {
    expect(() => parseArgs(["--workspace", " "])).toThrow(/--workspace requires/);
    expect(() => parseArgs(["--home", " "])).toThrow(/--home requires/);
    expect(() => parseArgs(["--sdk-package-json", " "])).toThrow(
      /--sdk-package-json requires/,
    );
    expect(() => parseArgs(["--sdk-dependency-range", " "])).toThrow(
      /--sdk-dependency-range requires/,
    );
  });

  it("rejects present-but-blank SDK environment arguments", () => {
    vi.stubEnv("DOHC_SDK_PACKAGE_JSON", " ");
    try {
      expect(() => parseArgs([])).toThrow(/DOHC_SDK_PACKAGE_JSON requires/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
