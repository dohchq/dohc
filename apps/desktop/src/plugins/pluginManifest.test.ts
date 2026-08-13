import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PLUGIN_MANIFEST_FILE_BYTES,
  PLUGIN_MANIFEST_FILE_NAME,
  readPluginManifestFile,
} from "./pluginManifest";

const roots: string[] = [];

async function createPluginRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-plugin-manifest-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readPluginManifestFile", () => {
  it("reads a valid manifest", async () => {
    const root = await createPluginRoot();
    await writeFile(join(root, PLUGIN_MANIFEST_FILE_NAME), JSON.stringify({
      version: 1,
      name: "example-plugin",
      entry: "dist\\index.js",
    }));

    expect(await readPluginManifestFile(root)).toEqual({
      ok: true,
      manifest: {
        version: 1,
        name: "example-plugin",
        entry: "dist/index.js",
      },
    });
  });

  it("reports a missing manifest at its expected absolute path", async () => {
    const root = await createPluginRoot();
    const path = join(root, PLUGIN_MANIFEST_FILE_NAME);

    expect(await readPluginManifestFile(root)).toEqual({
      ok: false,
      diagnostics: [`${PLUGIN_MANIFEST_FILE_NAME} was not found at ${path}`],
    });
  });

  it("rejects a manifest over 256 KiB before parsing it", async () => {
    const root = await createPluginRoot();
    const size = MAX_PLUGIN_MANIFEST_FILE_BYTES + 1;
    await writeFile(join(root, PLUGIN_MANIFEST_FILE_NAME), " ".repeat(size));

    expect(await readPluginManifestFile(root)).toEqual({
      ok: false,
      diagnostics: [
        `${PLUGIN_MANIFEST_FILE_NAME} must be 256 KiB (${MAX_PLUGIN_MANIFEST_FILE_BYTES} bytes) or smaller; found ${size} bytes.`,
      ],
    });
  });

  it("rejects a directory at the manifest path", async () => {
    const root = await createPluginRoot();
    const path = join(root, PLUGIN_MANIFEST_FILE_NAME);
    await mkdir(path);

    expect(await readPluginManifestFile(root)).toEqual({
      ok: false,
      diagnostics: [
        `${PLUGIN_MANIFEST_FILE_NAME} at ${path} is not a readable file (symlink or directory)`,
      ],
    });
  });

  it("rejects a symlink at the manifest path", async () => {
    const root = await createPluginRoot();
    const target = join(root, "manifest-target.json");
    const path = join(root, PLUGIN_MANIFEST_FILE_NAME);
    await writeFile(target, JSON.stringify({
      version: 1,
      name: "example-plugin",
      entry: "index.js",
    }));
    await symlink(target, path);

    expect(await readPluginManifestFile(root)).toEqual({
      ok: false,
      diagnostics: [
        `${PLUGIN_MANIFEST_FILE_NAME} at ${path} is not a readable file (symlink or directory)`,
      ],
    });
  });

  it("surfaces the JSON parse error", async () => {
    const root = await createPluginRoot();
    await writeFile(join(root, PLUGIN_MANIFEST_FILE_NAME), "{not json");

    const result = await readPluginManifestFile(root);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected malformed JSON to fail");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatch(/^dohc-plugin\.json is not valid JSON: .+/);
  });

  it("reports every schema issue with its field path", async () => {
    const root = await createPluginRoot();
    await writeFile(join(root, PLUGIN_MANIFEST_FILE_NAME), JSON.stringify({
      version: 2,
      name: "example-plugin",
      displayName: "",
      entry: "index.js",
    }));

    const result = await readPluginManifestFile(root);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an invalid manifest to fail");
    expect(result.diagnostics).toHaveLength(2);
    expect(
      result.diagnostics.some((diagnostic) => /^version: .*expected 1/.test(diagnostic)),
    ).toBe(true);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.startsWith("displayName: ")),
    ).toBe(true);
  });
});
