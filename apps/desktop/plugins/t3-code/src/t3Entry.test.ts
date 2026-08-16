import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveT3Entry, T3_ENTRY_MODULE_PATH, T3_PINNED_VERSION } from "./t3Entry";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

async function createBuiltRoot(input: {
  manifest?: unknown;
  withEntryFile?: boolean;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-t3-entry-"));
  roots.push(root);
  const packageDir = join(root, "snapshot", "node_modules", "t3");
  await mkdir(join(packageDir, "dist"), { recursive: true });
  if (input.manifest !== undefined) {
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify(input.manifest),
    );
  }
  if (input.withEntryFile ?? true) {
    await writeFile(join(packageDir, "dist", "bin.mjs"), "#!/usr/bin/env node\n");
  }
  return root;
}

const pinnedManifest = {
  name: "t3",
  version: T3_PINNED_VERSION,
  bin: { t3: "./dist/bin.mjs" },
};

describe("resolveT3Entry", () => {
  it("resolves the pinned entry from the installed dependency", async () => {
    const root = await createBuiltRoot({ manifest: pinnedManifest });
    await expect(resolveT3Entry(root)).resolves.toBe(T3_ENTRY_MODULE_PATH);
  });

  it("returns the path of the entry file it validated", async () => {
    const root = await createBuiltRoot({ manifest: pinnedManifest });
    const modulePath = await resolveT3Entry(root);

    // MUTATION (encode the entry a second time and point one copy elsewhere):
    // the plugin validates one file and hands the broker another.
    expect(existsSync(join(root, ...modulePath.split("/")))).toBe(true);
    // The broker resolves this against the plugin root; a Windows separator
    // is not a relative path it accepts.
    expect(modulePath).not.toContain("\\");
  });

  it("refuses any other installed version, naming both versions", async () => {
    const root = await createBuiltRoot({
      manifest: { ...pinnedManifest, version: "0.0.34" },
    });
    await expect(resolveT3Entry(root)).rejects.toThrow("0.0.34");
    await expect(resolveT3Entry(root)).rejects.toThrow(T3_PINNED_VERSION);
  });

  it("refuses a package whose bin does not declare dist/bin.mjs", async () => {
    const root = await createBuiltRoot({
      manifest: { ...pinnedManifest, bin: { t3: "./elsewhere.mjs" } },
    });
    await expect(resolveT3Entry(root)).rejects.toThrow("./dist/bin.mjs");
  });

  it("refuses a missing installed package with a reinstall instruction", async () => {
    const root = await createBuiltRoot({ manifest: undefined });
    await expect(resolveT3Entry(root)).rejects.toThrow("Reinstall the t3-code plugin");
  });

  it("refuses a manifest without its entry file on disk", async () => {
    const root = await createBuiltRoot({
      manifest: pinnedManifest,
      withEntryFile: false,
    });
    await expect(resolveT3Entry(root)).rejects.toThrow("missing");
  });
});
