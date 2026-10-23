import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installedReaderConfig } from "./installedReaderConfig";

const roots: string[] = [];
function fixture(selection: unknown) {
  const root = mkdtempSync(join(tmpdir(), "dohc-installed-reader-"));
  roots.push(root);
  mkdirSync(join(root, "engine-reader"));
  writeFileSync(join(root, "engine-reader/selection.json"), JSON.stringify(selection));
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("installed reader paths", () => {
  it.each([["darwin", "arm64"], ["linux", "x64"], ["win32", "x64"]] as const)(
    "passes the selected %s-%s closure to the engine", (platform, arch) => {
      const generation = "a".repeat(64), resources = fixture({ generation });
      const root = resolve(resources, "engine-reader", generation);
      expect(JSON.parse(installedReaderConfig(resources, platform, arch)!)).toEqual({
        node: platform === "win32" ? resolve(resources, "app-compiler/node.exe") : join(root, "node"),
        bundle: join(root, "reader.cjs"), manifest: join(root, "manifest.json"),
      });
    });

  it("does not configure the reader on Intel Macs", () => {
    expect(installedReaderConfig(fixture({ generation: "a".repeat(64) }), "darwin", "x64")).toBeUndefined();
  });

  it("disables missing, malformed, and unsupported installations", () => {
    expect(installedReaderConfig(undefined, "darwin", "arm64")).toBeUndefined();
    const resources = fixture({ generation: "../outside" });
    for (const arch of ["arm64", "x64"] as const) {
      expect(installedReaderConfig(resources, "darwin", arch)).toBeUndefined();
      expect(installedReaderConfig(join(resources, "absent"), "darwin", arch)).toBeUndefined();
    }
    writeFileSync(join(resources, "engine-reader/selection.json"), "invalid JSON");
    expect(installedReaderConfig(resources, "darwin", "arm64")).toBeUndefined();
    expect(installedReaderConfig(fixture({ generation: "a".repeat(64) }), "darwin", "ia32")).toBeUndefined();
  });
});
