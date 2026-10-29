import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppPreviewExecution } from "./appPreviewExecution";
import type { SitePreviewExecutionInput } from "../ipc/sitePreviewIpc";
import type { SitePackageInfo } from "./sitePackage";
import { createTestScratch } from "./testTemp";
import { deferred, type Deferred } from "../testing/deferred";
import { createWorkspaceTrust, folderIdentity, WorkspaceRestrictedError } from "./workspaceTrust";

// spawn throws, so a command that got past every check shows as one call.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => { throw new Error("spawned"); }),
}));

// Holds the runner inside its path resolution, the await before spawn.
let resolving: { reached: Deferred<void>; release: Deferred<void> } | null = null;
vi.mock("./workspaceRealPath", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspaceRealPath")>();
  return {
    ...actual,
    assertResolvedWorkspacePath: async (...args: Parameters<typeof actual.assertResolvedWorkspacePath>) => {
      if (resolving) {
        resolving.reached.resolve();
        await resolving.release.promise;
      }
      return actual.assertResolvedWorkspacePath(...args);
    },
  };
});

afterEach(() => {
  resolving = null;
  vi.clearAllMocks();
});

async function harness(identifyGate?: { reached: Deferred<void>; release: Deferred<void> }) {
  const scratch = await realpath(await createTestScratch("app-trust-race-"));
  const workspaceRoot = join(scratch, "trip");
  await mkdir(join(workspaceRoot, "portal"), { recursive: true });
  await writeFile(join(workspaceRoot, "portal/package.json"), "{}");
  const trust = createWorkspaceTrust({
    file: join(scratch, "profile", "workspace-trust.json"),
    identify: async (rootPath) => {
      if (identifyGate) {
        identifyGate.reached.resolve();
        await identifyGate.release.promise;
      }
      return folderIdentity(rootPath);
    },
  });
  const workspace = { workspaceId: "trip", rootPath: workspaceRoot };
  const known = { folder: await folderIdentity(workspaceRoot) };
  await trust.trust(workspace, known);
  const execute = createAppPreviewExecution({
    shareViewFiles: { read: async () => { throw new Error("unused"); } },
    shareViewFilesTargetForPath: async () => null,
    assertMayRunAppCode: (target) => trust.assertTrusted(target),
  });
  const app: SitePackageInfo = {
    root: "portal", title: "Portal", kind: "package", confidence: "high",
    entryPath: null, configPath: null, packagePath: "portal/package.json", packageManager: null,
    scripts: { dev: "node server.js", build: "node build.js" }, configuredScripts: {}, configuredPreviewMode: null,
    configuredBuildOutput: null, buildOutputs: ["portal/dist"], sourceFiles: ["portal/package.json"],
    shareManifest: { ok: false, reason: "no-runnable-artifact" }, diagnostics: [], authority: { kind: "workspace" },
  };
  const run = (mode: "dev" | "build") => {
    const input: SitePreviewExecutionInput = {
      workspaceId: "trip", workspaceRoot, site: app, mode,
      sharedView: false, signal: new AbortController().signal, isCurrent: () => true,
    };
    return execute(input);
  };
  return { trust, run };
}

const gate = () => ({ reached: deferred<void>(), release: deferred<void>() });

describe("a revoke during the start of an app command", () => {
  it.each(["dev", "build"] as const)("lets a trusted %s command reach spawn", async (mode) => {
    const h = await harness();
    await expect(h.run(mode)).rejects.toThrow("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["dev", "build"] as const)("stops %s at spawn when the revoke lands during path resolution", async (mode) => {
    const h = await harness();
    resolving = gate();
    const started = h.run(mode);
    await resolving.reached.promise;
    h.trust.revoke("trip");
    resolving.release.resolve();
    await expect(started).rejects.toThrow(WorkspaceRestrictedError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["dev", "build"] as const)("stops %s when the revoke lands during the folder identity lookup", async (mode) => {
    const identifying = gate();
    const h = await harness(identifying);
    // The grant was written with a known folder, so this lookup is the check's.
    const started = h.run(mode);
    await identifying.reached.promise;
    h.trust.revoke("trip");
    identifying.release.resolve();
    await expect(started).rejects.toThrow(WorkspaceRestrictedError);
    expect(spawn).not.toHaveBeenCalled();
  });
});
