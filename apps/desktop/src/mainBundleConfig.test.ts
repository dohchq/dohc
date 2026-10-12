import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import desktopConfig, {
  mainBuildEntries,
  mainBundledWorkspaceDeps,
} from "../electron.vite.config";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("main bundle config", () => {
  it("starts Electron at the entry module, which loads the app's main module", () => {
    expect(mainBuildEntries.main).toBe("src/entry.ts");
    expect(mainBuildEntries.app).toBe("src/main.ts");
  });

  it("emits the reusable database worker beside main", () => {
    expect(mainBuildEntries["workspace-database-worker"]).toBe(
      "src/workspaces/workspaceDatabaseThread.ts",
    );
  });

  it("emits the document projection worker beside main", () => {
    expect(mainBuildEntries["document-projection-worker"]).toBe(
      "src/workspaces/documentProjectionThread.ts",
    );
  });

  it("bundles every workspace package reached by the main runtime entries", async () => {
    const config = await desktopConfig({ command: "build", mode: "production" });
    const library = config.main?.build?.lib;
    if (!library) throw new Error("The main process must have configured build entries");
    // Package boundaries remain external so the metafile exposes every runtime
    // dependency reached through local imports, including dynamic imports.
    const { metafile } = await build({
      absWorkingDir: desktopRoot,
      entryPoints: typeof library.entry === "string" ? [library.entry] : library.entry,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      outdir: "main-graph",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const reached = [...new Set(Object.values(metafile.outputs)
      .flatMap((output) => output.imports)
      .filter((dependency) => dependency.external && dependency.path.startsWith("@dohc/"))
      .map((dependency) => dependency.path.split("/").slice(0, 2).join("/")))];
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.filter((name) => !mainBundledWorkspaceDeps.includes(name)).sort(),
      "Raw TypeScript workspace packages must be excluded from dependency externalization",
    ).toEqual([]);
  });
});
