import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createPluginAuthoredTextWriter } from "./pluginAuthoredWrite";
import { PluginDoorWrites } from "./pluginDoorWrites";
import { canonicalPluginSourceHash } from "./pluginSourceSnapshot";
import { pluginBaselineManifestPath, writePluginBaselineManifest } from "./pluginUninstallPreflight";

type Files = ReadonlyArray<readonly [relPath: string, text: string]>;
const roots: string[] = [];

function digest(files: Files) {
  return files.map(([relPath, text]) => ({
    relPath,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  }));
}

function hash(files: Files): string {
  return canonicalPluginSourceHash(digest(files));
}

async function fixture(files: Files, directory = "owned") {
  const root = await mkdtemp(join(tmpdir(), "dohc-door-writes-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const pluginRoot = join(workspaceRoot, "plugins", directory);
  const dohcDir = join(root, "state");
  await mkdir(pluginRoot, { recursive: true });
  const approvedHash = hash(files);
  await writePluginBaselineManifest({
    dohcDir,
    pluginId: "owned",
    baselineDigest: { sourceHash: approvedHash, files: digest(files) },
    installedBaselineHash: approvedHash,
  });
  return { workspaceRoot, pluginRoot, dohcDir, approvedHash };
}

function owner(input: Awaited<ReturnType<typeof fixture>>, platform: NodeJS.Platform = "darwin") {
  return new PluginDoorWrites(
    input.workspaceRoot,
    input.dohcDir,
    platform,
    (pluginId) => pluginId === "owned" ? input.pluginRoot : null,
  );
}

// Recovery sees a case-sensitive virtual workspace; baseline reads still use
// the real temporary filesystem on every host, including Windows.
async function recoveringOwner(
  input: Awaited<ReturnType<typeof fixture>>,
  entries: (path: string) => string[] | Promise<string[]>,
  validRootFor: (pluginId: string) => string | null = () => "/workspace/plugins/owned",
) {
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const actualPath = await vi.importActual<typeof import("node:path")>("node:path");
  const virtual = (parts: string[]) => parts.some((part) => part.startsWith("/workspace"));
  vi.resetModules();
  vi.doMock("node:path", () => ({
    ...actualPath,
    resolve: (...parts: string[]) => virtual(parts) ? actualPath.posix.resolve(...parts) : actualPath.resolve(...parts),
    join: (...parts: string[]) => virtual(parts) ? actualPath.posix.join(...parts) : actualPath.join(...parts),
    relative: (from: string, to: string) => virtual([from, to]) ? actualPath.posix.relative(from, to) : actualPath.relative(from, to),
  }));
  vi.doMock("node:fs/promises", () => ({
    ...actualFs,
    readdir: async (...args: Parameters<typeof readdir>) => {
      const path = String(args[0]);
      return path.startsWith("/workspace") ? entries(path) : actualFs.readdir(...args);
    },
  }));
  const { PluginDoorWrites: WithRecovery } = await import("./pluginDoorWrites");
  return new WithRecovery("/workspace", input.dohcDir, "darwin", validRootFor);
}

afterEach(async () => {
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:path");
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PluginDoorWrites", () => {
  it("replaces and adds exact authored bytes in the approved digest", async () => {
    const input = await fixture([["src/index.ts", "baseline"]]);
    const writes = owner(input, "linux");
    expect(writes.record("owned", { absolutePath: join(input.pluginRoot, "src/index.ts"), text: "replaced" })).toBe(true);
    expect(writes.record("owned", { absolutePath: join(input.pluginRoot, "src/new.ts"), text: "added" })).toBe(true);
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([
      ["src/index.ts", "replaced"], ["src/new.ts", "added"],
    ]));
  });

  it("folds only provisional case drift onto a baseline spelling", async () => {
    const input = await fixture([["src/index.ts", "baseline"], ["src/final.ts", "untouched"]]);
    const writes = owner(input);
    writes.record("owned", { absolutePath: join(input.pluginRoot, "SRC/index.ts"), text: "replaced" });
    writes.record("owned", { absolutePath: join(input.pluginRoot, "SRC/final.ts"), text: "added" });
    expect(writes.rekey("owned", { absolutePath: join(input.pluginRoot, "SRC/final.ts") }, { absolutePath: join(input.pluginRoot, "SRC/final.ts") })).toBe(false);
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([
      ["src/index.ts", "replaced"], ["src/final.ts", "untouched"], ["SRC/final.ts", "added"],
    ]));
  });

  it("prefers an exact baseline key over a case-fold match", async () => {
    const input = await fixture([["SRC/a.ts", "upper"], ["src/a.ts", "lower"]]);
    const writes = owner(input);
    writes.record("owned", { absolutePath: join(input.pluginRoot, "SRC/a.ts"), text: "written" });
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([
      ["SRC/a.ts", "written"], ["src/a.ts", "lower"],
    ]));
  });

  it("keeps baseline-absent case variants distinct until recovery confirms one", async () => {
    const input = await fixture([]);
    const writes = owner(input);
    writes.record("owned", { absolutePath: join(input.pluginRoot, "SRC/new.ts"), text: "first" });
    writes.record("owned", { absolutePath: join(input.pluginRoot, "src/new.ts"), text: "latest" });
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([
      ["SRC/new.ts", "first"], ["src/new.ts", "latest"],
    ]));
  });

  it("folds a provisional NFC path onto an NFD baseline spelling", async () => {
    const nfd = "src/cafe\u0301.ts";
    const input = await fixture([[nfd, "baseline"]]);
    const writes = owner(input);
    writes.record("owned", { absolutePath: join(input.pluginRoot, "src/caf\u00e9.ts"), text: "written" });
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([[nfd, "written"]]));
  });

  it("records and confirms an authored NFC write under an NFD plugin root", async () => {
    const input = await fixture([["src/index.ts", "baseline"]], "cafe\u0301");
    const entryPath = join(input.pluginRoot, "src/index.ts");
    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, "baseline");
    const writes = owner(input);
    const write = createPluginAuthoredTextWriter({
      platform: "darwin",
      signal: undefined,
      requireWritableCapture: async () => ({
        workspaceRoot: input.workspaceRoot,
        capture: {
          writeAuthoredTextFile: async (absolutePath, text) => {
            await writeFile(entryPath, text);
            return { resolvedAbsolutePath: absolutePath };
          },
        },
      }),
      pipeline: () => ({
        pluginIdForPath: () => "owned",
        handleDoorWrittenSourceChange: (pluginId, written) => { writes.record(pluginId, written); },
        rekeyDoorWrittenSourceChange: (pluginId, from, to) => { writes.rekey(pluginId, from, to); },
      }),
    });
    await write("plugins/caf\u00e9/src/index.ts", "normalization-equivalent root\n", {
      overwrite: true,
      author: { kind: "agent", agentId: "plugin:owned", onBehalfOf: "local", agentRunId: "run-1" },
    });
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([["src/index.ts", "normalization-equivalent root\n"]]));
  });

  it("includes mixed-case source directories but removes a rekeyed excluded path", async () => {
    const input = await fixture([]);
    const writes = owner(input);
    const absolutePath = join(input.pluginRoot, "Node_Modules/x.ts");
    expect(writes.record("owned", { absolutePath, text: "included" })).toBe(true);
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([["Node_Modules/x.ts", "included"]]));
    expect(writes.rekey("owned", { absolutePath }, { absolutePath: join(input.pluginRoot, "node_modules/x.ts") })).toBe(true);
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(input.approvedHash);
  });

  it("rejects excluded paths, roots, outside paths, and an identity without a valid root", async () => {
    const input = await fixture([]);
    const writes = owner(input, "linux");
    for (const absolutePath of [input.pluginRoot, join(input.workspaceRoot, "outside.ts"), join(input.pluginRoot, ".dohc/x"), join(input.pluginRoot, "node_modules/x")]) {
      expect(writes.record("owned", { absolutePath, text: "ignored" })).toBe(false);
    }
    expect(writes.record("unknown", { absolutePath: join(input.pluginRoot, "a.ts"), text: "ignored" })).toBe(false);
    expect(writes.rekey("owned", { absolutePath: join(input.pluginRoot, "missing.ts") }, { absolutePath: join(input.pluginRoot, "a.ts") })).toBe(false);
    expect(writes.checkpoint()).toBe(0);
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(input.approvedHash);
  });

  it("settles only writes at the checkpoint and forgets only the named identity", async () => {
    const input = await fixture([["a.ts", "baseline a"], ["b.ts", "baseline b"]]);
    const writes = owner(input, "linux");
    writes.record("owned", { absolutePath: join(input.pluginRoot, "a.ts"), text: "earlier" });
    const checkpoint = writes.checkpoint();
    writes.record("owned", { absolutePath: join(input.pluginRoot, "b.ts"), text: "later" });
    writes.settle("owned", checkpoint);
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([["a.ts", "baseline a"], ["b.ts", "later"]]));
    writes.forget("another");
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([["a.ts", "baseline a"], ["b.ts", "later"]]));
    writes.forget("owned");
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(input.approvedHash);
    writes.record("owned", { absolutePath: join(input.pluginRoot, "a.ts"), text: "after forget" });
    expect(writes.checkpoint()).toBeGreaterThan(checkpoint);
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([["a.ts", "after forget"], ["b.ts", "baseline b"]]));
  });

  it("preserves sequence when rekeying and keeps a newer destination write", async () => {
    const input = await fixture([]);
    const writes = owner(input, "linux");
    const from = { absolutePath: join(input.pluginRoot, "old.ts") };
    const to = { absolutePath: join(input.pluginRoot, "new.ts") };
    writes.record("owned", { ...from, text: "old" });
    writes.record("owned", { ...to, text: "new" });
    const checkpoint = writes.checkpoint();
    expect(writes.rekey("owned", from, to)).toBe(true);
    expect(writes.checkpoint()).toBe(checkpoint);
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([["new.ts", "new"]]));
    writes.settle("owned", checkpoint);
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(input.approvedHash);
  });

  it("returns null for an unavailable, mismatched, or unverified baseline", async () => {
    const input = await fixture([["a.ts", "baseline"]]);
    const writes = owner(input);
    expect(await writes.approvedHash("missing", input.approvedHash)).toBeNull();
    expect(await writes.approvedHash("owned", "f".repeat(64))).toBeNull();
    const path = pluginBaselineManifestPath(input.dohcDir, "owned");
    await writeFile(path, JSON.stringify({ sourceHash: input.approvedHash, files: digest([["a.ts", "different"]]) }));
    expect(await writes.approvedHash("owned", input.approvedHash)).toBeNull();
  });

  it("validates the current root after an awaited baseline read", async () => {
    const input = await fixture([]);
    const replacementRoot = join(input.workspaceRoot, "replacement");
    await mkdir(join(replacementRoot, "src"), { recursive: true });
    await writeFile(join(replacementRoot, "src/index.ts"), "written");
    const started = deferred();
    const release = deferred();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      readFile: async (...args: Parameters<typeof readFile>) => {
        started.resolve();
        await release.promise;
        return actualFs.readFile(...args);
      },
    }));
    const { PluginDoorWrites: WithHeldBaseline } = await import("./pluginDoorWrites");
    let currentRoot: string | null = input.pluginRoot;
    const writes = new WithHeldBaseline(input.workspaceRoot, input.dohcDir, "darwin", () => currentRoot);
    writes.record("owned", { absolutePath: join(input.pluginRoot, "SRC/index.ts"), text: "written" });
    const pending = writes.approvedHash("owned", input.approvedHash);
    try {
      await started.promise;
      currentRoot = replacementRoot;
      release.resolve();
      expect(await pending).toBe(hash([["src/index.ts", "written"]]));
      currentRoot = null;
      expect(writes.record("owned", { absolutePath: join(input.pluginRoot, "later.ts"), text: "rejected" })).toBe(false);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("confirms a recovered plugin root by exact spelling", async () => {
    const input = await fixture([]);
    const writes = await recoveringOwner(input, () => []);
    const caller = { absolutePath: "/workspace/plugins/OWNED/src/index.ts" };
    writes.record("owned", { ...caller, text: "distinct root" });
    expect(writes.rekey("owned", caller, caller)).toBe(true);
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(input.approvedHash);
    writes.record("owned", { ...caller, text: "confirmed root" });
    expect(writes.rekey("owned", caller, { absolutePath: "/workspace/plugins/owned/src/index.ts" })).toBe(false);
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([["src/index.ts", "confirmed root"]]));
  });

  it.each([
    { entries: ["owned", "OWNED"], confirmed: false },
    { entries: ["owned"], confirmed: true },
  ])("confirms fold-attributed ownership with directory entries $entries", async (scenario) => {
    const input = await fixture([]);
    const writes = await recoveringOwner(input, (path) => {
      if (path === "/workspace") return ["plugins"];
      if (path === "/workspace/plugins") return scenario.entries;
      if (path.endsWith("/src")) return ["index.ts"];
      return ["src"];
    });
    writes.record("owned", { absolutePath: "/workspace/plugins/OWNED/src/index.ts", text: "written" });
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(
      scenario.confirmed ? hash([["src/index.ts", "written"]]) : input.approvedHash,
    );
  });

  it("converges baseline-absent variants after recovery confirms one spelling", async () => {
    const input = await fixture([]);
    const writes = await recoveringOwner(input, (path) => path.endsWith("/SRC") ? ["new.ts"] : ["SRC"]);
    writes.record("owned", { absolutePath: "/workspace/plugins/owned/SRC/new.ts", text: "first" });
    writes.record("owned", { absolutePath: "/workspace/plugins/owned/src/new.ts", text: "latest" });
    expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([["SRC/new.ts", "latest"]]));
  });

  it.each(["newer write", "forgotten identity"] as const)("ignores stale recovery after a %s", async (change) => {
    const input = await fixture([]);
    const started = deferred();
    const release = deferred();
    let blocked = false;
    const writes = await recoveringOwner(input, async (path) => {
      if (!blocked) {
        blocked = true;
        started.resolve();
        await release.promise;
      }
      return path.endsWith("/src") ? ["index.ts"] : ["src"];
    });
    writes.record("owned", { absolutePath: "/workspace/plugins/owned/src/index.ts", text: "old" });
    const pending = writes.approvedHash("owned", input.approvedHash);
    try {
      await started.promise;
      if (change === "forgotten identity") writes.forget("owned");
      writes.record("owned", { absolutePath: "/workspace/plugins/owned/src/index.ts", text: "new" });
      release.resolve();
      expect(await pending).toBe(hash([["src/index.ts", "new"]]));
      expect(await writes.approvedHash("owned", input.approvedHash)).toBe(hash([["src/index.ts", "new"]]));
    } finally {
      release.resolve();
      await pending;
    }
  });
});
