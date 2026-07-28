import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("key-envelope transport migration", () => {
  it("has no desktop import of the legacy envelope transport", async () => {
    const sourceRoot = join(__dirname, "..");
    const sourceFiles = (await readdir(sourceRoot, { recursive: true })).filter(
      (path) => /\.[cm]?tsx?$/u.test(path),
    );
    const imports = await Promise.all(
      sourceFiles.map(async (path) => {
        const source = await readFile(join(sourceRoot, path), "utf8");
        return [
          ...source.matchAll(
            /import\s*\{(?<names>[\s\S]*?)\}\s*from\s*"@dohc\/workspace-engine";/gu,
          ),
        ].flatMap((match) =>
          (match.groups?.names ?? "")
            .split(",")
            .map((name) => name.trim().split(/\s+as\s+/u)[0])
            .filter(Boolean)
            .map((name) => ({ name, path })),
        );
      }),
    );
    const workspaceEngineImports = imports.flat();

    expect(
      workspaceEngineImports.filter(({ name }) => name === "uploadKeyEnvelope"),
      "MUTATION: desktop key enrollment routed back through the identity-less TypeScript relay client",
    ).toEqual([]);
    expect(
      workspaceEngineImports.filter(
        ({ name }) => name === "downloadKeyEnvelope",
      ),
      "MUTATION: desktop key enrollment routed back through the identity-less TypeScript relay client",
    ).toEqual([]);
  });
});
