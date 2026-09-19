import { registerEstablishedPluginRecoveryTests } from "./pluginPipelineRecovery.test-suite";
import {
  cleanupPluginTools,
  cleanupPluginWorkspaces,
  createPluginWorkspace,
  ensureFromCommand,
  ensureFromSurface,
  fakeSpawnTransport,
  liveBundlePath,
  nodeForkProcess,
  pluginsDataRoot,
  pnpmRunnerEntry,
  resourcesBasePath,
  roots,
  stagePluginTools,
  stagingLeftovers,
  waitFor,
} from "./pluginPipelineTestSupport";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ListPluginsResult,
  PluginActionResult,
  PluginStatusChangedEvent,
  PluginStatusRecord,
} from "../ipc/bridgeContract";
import { PluginHost, type PluginHostOptions } from "./PluginHost";
import { createPluginAuthoredTextWriter } from "./pluginAuthoredWrite";
import { PLUGIN_HOST_METHODS } from "./pluginHostProtocol";
import {
  discoverInstalledPlugins,
  type InstalledPluginRecord,
} from "./pluginDiscovery";
import {
  PluginPipeline,
  type PluginPipelineStatusEvent,
} from "./PluginPipeline";
import { installPluginDependencies } from "./pluginInstallRunner";
import { buildPluginBundle } from "./pluginBuildRunner";
import {
  mutatePluginRecord,
  pluginDataDir,
  readPluginLocalState,
  workspaceStateKey,
} from "./pluginLocalState";
import {
  OfferedPluginAddError,
  addOfferedPlugin,
  listOfferedPlugins,
  removeAddedOfferedPlugin,
} from "./pluginOffers";
import { readPluginSettingsFile } from "./pluginSettingsFile";
import { PluginHostOwnership } from "./pluginHostOwnership";
import {
  hashPluginSourceFiles,
  pluginStateRoot,
  snapshotPluginSource,
} from "./pluginSourceSnapshot";
import {
  pluginBaselineManifestPath,
  pluginUninstallPreflight,
} from "./pluginUninstallPreflight";
import { deferred } from "../testing/deferred";

interface TestUninstallQueueClaim {
  readonly ready: Promise<void>;
  decide(decision: "stop" | "cancel"): void;
  release(): void;
  readonly stopOutcome: Promise<
    | { ok: true }
    | { ok: false; error: unknown }
  >;
  readonly outcome: Promise<
    | { ok: true }
    | { ok: false; error: unknown }
  >;
}

interface PluginPipelineQueueInternals {
  enqueueActionValue<T>(pluginId: string, run: () => Promise<T>): Promise<T>;
  claimUninstallCleanupQueues(
    cleanupIds: ReadonlyArray<string>,
    primaryPluginId: string,
    reservations: ReadonlyMap<string, unknown>,
    hooks: Parameters<PluginPipeline["disable"]>[1],
  ): TestUninstallQueueClaim[];
}

function transientStateOf(pipeline: PluginPipeline): {
  statuses: Map<string, unknown>;
  lastApprovedAttemptHash: Map<string, string>;
} {
  return pipeline as unknown as {
    statuses: Map<string, unknown>;
    lastApprovedAttemptHash: Map<string, string>;
  };
}

/** The published source tree — what a panel serves and a brokered child runs. */
function liveSnapshotRoot(
  fixture: { stateDir: string; workspaceRoot: string },
  pluginId: string,
): string {
  return join(pluginsDataRoot(fixture), pluginId, "snapshot");
}

async function expectNoLiveSnapshot(
  fixture: { stateDir: string; workspaceRoot: string },
  pluginId: string,
): Promise<void> {
  await expect(lstat(liveSnapshotRoot(fixture, pluginId)))
    .rejects.toMatchObject({ code: "ENOENT" });
}

/** Every file under `root`, by relative path, with its sha256 — the evidence
 * that a failed build left the live root byte-identical. */
async function fileHashes(
  root: string,
  base = root,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      Object.assign(hashes, await fileHashes(path, base));
      continue;
    }
    hashes[relative(base, path).replaceAll("\\", "/")] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  return hashes;
}

async function settleWithin<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Writes authored text and reports it door-written, exactly like main.ts's
 * writeAuthoredText -> handleDoorWrittenSourceChange call: the path and the
 * bytes that landed are the attributed delta.
 */
async function doorWrite(
  pipeline: PluginPipeline,
  pluginId: string,
  absolutePath: string,
  text: string,
): Promise<void> {
  await writeFile(absolutePath, text);
  pipeline.handleDoorWrittenSourceChange(pluginId, { absolutePath, text });
}

async function authoredDoorWrite(
  pipeline: PluginPipeline,
  workspaceRoot: string,
  path: string,
  text: string,
): Promise<void> {
  const write = createPluginAuthoredTextWriter({
    signal: undefined,
    requireWritableCapture: async () => ({
      workspaceRoot,
      capture: {
        writeAuthoredTextFile: async (absolutePath, writtenText) => {
          await writeFile(absolutePath, writtenText);
          return { resolvedAbsolutePath: absolutePath };
        },
      },
    }),
    pipeline: () => pipeline,
  });
  await write(path, text, {
    overwrite: true,
    author: {
      kind: "agent",
      agentId: "plugin:example-plugin",
      onBehalfOf: "local",
      agentRunId: "spawn-1",
    },
  });
}

async function createAliasUninstallFixture(options: {
  drainTimeoutMs?: number;
  onRuntimeStopped?: (pluginId: string) => void | Promise<void>;
} = {}): Promise<{
  fixture: Awaited<ReturnType<typeof createPluginWorkspace>>;
  host: PluginHost;
  hostOwnership: PluginHostOwnership<PluginHost>;
  pipeline: PluginPipeline;
}> {
  const fixture = await createPluginWorkspace({
    directoryName: "shared-dir",
    pluginId: "runtime-id",
    displayName: "runtime-id",
  });
  await mutatePluginRecord(
    fixture.stateDir,
    fixture.workspaceRoot,
    "original-id",
    () => ({ directoryName: "shared-dir" }),
  );
  await mutatePluginRecord(
    fixture.stateDir,
    fixture.workspaceRoot,
    "runtime-id",
    () => ({ directoryName: "shared-dir" }),
  );
  let pipeline!: PluginPipeline;
  const host = new PluginHost({
    stateDir: fixture.stateDir,
    workspaceRoot: fixture.workspaceRoot,
    spawnTransport: fakeSpawnTransport(),
    routeSdkRequest: async () => ({}),
    onStatusChange: (pluginId, status) => {
      pipeline.noteRuntimeStatus(pluginId, status);
    },
  });
  const hostOwnership = new PluginHostOwnership(host, {
    drainTimeoutMs: options.drainTimeoutMs,
  });
  pipeline = new PluginPipeline({
    isEngineCaptureAvailable: () => true,
    workspaceRoot: fixture.workspaceRoot,
    stateDir: fixture.stateDir,
    hostOwnership,
    resourcesBasePath,
    pnpmRunnerEntry,
    onRuntimeStopped: options.onRuntimeStopped,
    operations: {
      install: (input) =>
        installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
    },
  });
  await pipeline.start();
  return { fixture, host, hostOwnership, pipeline };
}

beforeAll(stagePluginTools);

afterEach(cleanupPluginWorkspaces);

afterAll(cleanupPluginTools);

describe("PluginPipeline real filesystem lifecycle", () => {

  it("discovers an added offer unapproved and installs it through the ordinary pipeline", async () => {
    const sourceFixture = await createPluginWorkspace();
    const builtinPluginsRoot = join(sourceFixture.root, "builtin-plugins");
    await cp(sourceFixture.pluginRoot, join(builtinPluginsRoot, "agent-chat"), {
      recursive: true,
    });

    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-pipeline-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    // A real workspace root always exists before any plugin operation runs —
    // dohc only opens an already-materialized folder — so this matches that
    // rather than leaving addOfferedPlugin's realpath() call to hit an
    // ENOENT this function was never meant to paper over.
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    await addOfferedPlugin({
      builtinPluginsRoot,
      workspaceRoot,
      directoryName: "agent-chat",
      existingPluginIds: new Set(),
    });

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    const hostOwnership = new PluginHostOwnership(host);
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership,
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.list()).toEqual([
        expect.objectContaining({
          id: "example-plugin",
          directoryName: "agent-chat",
          status: "discovered",
          valid: true,
          approvedHash: null,
        }),
      ]);

      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Added offered plugin did not reach ready after install.",
      );
      expect(pipeline.list()[0]).toMatchObject({
        id: "example-plugin",
        directoryName: "agent-chat",
        status: "ready",
      });
      expect(pipeline.list()[0]?.approvedHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("refuses to add when discovery hasn't caught up with a same-id directory already on disk", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-rescan-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const builtinPluginsRoot = join(targetRoot, "builtin-plugins");
    const builtinChatRoot = join(builtinPluginsRoot, "agent-chat");
    await mkdir(join(builtinChatRoot, "src"), { recursive: true });
    await writeFile(
      join(builtinChatRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "agent-chat", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(builtinChatRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    const hostOwnership = new PluginHostOwnership(host);
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership,
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.list()).toEqual([]);

      // Something other than this pipeline's own watcher — an agent, a
      // second client — created a directory claiming id "agent-chat" under a
      // different name. The bytes are on disk, but this pipeline's own
      // discovery has not rescanned yet: pipeline.list() is stale.
      const renamedRoot = join(workspaceRoot, "plugins", "my-chat");
      await mkdir(join(renamedRoot, "src"), { recursive: true });
      await writeFile(
        join(renamedRoot, "dohc-plugin.json"),
        `${JSON.stringify({ version: 1, name: "agent-chat", entry: "src/main.ts" }, null, 2)}\n`,
      );
      await writeFile(join(renamedRoot, "src", "main.ts"), "export default {};\n");
      expect(pipeline.list()).toEqual([]);

      // The fixed handler order: force the same rescan mechanism before
      // sampling ids, not only after the copy.
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);
      const existingPluginIds = new Set(pipeline.list().map((entry) => entry.id));
      expect(existingPluginIds).toEqual(new Set(["agent-chat"]));

      await expect(
        addOfferedPlugin({
          builtinPluginsRoot,
          workspaceRoot,
          directoryName: "agent-chat",
          existingPluginIds,
        }),
      ).rejects.toBeInstanceOf(OfferedPluginAddError);

      // Nothing copied.
      await expect(
        lstat(join(workspaceRoot, "plugins", "agent-chat")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("removes its own copy and leaves the concurrent plugin intact when a same-id directory appears mid-copy", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-conflict-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const builtinPluginsRoot = join(targetRoot, "builtin-plugins");
    const builtinChatRoot = join(builtinPluginsRoot, "agent-chat");
    await mkdir(join(builtinChatRoot, "src"), { recursive: true });
    await writeFile(
      join(builtinChatRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "agent-chat", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(builtinChatRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.list()).toEqual([]);

      // The fixed handler's pre-copy rescan: nothing claims "agent-chat" yet.
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);
      const existingPluginIds = new Set(pipeline.list().map((entry) => entry.id));
      expect(existingPluginIds.size).toBe(0);

      const added = await addOfferedPlugin({
        builtinPluginsRoot,
        workspaceRoot,
        directoryName: "agent-chat",
        existingPluginIds,
      });

      // Injected between the copy and the post-copy rescan — sorts before
      // "agent-chat" lexically, so discovery's own tie-break hands the id to it
      // and demotes the copy this request just made.
      const concurrentRoot = join(workspaceRoot, "plugins", "aaa-chat");
      await mkdir(join(concurrentRoot, "src"), { recursive: true });
      await writeFile(
        join(concurrentRoot, "dohc-plugin.json"),
        `${JSON.stringify({ version: 1, name: "agent-chat", entry: "src/main.ts" }, null, 2)}\n`,
      );
      await writeFile(join(concurrentRoot, "src", "main.ts"), "export default {};\n");

      // The fixed handler's post-copy rescan, then its own validity check:
      // the copy this request made lost the id it raced for.
      await pipeline.handleWatcherEvents([{ operation: "create", path: "plugins/agent-chat" }]);
      const copied = pipeline.list().find((entry) => entry.directoryName === "agent-chat");
      expect(copied?.valid).toBe(false);

      // The handler's cleanup on that conflict: remove what this request
      // wrote and rescan so the surviving side recovers.
      await removeAddedOfferedPlugin({
        workspaceRoot,
        directoryName: "agent-chat",
        identity: added.identity,
        contentHash: added.contentHash,
      });
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);

      await expect(
        lstat(join(workspaceRoot, "plugins", "agent-chat")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const survivor = pipeline.list().find((entry) => entry.directoryName === "aaa-chat");
      expect(survivor).toMatchObject({ id: "agent-chat", valid: true });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // uninstallableCandidate() only fell back to a
  // discovery entry for a plugin that had some prior installation —
  // validCandidate() rejects an invalid manifest outright, so a copy added
  // by Add and never installed had no candidate at all, and Remove's
  // preflight dead-ended with "preflight-failed". A broken manifest must
  // not remove the only way back to delete it.

  it("lets Remove delete a discovered plugin whose manifest is invalid and was never installed", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-remove-invalid-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const builtinPluginsRoot = join(targetRoot, "builtin-plugins");
    const builtinChatRoot = join(builtinPluginsRoot, "agent-chat");
    await mkdir(join(builtinChatRoot, "src"), { recursive: true });
    await writeFile(
      join(builtinChatRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "agent-chat",
        displayName: "Agent chat",
        entry: "src/main.ts",
      }, null, 2)}\n`,
    );
    await writeFile(join(builtinChatRoot, "src", "main.ts"), "export default {};\n");

    await addOfferedPlugin({
      builtinPluginsRoot,
      workspaceRoot,
      directoryName: "agent-chat",
      existingPluginIds: new Set(),
    });
    // Broken before the pipeline ever discovers it — the offer landed a
    // real copy, but it never becomes a valid, installable plugin.
    await writeFile(
      join(workspaceRoot, "plugins", "agent-chat", "dohc-plugin.json"),
      "{ this is not valid JSON\n",
    );

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const row = pipeline.list()[0];
      expect(row).toMatchObject({
        directoryName: "agent-chat",
        valid: false,
        status: "invalid",
        approvedHash: null,
      });
      const pluginId = row!.id;

      const preflight = await pipeline.uninstallPreflight(pluginId, pluginId);
      if (!preflight.ok) {
        throw new Error(`${preflight.error.stage}/${preflight.error.code}: ${preflight.error.message}`);
      }
      const removed = await pipeline.uninstall(pluginId, pluginId, preflight.confirmationToken);
      expect(removed.ok).toBe(true);

      await expect(
        lstat(join(workspaceRoot, "plugins", "agent-chat")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(pipeline.list()).toEqual([]);

      // The offer is restored now that nothing occupies plugins/agent-chat.
      const offers = await listOfferedPlugins(builtinPluginsRoot, workspaceRoot, new Set());
      expect(offers.map((offer) => offer.directoryName)).toContain("agent-chat");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // A directory installed as "agent-chat" whose install never
  // finished (no approvedHash) can still have left state and plugin data
  // filed under "agent-chat" before its manifest broke. A broken manifest gives
  // discovery a directory-derived fallback id — "my-chat-copy" here, never
  // "agent-chat" — and uninstall used to derive every cleanup path from that id
  // alone: it deleted the source correctly (the candidate's rootPath is
  // resolved by directory) but found nothing to delete under the fallback
  // key, silently stranding the real state and data under "agent-chat" forever.

  it("clears source and the originally-keyed state when a never-approved install's manifest breaks under a different directory name", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-stranded-state-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const pluginRoot = join(workspaceRoot, "plugins", "my-chat-copy");
    await mkdir(join(pluginRoot, "src"), { recursive: true });
    await writeFile(
      join(pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "agent-chat", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(pluginRoot, "src", "main.ts"), "export default {};\n");

    // A partial install left state under the manifest id "agent-chat" before
    // approval completed. directoryName must still find it after the manifest
    // breaks.
    await mutatePluginRecord(stateDir, workspaceRoot, "agent-chat", () => ({
      directoryName: "my-chat-copy",
    }));
    const dohcDir = pluginDataDir(stateDir, workspaceRoot);
    const strandedStateRoot = pluginStateRoot(dohcDir, "agent-chat");
    await mkdir(strandedStateRoot, { recursive: true });
    await writeFile(join(strandedStateRoot, "session.json"), "{}");

    // Broken before the pipeline ever discovers it — id falls back to the
    // directory name, which does not match the "agent-chat" key above.
    await writeFile(join(pluginRoot, "dohc-plugin.json"), "{ this is not valid JSON\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const row = pipeline.list()[0];
      expect(row).toMatchObject({
        directoryName: "my-chat-copy",
        id: "my-chat-copy",
        valid: false,
        approvedHash: null,
      });

      const preflight = await pipeline.uninstallPreflight(row!.id, row!.id);
      if (!preflight.ok) {
        throw new Error(`${preflight.error.stage}/${preflight.error.code}: ${preflight.error.message}`);
      }
      // Cleanup deletes state under both identities, so
      // the confirmation the user actually sees has to name that data
      // before they confirm — not only the fallback id's own (empty) state.
      expect(preflight.preflight.stateData).toMatchObject({ fileCount: 1 });
      expect(preflight.preflight.stateData?.path).toContain(strandedStateRoot);
      expect(
        preflight.preflight.warning?.details.some((detail) =>
          detail.includes("stored data")
        ),
      ).toBe(true);

      const removed = await pipeline.uninstall(row!.id, row!.id, preflight.confirmationToken);
      expect(removed.ok).toBe(true);

      // The source directory is gone.
      await expect(lstat(pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
      // The state stranded under the original "agent-chat" key is gone too, not
      // silently left behind under a key nothing will ever visit again.
      await expect(lstat(strandedStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const state = await readPluginLocalState(stateDir, workspaceRoot);
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["agent-chat"]).toBeUndefined();
      expect(state.state.plugins["my-chat-copy"]).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // A discovered (never-installed) row's own id is only
  // ever a broken manifest's directory-derived fallback — a plain string
  // that can coincide with some other, unrelated, valid plugin's real
  // manifest id. classifyInstalledPlugins's own duplicate-id detection
  // never sees this collision at all: it only compares real, parsed
  // manifest ids against each other, and a broken manifest has none to
  // compare. Resolving by id first — id-matched candidates are never
  // ambiguous, discovery's duplicate handling already guarantees that
  // among valid manifests — used to hand this call the wrong plugin
  // entirely: the unrelated one whose id string happens to match, not the
  // one at the directory the caller actually named.

  it("resolves Remove by the exact directory named, even when an invalid row's fallback id collides with another plugin's real, installed id", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-id-collision-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    // The plugin genuinely installed and running under id "target-dir" —
    // in a directory named "other-dir", nothing to do with the row about
    // to be removed.
    const otherRoot = join(workspaceRoot, "plugins", "other-dir");
    await mkdir(join(otherRoot, "src"), { recursive: true });
    await writeFile(
      join(otherRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "target-dir", entry: "src/index.ts" }, null, 2)}\n`,
    );
    await writeFile(
      join(otherRoot, "package.json"),
      `${JSON.stringify({
        name: "target-dir",
        version: "1.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.20.0",
      }, null, 2)}\n`,
    );
    await writeFile(join(otherRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n"));
    await writeFile(
      join(otherRoot, "src", "index.ts"),
      'export default { activate() {} };\n',
    );

    let pipeline: PluginPipeline;
    // The dialog gathers the destructive inventory once. Execution then
    // re-resolves the same identity twice and probes only the source hash.
    const preflightStateRoots: (string | null)[] = [];
    const revalidatedSourceRoots: string[] = [];
    // The "removed" event this uninstall
    // emits must name the row that actually left — never the id alone,
    // which the still-installed survivor shares.
    const events: PluginPipelineStatusEvent[] = [];
    const newHost = () =>
      new PluginHost({
        stateDir,
        workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
    const newPipeline = () =>
      new PluginPipeline({
        isEngineCaptureAvailable: () => true,
        workspaceRoot,
        stateDir,
        hostOwnership: new PluginHostOwnership(newHost()),
        resourcesBasePath,
        pnpmRunnerEntry,
        onStatusChange: (event) => events.push(event),
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
          uninstallPreflight: async (input) => {
            preflightStateRoots.push(input.stateRoot);
            return pluginUninstallPreflight(input);
          },
          hashSource: async (rootPath) => {
            revalidatedSourceRoots.push(rootPath);
            return hashPluginSourceFiles(rootPath);
          },
        },
      });

    pipeline = newPipeline();
    try {
      await pipeline.start();
      const installed = await pipeline.install("target-dir");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The unrelated plugin did not reach ready.",
      );
    } finally {
      await pipeline.dispose();
    }

    // The unrelated plugin's own stored data, genuinely filed under the
    // id it was installed under — "target-dir" — the same key the invalid
    // row's own fallback id happens to collide with.
    const survivorStateRoot = pluginStateRoot(
      pluginDataDir(stateDir, workspaceRoot),
      "target-dir",
    );
    await mkdir(join(survivorStateRoot, "t3"), { recursive: true });
    await writeFile(join(survivorStateRoot, "t3", "session.sqlite"), "session-bytes");

    // The row the user actually clicks Remove on, added after the other
    // plugin is already running: a broken manifest, so discovery names it
    // by its directory — "target-dir" — which is also, coincidentally,
    // the real, installed manifest id the unrelated plugin above declares.
    const invalidRoot = join(workspaceRoot, "plugins", "target-dir");
    await mkdir(join(invalidRoot, "src"), { recursive: true });
    await writeFile(join(invalidRoot, "dohc-plugin.json"), "{ this is not valid JSON\n");
    await writeFile(join(invalidRoot, "src", "main.ts"), "export default {};\n");

    pipeline = newPipeline();
    try {
      await pipeline.start();
      await waitFor(
        () => pipeline.list().some((row) => row.directoryName === "other-dir" && row.status === "ready"),
        "The unrelated plugin was not running after reopening.",
      );
      const invalidRow = pipeline.list().find((row) => row.directoryName === "target-dir");
      const otherRow = pipeline.list().find((row) => row.directoryName === "other-dir");
      // The collision itself: both rows claim id "target-dir".
      expect(invalidRow).toMatchObject({ id: "target-dir", valid: false });
      expect(otherRow).toMatchObject({
        id: "target-dir",
        valid: true,
        approvedHash: expect.any(String),
      });

      // The user named the invalid row specifically — its own id and its
      // own directory, exactly what the renderer sends for a discovered
      // row.
      const preflight = await pipeline.uninstallPreflight("target-dir", "target-dir");
      if (!preflight.ok) throw new Error(preflight.error.message);
      // The dialog must not threaten data cleanup already
      // excludes. The survivor's real stored data planted above is not
      // named here at all — the invalid row genuinely has none of its
      // own — and the comparison never claims the invalid row's source
      // is "modified" against the survivor's own baseline; with no
      // baseline of its own, it honestly reads as unverifiable instead.
      expect(preflight.preflight.stateData).toBeNull();
      expect(preflight.preflight.warning?.summary ?? "").not.toContain("stored data");
      expect(preflight.preflight.verification).toBe("cannot-verify");
      expect(preflight.preflight.installedBaselineHash).toBeNull();

      events.length = 0;
      const removed = await pipeline.uninstall("target-dir", "target-dir", preflight.confirmationToken);
      expect(removed.ok).toBe(true);
      if (!removed.ok) throw new Error(removed.error.message);
      expect(removed.identity).toBe("retained");

      // The emitted event names the invalid row's own
      // directory — never "other-dir", the survivor this id also names.
      // main's forgetUninstalledPlugin relies on exactly this to apply the
      // standing trace-to-directory rule and never forget the survivor's
      // own registration.
      expect(events).toContainEqual({
        kind: "removed",
        pluginId: "target-dir",
        directoryName: "target-dir",
      });

      // Inventory and warning traversal belong only to the dialog. The two
      // execution checks fingerprint the exact source root without walking
      // the unrelated survivor's state.
      expect(preflightStateRoots).toEqual([null]);
      expect(revalidatedSourceRoots).toEqual([invalidRoot, invalidRoot]);

      // The invalid directory is gone...
      await expect(lstat(invalidRoot)).rejects.toMatchObject({ code: "ENOENT" });
      // ...and the unrelated, installed plugin is completely untouched:
      // its source, its build, its state, and its running process all
      // survive — not only its files.
      await expect(readFile(join(survivorStateRoot, "t3", "session.sqlite"), "utf8"))
        .resolves.toBe("session-bytes");
      await expect(readFile(join(otherRoot, "dohc-plugin.json"), "utf8"))
        .resolves.toContain('"name": "target-dir"');
      const survivor = pipeline.list().find((row) => row.directoryName === "other-dir");
      expect(survivor).toMatchObject({
        id: "target-dir",
        valid: true,
        status: "ready",
        approvedHash: expect.any(String),
      });
      expect(await readFile(liveBundlePath({ stateDir, workspaceRoot }, "target-dir"), "utf8"))
        .toContain("activate");
      const state = await readPluginLocalState(stateDir, workspaceRoot);
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["target-dir"]).toMatchObject({
        disabled: false,
        directoryName: "other-dir",
      });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Two id-colliding rows can each have their own
  // Remove dialog open at once — one tab per row. Keying
  // uninstallConfirmations by pluginId alone let the second row's
  // preflight silently overwrite the first's still-open confirmation:
  // confirming the first dialog would fail on a token that no longer
  // matched, or resolve against whatever row the second preflight actually
  // named.

  it("keeps two id-colliding rows' open uninstall confirmations apart", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-confirmation-collision-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const otherRoot = join(workspaceRoot, "plugins", "other-dir");
    await mkdir(join(otherRoot, "src"), { recursive: true });
    await writeFile(
      join(otherRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "target-dir", entry: "src/index.ts" }, null, 2)}\n`,
    );
    await writeFile(
      join(otherRoot, "package.json"),
      `${JSON.stringify({
        name: "target-dir",
        version: "1.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.20.0",
      }, null, 2)}\n`,
    );
    await writeFile(join(otherRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n"));
    await writeFile(
      join(otherRoot, "src", "index.ts"),
      'export default { activate() {} };\n',
    );

    let pipeline: PluginPipeline;
    const newHost = () =>
      new PluginHost({
        stateDir,
        workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
    const newPipeline = () =>
      new PluginPipeline({
        isEngineCaptureAvailable: () => true,
        workspaceRoot,
        stateDir,
        hostOwnership: new PluginHostOwnership(newHost()),
        resourcesBasePath,
        pnpmRunnerEntry,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

    pipeline = newPipeline();
    try {
      await pipeline.start();
      const installed = await pipeline.install("target-dir");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The unrelated plugin did not reach ready.",
      );
    } finally {
      await pipeline.dispose();
    }

    // A second row, added after the other plugin is already running: a
    // broken manifest, so discovery names it by its directory —
    // "target-dir" — which is also, coincidentally, the real, installed
    // manifest id the unrelated plugin above declares.
    const invalidRoot = join(workspaceRoot, "plugins", "target-dir");
    await mkdir(join(invalidRoot, "src"), { recursive: true });
    await writeFile(join(invalidRoot, "dohc-plugin.json"), "{ this is not valid JSON\n");
    await writeFile(join(invalidRoot, "src", "main.ts"), "export default {};\n");

    pipeline = newPipeline();
    try {
      await pipeline.start();
      await waitFor(
        () => pipeline.list().some((row) => row.directoryName === "other-dir" && row.status === "ready"),
        "The unrelated plugin was not running after reopening.",
      );
      // The collision itself: both rows claim id "target-dir".
      expect(pipeline.list().find((row) => row.directoryName === "target-dir"))
        .toMatchObject({ id: "target-dir", valid: false });
      expect(pipeline.list().find((row) => row.directoryName === "other-dir"))
        .toMatchObject({ id: "target-dir", valid: true, approvedHash: expect.any(String) });

      // Both tabs' own dialogs open their own preflight, one after the
      // other — the shape two open Remove dialogs on colliding rows take.
      const preflightInvalid = await pipeline.uninstallPreflight("target-dir", "target-dir");
      if (!preflightInvalid.ok) throw new Error(preflightInvalid.error.message);
      const preflightOther = await pipeline.uninstallPreflight("target-dir", "other-dir");
      if (!preflightOther.ok) throw new Error(preflightOther.error.message);
      expect(preflightInvalid.confirmationToken).not.toBe(preflightOther.confirmationToken);

      // The first dialog's own token still confirms against the invalid
      // row specifically — the second preflight, for the same id at a
      // different directory, never silently replaced it.
      const removedInvalid = await pipeline.uninstall(
        "target-dir",
        "target-dir",
        preflightInvalid.confirmationToken,
      );
      expect(removedInvalid.ok).toBe(true);
      await expect(lstat(invalidRoot)).rejects.toMatchObject({ code: "ENOENT" });

      // The installed survivor is untouched by the first row's removal,
      // and its own dialog's token still confirms against it specifically.
      expect(pipeline.list().find((row) => row.directoryName === "other-dir"))
        .toMatchObject({ id: "target-dir", valid: true, status: "ready" });
      const removedOther = await pipeline.uninstall(
        "target-dir",
        "other-dir",
        preflightOther.confirmationToken,
      );
      expect(removedOther.ok).toBe(true);
      await expect(lstat(otherRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // The row-resolution fix above protects a pair the
  // renderer would actually send (a row's own id with its own directory,
  // even when that id happens to collide with an unrelated plugin's real
  // one). A pair that names two genuinely unrelated rows — this plugin's
  // real, installed id paired with some other directory it was never
  // installed at — must be refused outright, before uninstallRootPath or
  // any cleanup identity is even resolved from it.

  it("refuses a pluginId/directoryName pair that names two unrelated rows, before anything is touched", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    // A second, unrelated directory this "example-plugin" id was never
    // installed at — the arbitrary combination a buggy or hostile caller
    // could send.
    const unrelatedRoot = join(fixture.workspaceRoot, "plugins", "unrelated-dir");
    await mkdir(join(unrelatedRoot, "src"), { recursive: true });
    await writeFile(
      join(unrelatedRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "unrelated-id", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(unrelatedRoot, "src", "main.ts"), "export default {};\n");

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().find((row) => row.directoryName === "example-plugin")?.status
          === "ready",
        "example-plugin did not reach ready.",
      );

      const preflight = await pipeline.uninstallPreflight("example-plugin", "unrelated-dir");
      expect(preflight.ok).toBe(false);
      if (preflight.ok) throw new Error("unreachable");
      expect(preflight.error.stage).toBe("uninstall");

      // Nothing touched: both directories survive, and no confirmation
      // token exists for uninstall() to act on.
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();
      await expect(lstat(unrelatedRoot)).resolves.toBeDefined();
      expect(pipeline.list().find((row) => row.directoryName === "example-plugin"))
        .toMatchObject({ status: "ready", approvedHash: expect.any(String) });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // The pair check above only ever verified that
  // pluginId belongs to whatever candidate got resolved — never that the
  // resolved candidate is even the row this call was actually asked about.
  // A directory that vanishes between the click and this call makes
  // byDirectory fail, and uninstallableCandidate's own id-keyed fallback
  // can then resolve a completely different, genuinely installed plugin
  // whose real id only happens to collide with the vanished row's
  // directory-derived fallback id — pluginId === candidate.id trivially,
  // so the old check passed it straight through to a real confirmation
  // token for a plugin the dialog never named.

  it("refuses a directoryName that names no row, even when it collides with an unrelated installed plugin's id", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-vanished-directory-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    // Broken from the start: its fallback id is its own directory name,
    // "collide".
    const invalidRoot = join(workspaceRoot, "plugins", "collide");
    await mkdir(join(invalidRoot, "src"), { recursive: true });
    await writeFile(join(invalidRoot, "dohc-plugin.json"), "{ this is not valid JSON\n");
    await writeFile(join(invalidRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();

      // The invalid row is removed for real: its directory and discovery
      // entry both go away, exactly like the race this pins.
      const removePreflight = await pipeline.uninstallPreflight("collide", "collide");
      if (!removePreflight.ok) throw new Error(removePreflight.error.message);
      const removed = await pipeline.uninstall("collide", "collide", removePreflight.confirmationToken);
      expect(removed.ok).toBe(true);
      await expect(lstat(invalidRoot)).rejects.toMatchObject({ code: "ENOENT" });

      // A separate, genuinely installed plugin whose real manifest name
      // collides with the vanished row's old fallback id — at a completely
      // different directory.
      const installedRoot = join(workspaceRoot, "plugins", "installed-dir");
      await mkdir(join(installedRoot, "src"), { recursive: true });
      await writeFile(
        join(installedRoot, "dohc-plugin.json"),
        `${JSON.stringify({ version: 1, name: "collide", entry: "src/main.ts" }, null, 2)}\n`,
      );
      await writeFile(
        join(installedRoot, "package.json"),
        `${JSON.stringify({
          name: "collide",
          version: "1.0.0",
          private: true,
          type: "module",
          packageManager: "pnpm@11.20.0",
        }, null, 2)}\n`,
      );
      await writeFile(join(installedRoot, "pnpm-lock.yaml"), [
        "lockfileVersion: '9.0'",
        "settings:",
        "  autoInstallPeers: true",
        "  excludeLinksFromLockfile: false",
        "importers:",
        "  .: {}",
        "",
      ].join("\n"));
      await writeFile(join(installedRoot, "src", "main.ts"), "export default {};\n");
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);
      const installed = await pipeline.install("collide");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().find((row) => row.directoryName === "installed-dir")?.status
          === "ready",
        "installed-dir did not reach ready.",
      );

      // The stale directoryName from the vanished row — the exact request
      // a delayed retry or a leftover dialog would still send.
      const stalePreflight = await pipeline.uninstallPreflight("collide", "collide");
      expect(stalePreflight.ok).toBe(false);
      if (stalePreflight.ok) throw new Error("unreachable");
      expect(stalePreflight.error.stage).toBe("uninstall");

      // The installed plugin never entered the confirmation: it survives,
      // untouched, and uninstall() has no token to act on for it.
      await expect(lstat(installedRoot)).resolves.toBeDefined();
      expect(pipeline.list().find((row) => row.directoryName === "installed-dir"))
        .toMatchObject({ status: "ready", approvedHash: expect.any(String) });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Cleanup must include both the broken manifest's fallback id and records
  // whose directoryName names this directory. They can have different keys,
  // and candidate.id can also own a separate record. cleanupIds deduplicates
  // any overlap; skipping candidate.id would strand its state.
  it("cleans up a record filed under candidate.id's own key, distinct from pluginId", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-candidate-id-edge-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const pluginRoot = join(workspaceRoot, "plugins", "mixed-dir");
    await mkdir(join(pluginRoot, "src"), { recursive: true });
    // Broken from the start: discovery never has a manifest to name this
    // directory by, so its id is always its own directory-derived
    // fallback — "mixed-dir".
    await writeFile(join(pluginRoot, "dohc-plugin.json"), "{ this is not valid JSON\n");
    await writeFile(join(pluginRoot, "src", "main.ts"), "export default {};\n");

    // Two separate persisted records both trace to "mixed-dir" by
    // directoryName: the original id this row was installed under (what
    // the renderer actually passes as pluginId), and a second, genuine
    // record filed directly under the id "mixed-dir" itself — candidate.id,
    // once discovery falls back to it.
    await mutatePluginRecord(stateDir, workspaceRoot, "original-id", () => ({
      directoryName: "mixed-dir",
    }));
    await mutatePluginRecord(stateDir, workspaceRoot, "mixed-dir", () => ({
      directoryName: "mixed-dir",
    }));
    const dohcDir = pluginDataDir(stateDir, workspaceRoot);
    const originalStateRoot = pluginStateRoot(dohcDir, "original-id");
    const candidateIdStateRoot = pluginStateRoot(dohcDir, "mixed-dir");
    await mkdir(originalStateRoot, { recursive: true });
    await writeFile(join(originalStateRoot, "session.json"), "{}");
    await mkdir(candidateIdStateRoot, { recursive: true });
    await writeFile(join(candidateIdStateRoot, "session.json"), "{}");

    let pipeline: PluginPipeline;
    const stoppedRuntimeIds: string[] = [];
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    const hostOwnership = new PluginHostOwnership(host);
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership,
      resourcesBasePath,
      pnpmRunnerEntry,
      onRuntimeStopped: (pluginId) => {
        stoppedRuntimeIds.push(pluginId);
      },
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const transient = transientStateOf(pipeline);
      const trackedStatus = pipeline.list().find((row) => row.directoryName === "mixed-dir");
      expect(trackedStatus).toBeDefined();
      transient.statuses.set("original-id", trackedStatus!);
      transient.statuses.set("mixed-dir", trackedStatus!);
      transient.lastApprovedAttemptHash.set("original-id", "a".repeat(64));
      transient.lastApprovedAttemptHash.set("mixed-dir", "b".repeat(64));
      // "original-id" is a valid pair for "mixed-dir": its persisted record
      // names this directory.
      const preflight = await pipeline.uninstallPreflight("original-id", "mixed-dir");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const reserveChange = vi.spyOn(hostOwnership, "reserveChange");
      const revokedRuntimeIds: string[] = [];
      const removing = pipeline.uninstall(
        "original-id",
        "mixed-dir",
        preflight.confirmationToken,
        {
          onWillStopRuntime: (pluginId) => revokedRuntimeIds.push(pluginId),
        },
      );
      expect(reserveChange.mock.calls.map(([pluginId]) => pluginId)).toEqual([
        "original-id",
        "mixed-dir",
      ]);
      const removed = await removing;
      expect(removed.ok).toBe(true);
      expect(revokedRuntimeIds.toSorted()).toEqual([
        "mixed-dir",
        "original-id",
      ]);
      expect(stoppedRuntimeIds.toSorted()).toEqual([
        "mixed-dir",
        "original-id",
      ]);

      await expect(lstat(pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
      // Both identities' state are gone — not only pluginId's own.
      await expect(lstat(originalStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(candidateIdStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const state = await readPluginLocalState(stateDir, workspaceRoot);
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["original-id"]).toBeUndefined();
      expect(state.state.plugins["mixed-dir"]).toBeUndefined();
      expect(transient.statuses.has("original-id")).toBe(false);
      expect(transient.statuses.has("mixed-dir")).toBe(false);
      expect(transient.lastApprovedAttemptHash.has("original-id")).toBe(false);
      expect(transient.lastApprovedAttemptHash.has("mixed-dir")).toBe(false);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("rejects a removed alias's confirmation after the same plugin is recreated", async () => {
    const setup = await createAliasUninstallFixture();
    const sourcePaths = [
      join(setup.fixture.pluginRoot, "dohc-plugin.json"),
      join(setup.fixture.pluginRoot, "package.json"),
      join(setup.fixture.pluginRoot, "pnpm-lock.yaml"),
      setup.fixture.entryPath,
    ];
    const source = await Promise.all(sourcePaths.map((path) => readFile(path)));
    try {
      const initialInstall = await setup.pipeline.install("runtime-id");
      if (!initialInstall.ok) throw new Error(initialInstall.error.message);
      await waitFor(
        () => setup.pipeline.list().some(
          (row) => row.directoryName === "shared-dir" && row.status === "ready",
        ),
        "The initial plugin did not reach ready.",
      );
      const installedState = await readPluginLocalState(
        setup.fixture.stateDir,
        setup.fixture.workspaceRoot,
      );
      if (!installedState.ok) throw new Error(installedState.warning);
      const originalRecord = installedState.state.plugins["original-id"];
      const aliasRecord = installedState.state.plugins["runtime-id"];
      if (!originalRecord || !aliasRecord) {
        throw new Error("The alias uninstall fixture has incomplete records.");
      }
      const staleAlias = await setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!staleAlias.ok) throw new Error(staleAlias.error.message);
      const primary = await setup.pipeline.uninstallPreflight(
        "runtime-id",
        "shared-dir",
      );
      if (!primary.ok) throw new Error(primary.error.message);

      const removed = await setup.pipeline.uninstall(
        "runtime-id",
        "shared-dir",
        primary.confirmationToken,
      );
      expect(removed.ok).toBe(true);

      await mkdir(dirname(setup.fixture.entryPath), { recursive: true });
      await Promise.all(
        sourcePaths.map((path, index) => writeFile(path, source[index]!)),
      );
      await setup.pipeline.handleWatcherEvents([
        { operation: "update", path: "plugins" },
      ]);
      const reinstalled = await setup.pipeline.install("runtime-id");
      if (!reinstalled.ok) throw new Error(reinstalled.error.message);
      await waitFor(
        () => setup.pipeline.list().some(
          (row) => row.directoryName === "shared-dir" && row.status === "ready",
        ),
        "The recreated plugin did not reach ready.",
      );
      await mutatePluginRecord(
        setup.fixture.stateDir,
        setup.fixture.workspaceRoot,
        "original-id",
        () => originalRecord,
      );
      await mutatePluginRecord(
        setup.fixture.stateDir,
        setup.fixture.workspaceRoot,
        "runtime-id",
        () => aliasRecord,
      );
      await setup.pipeline.handleWatcherEvents([
        { operation: "update", path: "plugins" },
      ]);

      const staleRemoval = await setup.pipeline.uninstall(
        "original-id",
        "shared-dir",
        staleAlias.confirmationToken,
      );
      await expect(lstat(setup.fixture.pluginRoot)).resolves.toBeDefined();
      expect(staleRemoval).toMatchObject({
        ok: false,
        error: { code: "confirmation-required" },
      });
      await expect(
        Promise.all(sourcePaths.map((path) => readFile(path))),
      ).resolves.toEqual(source);
      const preservedState = await readPluginLocalState(
        setup.fixture.stateDir,
        setup.fixture.workspaceRoot,
      );
      if (!preservedState.ok) throw new Error(preservedState.warning);
      expect(preservedState.state.plugins["original-id"]).toEqual(originalRecord);
      expect(preservedState.state.plugins["runtime-id"]).toEqual(aliasRecord);
      expect(setup.pipeline.list()).toContainEqual(
        expect.objectContaining({
          id: "runtime-id",
          directoryName: "shared-dir",
          status: "ready",
        }),
      );
    } finally {
      await setup.pipeline.dispose();
    }
  }, 60_000);

  it("rejects an uninstall when earlier alias work changes the confirmed target", async () => {
    const fixture = await createPluginWorkspace({
      directoryName: "shared-dir",
      pluginId: "runtime-id",
      displayName: "runtime-id",
    });
    await mutatePluginRecord(
      fixture.stateDir,
      fixture.workspaceRoot,
      "original-id",
      () => ({ directoryName: "shared-dir" }),
    );
    await mutatePluginRecord(
      fixture.stateDir,
      fixture.workspaceRoot,
      "runtime-id",
      () => ({ directoryName: "shared-dir" }),
    );
    const buildEntered = deferred();
    const releaseBuild = deferred();
    const revalidationEntered = deferred();
    const releaseRevalidation = deferred();
    let hashSourceCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    const hostOwnership = new PluginHostOwnership(host);
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership,
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        hashSource: async (rootPath) => {
          hashSourceCalls += 1;
          if (hashSourceCalls === 1) {
            revalidationEntered.resolve();
            await releaseRevalidation.promise;
          }
          return hashPluginSourceFiles(rootPath);
        },
        build: async (input) => {
          buildEntered.resolve();
          await releaseBuild.promise;
          return buildPluginBundle(input);
        },
      },
    });

    let lease: Exclude<
      ReturnType<PluginHostOwnership<PluginHost>["acquireSurface"]>,
      { kind: "refused" }
    > | undefined;
    let starting: Promise<unknown> | undefined;
    try {
      await pipeline.start();
      const preflight = await pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!preflight.ok) throw new Error(preflight.error.message);

      const acquired = hostOwnership.acquireSurface("runtime-id");
      if ("kind" in acquired) throw new Error("The alias surface was refused.");
      lease = acquired;
      starting = lease.start(async (authority) =>
        pipeline.ensureStarted("runtime-id", authority)
      );
      await buildEntered.promise;

      const pipelineInternals = pipeline as unknown as {
        enqueueActionValue: <T>(
          pluginId: string,
          run: () => Promise<T>,
        ) => Promise<T>;
      };
      const enqueueActionValue = vi.spyOn(
        pipelineInternals,
        "enqueueActionValue",
      );
      const removing = pipeline.uninstall(
        "original-id",
        "shared-dir",
        preflight.confirmationToken,
      );

      // The claim is synchronous with uninstall admission. It sits behind
      // the build already in runtime-id's queue and ahead of anything that
      // can arrive after the irreversible action was accepted. Exact target
      // validation waits for that earlier build to settle, then rejects its
      // durable-record drift before stopping either identity.
      expect(enqueueActionValue.mock.calls.map(([pluginId]) => pluginId))
        .toContain("runtime-id");

      releaseBuild.resolve();
      await starting;
      await revalidationEntered.promise;

      let lateAliasJobEntered = false;
      const lateAliasJob = pipelineInternals.enqueueActionValue(
        "runtime-id",
        async () => {
          lateAliasJobEntered = true;
        },
      );
      expect(lateAliasJobEntered).toBe(false);

      releaseRevalidation.resolve();
      const removed = await removing;
      await lateAliasJob;

      expect(removed).toMatchObject({
        ok: false,
        error: { code: "confirmation-stale" },
      });
      expect(lateAliasJobEntered).toBe(true);
      expect(host.currentRecord("runtime-id")).toBeDefined();
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();
      await expect(lstat(join(pluginsDataRoot(fixture), "runtime-id")))
        .resolves.toBeDefined();
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["original-id"]).toBeDefined();
      expect(state.state.plugins["runtime-id"]).toBeDefined();
    } finally {
      releaseBuild.resolve();
      releaseRevalidation.resolve();
      await starting?.catch(() => undefined);
      await lease?.release();
      await pipeline.dispose();
    }
  }, 60_000);

  it("enqueues crossed alias uninstall claims and actions in one turn", async () => {
    const setup = await createAliasUninstallFixture();
    try {
      const originalPreflight = await setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!originalPreflight.ok) throw new Error(originalPreflight.error.message);
      const runtimePreflight = await setup.pipeline.uninstallPreflight(
        "runtime-id",
        "shared-dir",
      );
      if (!runtimePreflight.ok) throw new Error(runtimePreflight.error.message);

      const internals = setup.pipeline as unknown as PluginPipelineQueueInternals;
      const enqueueActionValue = vi.spyOn(internals, "enqueueActionValue");
      const removeOriginal = setup.pipeline.uninstall(
        "original-id",
        "shared-dir",
        originalPreflight.confirmationToken,
      );
      const removeRuntime = setup.pipeline.uninstall(
        "runtime-id",
        "shared-dir",
        runtimePreflight.confirmationToken,
      );

      // Each call must synchronously park its secondary claim and its primary
      // action. If either call yields between them, these crossed claims can
      // both run ahead of the actions whose decisions they await.
      expect(enqueueActionValue.mock.calls.map(([pluginId]) => pluginId)).toEqual([
        "runtime-id",
        "original-id",
        "original-id",
        "runtime-id",
      ]);

      const [removedOriginal, removedRuntime] = await settleWithin(
        Promise.all([removeOriginal, removeRuntime]),
        "Crossed alias uninstalls did not settle",
      );
      expect(removedOriginal.ok).toBe(true);
      expect(removedRuntime).toMatchObject({
        ok: false,
        error: { code: "confirmation-required" },
      });
      await expect(lstat(setup.fixture.pluginRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await settleWithin(
        setup.pipeline.dispose(),
        "Pipeline disposal did not settle after crossed alias uninstalls",
      );
    }
  }, 60_000);

  it("awaits exact post-stop cleanup for a primary-and-live-alias uninstall", async () => {
    const cleanupAssimilated = deferred();
    const releaseCleanup = deferred();
    const observations: Array<{
      pluginId: string;
      record: ReturnType<PluginHost["currentRecord"]>;
    }> = [];
    const assimilatedPluginIds: string[] = [];
    let setup!: Awaited<ReturnType<typeof createAliasUninstallFixture>>;
    setup = await createAliasUninstallFixture({
      drainTimeoutMs: 0,
      onRuntimeStopped: (pluginId) => {
        observations.push({
          pluginId,
          record: setup.host.currentRecord(pluginId),
        });
        const thenable: PromiseLike<void> = {
          then: (onFulfilled, onRejected) => {
            assimilatedPluginIds.push(pluginId);
            if (assimilatedPluginIds.length === 2) {
              cleanupAssimilated.resolve();
            }
            return releaseCleanup.promise.then(onFulfilled, onRejected);
          },
        };
        return thenable as Promise<void>;
      },
    });
    let surface: Awaited<ReturnType<typeof ensureFromSurface>> | undefined;
    let removing: Promise<PluginActionResult> | undefined;
    let lateAliasJob: Promise<void> | undefined;
    try {
      surface = await ensureFromSurface(setup.pipeline, "runtime-id");
      expect(surface.result.ok).toBe(true);
      expect(setup.host.currentRecord("runtime-id")).toBeDefined();
      const preflight = await setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!preflight.ok) throw new Error(preflight.error.message);

      removing = setup.pipeline.uninstall(
        "original-id",
        "shared-dir",
        preflight.confirmationToken,
      );
      const internals = setup.pipeline as unknown as PluginPipelineQueueInternals;
      let lateAliasJobEntered = false;
      lateAliasJob = internals.enqueueActionValue("runtime-id", async () => {
        lateAliasJobEntered = true;
      });

      const boundary = await Promise.race([
        cleanupAssimilated.promise.then(() => "cleanup-assimilated" as const),
        removing.then(() => "uninstall-settled" as const),
      ]);
      expect(boundary).toBe("cleanup-assimilated");
      expect(observations.map(({ pluginId }) => pluginId).toSorted()).toEqual([
        "original-id",
        "runtime-id",
      ]);
      expect(assimilatedPluginIds.toSorted()).toEqual([
        "original-id",
        "runtime-id",
      ]);
      expect(observations.every(({ record }) => record === undefined)).toBe(true);
      expect(lateAliasJobEntered).toBe(false);

      releaseCleanup.resolve();
      const removed = await removing;
      await lateAliasJob;
      expect(removed.ok).toBe(true);
      expect(lateAliasJobEntered).toBe(true);
      await expect(lstat(setup.fixture.pluginRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      releaseCleanup.resolve();
      await removing?.catch(() => undefined);
      await lateAliasJob?.catch(() => undefined);
      await surface?.release();
      await setup.pipeline.dispose();
    }
  }, 60_000);

  it("preserves a live alias and releases its queue when pre-stop revocation fails", async () => {
    const stoppedRuntimeIds: string[] = [];
    const setup = await createAliasUninstallFixture({
      drainTimeoutMs: 0,
      onRuntimeStopped: (pluginId) => {
        stoppedRuntimeIds.push(pluginId);
      },
    });
    let surface: Awaited<ReturnType<typeof ensureFromSurface>> | undefined;
    let removing: Promise<PluginActionResult> | undefined;
    let lateAliasJob: Promise<void> | undefined;
    try {
      surface = await ensureFromSurface(setup.pipeline, "runtime-id");
      expect(surface.result.ok).toBe(true);
      const aliasRecord = setup.host.currentRecord("runtime-id");
      expect(aliasRecord).toBeDefined();
      const preflight = await setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!preflight.ok) throw new Error(preflight.error.message);

      const revokedRuntimeIds: string[] = [];
      removing = setup.pipeline.uninstall(
        "original-id",
        "shared-dir",
        preflight.confirmationToken,
        {
          onWillStopRuntime: (pluginId) => {
            revokedRuntimeIds.push(pluginId);
            if (pluginId === "runtime-id") {
              throw new Error("simulated alias revocation failure");
            }
          },
        },
      );
      const internals = setup.pipeline as unknown as PluginPipelineQueueInternals;
      let lateAliasJobEntered = false;
      lateAliasJob = internals.enqueueActionValue("runtime-id", async () => {
        lateAliasJobEntered = true;
      });
      expect(lateAliasJobEntered).toBe(false);

      const removed = await removing;
      await lateAliasJob;
      expect(removed).toMatchObject({
        ok: false,
        error: {
          code: "delete-failed",
          message: "simulated alias revocation failure",
        },
      });
      expect(revokedRuntimeIds).toContain("runtime-id");
      expect(stoppedRuntimeIds).not.toContain("runtime-id");
      expect(setup.host.currentRecord("runtime-id")).toBe(aliasRecord);
      await expect(lstat(setup.fixture.pluginRoot)).resolves.toBeDefined();
      expect(lateAliasJobEntered).toBe(true);
    } finally {
      await removing?.catch(() => undefined);
      await lateAliasJob?.catch(() => undefined);
      await surface?.release();
      await setup.pipeline.dispose();
    }
  }, 60_000);

  it("cancels alias claims when a newer confirmation replaces the admitted one", async () => {
    const setup = await createAliasUninstallFixture();
    const primaryQueueEntered = deferred();
    const releasePrimaryQueue = deferred();
    let surface: Awaited<ReturnType<typeof ensureFromSurface>> | undefined;
    let primaryBlocker: Promise<void> | undefined;
    let replacementPreflight: ReturnType<PluginPipeline["uninstallPreflight"]> | undefined;
    let removing: Promise<PluginActionResult> | undefined;
    let lateAliasJob: Promise<void> | undefined;
    try {
      const firstPreflight = await setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!firstPreflight.ok) throw new Error(firstPreflight.error.message);

      surface = await ensureFromSurface(setup.pipeline, "runtime-id");
      expect(surface.result.ok).toBe(true);
      const aliasRecord = setup.host.currentRecord("runtime-id");
      expect(aliasRecord).toBeDefined();
      const stop = vi.spyOn(setup.host, "stop");
      const internals = setup.pipeline as unknown as PluginPipelineQueueInternals;
      primaryBlocker = internals.enqueueActionValue("original-id", async () => {
        primaryQueueEntered.resolve();
        await releasePrimaryQueue.promise;
      });
      await primaryQueueEntered.promise;

      // Admission still sees the first token and claims runtime-id. The
      // queued preflight replaces it before the primary uninstall executes.
      replacementPreflight = setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      const reserveChange = vi.spyOn(setup.hostOwnership, "reserveChange");
      removing = setup.pipeline.uninstall(
        "original-id",
        "shared-dir",
        firstPreflight.confirmationToken,
      );
      expect(reserveChange.mock.calls.map(([pluginId]) => pluginId)).toEqual([
        "original-id",
        "runtime-id",
      ]);

      let lateAliasJobEntered = false;
      lateAliasJob = internals.enqueueActionValue("runtime-id", async () => {
        lateAliasJobEntered = true;
      });
      expect(lateAliasJobEntered).toBe(false);

      releasePrimaryQueue.resolve();
      const newer = await replacementPreflight;
      if (!newer.ok) throw new Error(newer.error.message);
      const removed = await removing;
      await lateAliasJob;

      expect(removed).toMatchObject({
        ok: false,
        error: { code: "confirmation-required" },
      });
      expect(lateAliasJobEntered).toBe(true);
      expect(setup.host.currentRecord("runtime-id")).toBe(aliasRecord);
      expect(stop.mock.calls.some(([pluginId]) => pluginId === "runtime-id"))
        .toBe(false);
      await expect(
        setup.hostOwnership.runCommand("runtime-id", async () => "ready"),
      ).resolves.toEqual({ kind: "completed", value: "ready" });
    } finally {
      releasePrimaryQueue.resolve();
      await primaryBlocker?.catch(() => undefined);
      await replacementPreflight?.catch(() => undefined);
      await removing?.catch(() => undefined);
      await lateAliasJob?.catch(() => undefined);
      await surface?.release();
      await setup.pipeline.dispose();
    }
  }, 60_000);

  it("holds alias queues until every uninstall stop attempt settles", async () => {
    const setup = await createAliasUninstallFixture({ drainTimeoutMs: 0 });
    const aliasStopEntered = deferred();
    const primaryStopEntered = deferred();
    const releasePrimaryStop = deferred();
    let surface: Awaited<ReturnType<typeof ensureFromSurface>> | undefined;
    let removing: Promise<PluginActionResult> | undefined;
    let lateAliasJob: Promise<void> | undefined;
    try {
      surface = await ensureFromSurface(setup.pipeline, "runtime-id");
      expect(surface.result.ok).toBe(true);
      const aliasRecord = setup.host.currentRecord("runtime-id");
      expect(aliasRecord).toBeDefined();
      const preflight = await setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!preflight.ok) throw new Error(preflight.error.message);

      const internals = setup.pipeline as unknown as PluginPipelineQueueInternals;
      const claimCleanupQueues =
        internals.claimUninstallCleanupQueues.bind(internals);
      let primaryStopFinished = false;
      let claimReleasedBeforePrimaryStop = false;
      let claimReleaseCalls = 0;
      let lateAliasJobEntered = false;
      let lateAliasJobEnteredBeforeRelease = false;
      vi.spyOn(internals, "claimUninstallCleanupQueues").mockImplementation(
        (cleanupIds, primaryPluginId, reservations, hooks) =>
          claimCleanupQueues(cleanupIds, primaryPluginId, reservations, hooks).map((claim) => ({
            ...claim,
            release: () => {
              claimReleaseCalls += 1;
              if (!primaryStopFinished) claimReleasedBeforePrimaryStop = true;
              if (lateAliasJobEntered) lateAliasJobEnteredBeforeRelease = true;
              claim.release();
            },
          })),
      );

      const actualStop = setup.host.stop.bind(setup.host);
      let failedAliasStop = false;
      vi.spyOn(setup.host, "stop").mockImplementation(async (pluginId) => {
        if (pluginId === "runtime-id" && !failedAliasStop) {
          failedAliasStop = true;
          aliasStopEntered.resolve();
          throw new Error("simulated alias stop failure");
        }
        if (pluginId === "original-id") {
          primaryStopEntered.resolve();
          await releasePrimaryStop.promise;
          await actualStop(pluginId);
          primaryStopFinished = true;
          return;
        }
        await actualStop(pluginId);
      });

      removing = setup.pipeline.uninstall(
        "original-id",
        "shared-dir",
        preflight.confirmationToken,
      );
      lateAliasJob = internals.enqueueActionValue("runtime-id", async () => {
        lateAliasJobEntered = true;
      });

      await Promise.all([aliasStopEntered.promise, primaryStopEntered.promise]);
      releasePrimaryStop.resolve();
      const removed = await removing;
      await lateAliasJob;

      expect(removed).toMatchObject({
        ok: false,
        error: { code: "delete-failed" },
      });
      expect(primaryStopFinished).toBe(true);
      expect(claimReleasedBeforePrimaryStop).toBe(false);
      expect(lateAliasJobEnteredBeforeRelease).toBe(false);
      expect(claimReleaseCalls).toBe(1);
      expect(lateAliasJobEntered).toBe(true);
      expect(setup.host.currentRecord("runtime-id")).toBe(aliasRecord);
      await expect(lstat(setup.fixture.pluginRoot)).resolves.toBeDefined();
    } finally {
      releasePrimaryStop.resolve();
      await removing?.catch(() => undefined);
      await lateAliasJob?.catch(() => undefined);
      await surface?.release();
      await setup.pipeline.dispose();
    }
  }, 60_000);

  // Conflict detection has to be side-agnostic: !plugin.valid alone only
  // catches this request's copy losing the tie-break. When the copy sorts
  // first and wins instead, its own record stays valid and reads as a
  // clean add — but the plugin it collided with is now the one carrying
  // discovery's "duplicate plugin id" diagnostic. Either side degrading
  // must roll the add back the same way.

  it("detects a conflict and rolls back even when its own copy wins the tie-break", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-conflict-win-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const builtinPluginsRoot = join(targetRoot, "builtin-plugins");
    const builtinChatRoot = join(builtinPluginsRoot, "agent-chat");
    await mkdir(join(builtinChatRoot, "src"), { recursive: true });
    await writeFile(
      join(builtinChatRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "agent-chat", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(builtinChatRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.list()).toEqual([]);

      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);
      const existingPluginIds = new Set(pipeline.list().map((entry) => entry.id));

      const added = await addOfferedPlugin({
        builtinPluginsRoot,
        workspaceRoot,
        directoryName: "agent-chat",
        existingPluginIds,
      });

      // Injected between the copy and the post-copy rescan — sorts after
      // "agent-chat" lexically this time, so discovery's tie-break hands the id
      // to the copy this request just made instead.
      const concurrentRoot = join(workspaceRoot, "plugins", "z-chat");
      await mkdir(join(concurrentRoot, "src"), { recursive: true });
      await writeFile(
        join(concurrentRoot, "dohc-plugin.json"),
        `${JSON.stringify({ version: 1, name: "agent-chat", entry: "src/main.ts" }, null, 2)}\n`,
      );
      await writeFile(join(concurrentRoot, "src", "main.ts"), "export default {};\n");

      await pipeline.handleWatcherEvents([{ operation: "create", path: "plugins/agent-chat" }]);
      const copied = pipeline.list().find((entry) => entry.directoryName === "agent-chat");
      // This request's own copy won — its record alone would read as a
      // clean, successful add.
      expect(copied?.valid).toBe(true);

      // Find the displaced directory through supersededPluginId. Diagnostic
      // prose is bounded and can change for display, so it cannot identify the
      // other side of the collision.
      const displaced = pipeline.findDirectorySupersededBy("agent-chat");
      expect(displaced).toBe("z-chat");

      // The handler's cleanup fires on that signal alone, even though
      // copied.valid was true.
      await removeAddedOfferedPlugin({
        workspaceRoot,
        directoryName: "agent-chat",
        identity: added.identity,
        contentHash: added.contentHash,
      });
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);

      await expect(
        lstat(join(workspaceRoot, "plugins", "agent-chat")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // The departed identity's cleanup and the surviving replacement's own
      // reconciliation are both queued work, not synchronous with the
      // rescan settling — the same asynchronous reseed every other real-
      // lifecycle test in this file waits out.
      await waitFor(
        () => pipeline.list().some((entry) => entry.directoryName === "z-chat"),
        "z-chat did not recover the id after the conflicting copy was removed.",
      );
      const survivor = pipeline.list().find((entry) => entry.directoryName === "z-chat");
      expect(survivor).toMatchObject({ id: "agent-chat", valid: true });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // A user or agent can edit the copy while a slow rescan detects its
  // conflict. Editing a file leaves the directory's inode unchanged, so
  // rollback must check content as well as directory identity.

  it("preserves a post-publish edit instead of deleting it, when a conflict rolls the add back", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-conflict-edit-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const builtinPluginsRoot = join(targetRoot, "builtin-plugins");
    const builtinChatRoot = join(builtinPluginsRoot, "agent-chat");
    await mkdir(join(builtinChatRoot, "src"), { recursive: true });
    await writeFile(
      join(builtinChatRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "agent-chat", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(builtinChatRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);
      const existingPluginIds = new Set(pipeline.list().map((entry) => entry.id));

      const added = await addOfferedPlugin({
        builtinPluginsRoot,
        workspaceRoot,
        directoryName: "agent-chat",
        existingPluginIds,
      });

      // The conflict this rollback is about to act on.
      const concurrentRoot = join(workspaceRoot, "plugins", "z-chat");
      await mkdir(join(concurrentRoot, "src"), { recursive: true });
      await writeFile(
        join(concurrentRoot, "dohc-plugin.json"),
        `${JSON.stringify({ version: 1, name: "agent-chat", entry: "src/main.ts" }, null, 2)}\n`,
      );
      await writeFile(join(concurrentRoot, "src", "main.ts"), "export default {};\n");

      // Real work landing in the copy's own directory before the conflict
      // is even detected — its identity is untouched by this.
      const target = join(workspaceRoot, "plugins", "agent-chat");
      await writeFile(join(target, "NOTES.md"), "left before the conflict was seen");

      await pipeline.handleWatcherEvents([{ operation: "create", path: "plugins/agent-chat" }]);
      expect(pipeline.findDirectorySupersededBy("agent-chat")).toBe("z-chat");

      await expect(
        removeAddedOfferedPlugin({
          workspaceRoot,
          directoryName: "agent-chat",
          identity: added.identity,
          contentHash: added.contentHash,
        }),
      ).rejects.toBeInstanceOf(OfferedPluginAddError);

      // Nothing deleted: the edit survives, restored right back where it
      // was made rather than lost to the rollback.
      await expect(
        readFile(join(target, "NOTES.md"), "utf8"),
      ).resolves.toBe("left before the conflict was seen");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // handleWatcherEvents logs and swallows a rescan failure rather than
  // throwing (a transient fs error, say), so the copy this request just
  // made can be on disk with nothing in pipeline.list() to show for it.
  // The fixed handler's cleanup must remove it before reporting the
  // refusal — otherwise a retry finds "already exists" for a plugin the
  // user was just told never appeared.

  it("removes its copy instead of stranding it when the post-copy rescan finds nothing", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-no-rescan-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const builtinPluginsRoot = join(targetRoot, "builtin-plugins");
    const builtinChatRoot = join(builtinPluginsRoot, "agent-chat");
    await mkdir(join(builtinChatRoot, "src"), { recursive: true });
    await writeFile(
      join(builtinChatRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "agent-chat", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(builtinChatRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);
      const existingPluginIds = new Set(pipeline.list().map((entry) => entry.id));

      const added = await addOfferedPlugin({
        builtinPluginsRoot,
        workspaceRoot,
        directoryName: "agent-chat",
        existingPluginIds,
      });

      // Simulates the rescan finding nothing: skip it entirely, so
      // discovery never picks up the new directory the copy just wrote.
      const plugin = pipeline.list().find((entry) => entry.directoryName === "agent-chat");
      expect(plugin).toBeUndefined();

      // The fixed handler's cleanup for exactly this case.
      await removeAddedOfferedPlugin({
        workspaceRoot,
        directoryName: "agent-chat",
        identity: added.identity,
        contentHash: added.contentHash,
      });
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);

      await expect(
        lstat(join(workspaceRoot, "plugins", "agent-chat")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // The offer's own existence check would pass again — a retry is
      // genuinely possible, not stuck behind a stranded copy.
      expect(pipeline.list()).toEqual([]);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // An offline rename is first joined to its persisted record by plugin id.
  // The record's directoryName and saved settings must follow the new source
  // directory, or pluginIdTracesDirectory will disown this plugin's data and
  // settings will remain under a key the plugin no longer reads.
  it("owns its data and carries its settings across an offline directory rename", async () => {
    const fixture = await createPluginWorkspace({
      directoryName: "old-dir",
      pluginId: "offline-rename-id",
      displayName: "offline-rename-id",
    });
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "offline-rename-id",
        displayName: "offline-rename-id",
        entry: "src/index.ts",
        settings: [
          { key: "greeting", type: "string", label: "Greeting", default: "Hello" },
        ],
      }, null, 2)}\n`,
    );
    let pipeline: PluginPipeline;
    const newHost = () =>
      new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
    const newPipeline = (host: PluginHost) =>
      new PluginPipeline({
        isEngineCaptureAvailable: () => true,
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        hostOwnership: new PluginHostOwnership(host),
        resourcesBasePath,
        pnpmRunnerEntry,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const installed = await pipeline.install("offline-rename-id");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const saved = await pipeline.setPluginSettings("old-dir", "offline-rename-id", {
        greeting: "Howdy",
      });
      expect(saved).toEqual({ greeting: "Howdy" });
    } finally {
      await pipeline.dispose();
    }

    // The plugin's own stored data, genuinely filed under its id.
    const ownStateRoot = pluginStateRoot(
      pluginDataDir(fixture.stateDir, fixture.workspaceRoot),
      "offline-rename-id",
    );
    await mkdir(join(ownStateRoot, "t3"), { recursive: true });
    await writeFile(join(ownStateRoot, "t3", "session.sqlite"), "session-bytes");

    // The directory moves while dohc is closed — no watcher, no batch,
    // nothing but a fresh start() to notice it next.
    const renamedRoot = join(fixture.workspaceRoot, "plugins", "new-dir");
    await rename(fixture.pluginRoot, renamedRoot);

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const row = pipeline.list()[0];
      expect(row).toMatchObject({
        id: "offline-rename-id",
        directoryName: "new-dir",
        rootPath: renamedRoot,
        valid: true,
      });
      expect(row?.approvedHash).not.toBeNull();

      // The record follows the plugin: its own persisted directoryName is
      // corrected, not left pointing at the vacated directory.
      const state = await readPluginLocalState(fixture.stateDir, fixture.workspaceRoot);
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["offline-rename-id"]).toMatchObject({
        directoryName: "new-dir",
      });

      // Settings carried through the same boundary as an online rename.
      expect(await pipeline.getPluginSettings("new-dir")).toEqual({
        greeting: "Howdy",
      });

      // Remove preflight/cleanup own this plugin's own stored data — the
      // stale directoryName no longer reads it as belonging to someone
      // else.
      const preflight = await pipeline.uninstallPreflight("offline-rename-id", "new-dir");
      if (!preflight.ok) throw new Error(preflight.error.message);
      expect(preflight.preflight.stateData).toMatchObject({
        path: ownStateRoot,
        fileCount: 1,
      });
      const uninstalled = await pipeline.uninstall(
        "offline-rename-id",
        "new-dir",
        preflight.confirmationToken,
      );
      expect(uninstalled.ok).toBe(true);
      if (!uninstalled.ok) throw new Error(uninstalled.error.message);
      expect(uninstalled.identity).toBe("released");
      await expect(lstat(renamedRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(ownStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  // Startup has no discovery history the way
  // processWatcherBatch does, so an id-only mismatch alone cannot tell a
  // genuine offline rename apart from a coexisting duplicate directory
  // promoted into the vacated id because the original directory is simply
  // gone. Gated on content: a rename preserves bytes exactly, so only an
  // equal live source hash may retarget the record and migrate settings.

  it("does not adopt a duplicate promoted while closed as an offline rename", async () => {
    const fixture = await createPluginWorkspace({
      directoryName: "old-dir",
      pluginId: "foo",
      displayName: "foo",
    });
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "foo",
        displayName: "foo",
        entry: "src/index.ts",
        settings: [
          { key: "greeting", type: "string", label: "Greeting", default: "Hello" },
        ],
      }, null, 2)}\n`,
    );

    let pipeline: PluginPipeline;
    const newHost = () =>
      new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
    const newPipeline = (host: PluginHost) =>
      new PluginPipeline({
        isEngineCaptureAvailable: () => true,
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        hostOwnership: new PluginHostOwnership(host),
        resourcesBasePath,
        pnpmRunnerEntry,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const installed = await pipeline.install("foo");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().some((p) => p.directoryName === "old-dir" && p.status === "ready"),
        "The winner did not reach ready.",
      );
      const saved = await pipeline.setPluginSettings("old-dir", "foo", {
        greeting: "Howdy",
      });
      expect(saved).toEqual({ greeting: "Howdy" });
    } finally {
      await pipeline.dispose();
    }

    // A second, coexisting directory declaring the same manifest name
    // appears while "old-dir" is still the installed winner — demoted by
    // discovery's tie-break to its own directoryName as id, and different
    // content: a real rename could never produce this, only an unrelated
    // plugin that happens to share the name.
    const duplicateRoot = join(fixture.workspaceRoot, "plugins", "dup-dir");
    await mkdir(join(duplicateRoot, "src"), { recursive: true });
    await writeFile(
      join(duplicateRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "foo",
        displayName: "foo",
        entry: "src/index.ts",
        settings: [
          { key: "greeting", type: "string", label: "Greeting", default: "Hello" },
        ],
      }, null, 2)}\n`,
    );
    await writeFile(
      join(duplicateRoot, "src", "index.ts"),
      'export default { activate() { /* different bytes */ } };\n',
    );

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      // The tie-break still favours the known-installed directory.
      expect(pipeline.list().find((p) => p.directoryName === "old-dir"))
        .toMatchObject({ id: "foo", valid: true });
      expect(pipeline.list().find((p) => p.directoryName === "dup-dir"))
        .toMatchObject({ id: "dup-dir", valid: false });
    } finally {
      await pipeline.dispose();
    }

    // "old-dir" is deleted while dohc is closed — no watcher, no batch, no
    // discovery history. "dup-dir" is now the only directory declaring
    // "foo" and gets promoted to it on the next start().
    await rm(fixture.pluginRoot, { recursive: true, force: true });

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const row = pipeline.list().find((p) => p.directoryName === "dup-dir");
      expect(row).toMatchObject({ id: "foo", valid: true });

      // The record was not retargeted: it still names the original,
      // missing directory, not the duplicate's.
      const state = await readPluginLocalState(fixture.stateDir, fixture.workspaceRoot);
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["foo"]).toMatchObject({
        directoryName: "old-dir",
      });

      // The promoted duplicate reads its own manifest's default — never
      // the departed winner's saved answer, which named a plugin whose
      // bytes never actually moved here.
      expect(await pipeline.getPluginSettings("dup-dir")).toEqual({
        greeting: "Hello",
      });
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  // Settings are keyed by directoryName. A genuine
  // rename — this exact id reappearing, in one watcher batch, at a new
  // directory — is the one case the pipeline itself can prove; without
  // this, the user's saved answers are filed under a key nothing reads
  // anymore and silently read back as the manifest's defaults.

  it("carries a plugin's saved settings across a same-batch directory rename", async () => {
    const fixture = await createPluginWorkspace({
      directoryName: "old-dir",
      pluginId: "shared-id",
      displayName: "shared-id",
    });
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "shared-id",
        displayName: "shared-id",
        entry: "src/index.ts",
        settings: [
          { key: "greeting", type: "string", label: "Greeting", default: "Hello" },
        ],
      }, null, 2)}\n`,
    );

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("shared-id");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      const saved = await pipeline.setPluginSettings("old-dir", "shared-id", {
        greeting: "Howdy",
      });
      expect(saved).toEqual({ greeting: "Howdy" });

      const renamedRoot = join(fixture.workspaceRoot, "plugins", "new-dir");
      await rename(fixture.pluginRoot, renamedRoot);
      // Both sides of the rename land in one batch, matching how a real
      // rename reaches processWatcherBatch when the watcher coalesces it.
      pipeline.handleWatcherEvents([
        { path: "plugins/old-dir", operation: "delete" },
        { path: "plugins/new-dir", operation: "create" },
      ]);

      await waitFor(
        () => pipeline.list().some(
          (p) => p.id === "shared-id" && p.directoryName === "new-dir",
        ),
        "The renamed identity was never rediscovered at its new directory.",
      );

      // The answer moved with the rename, not reset to the manifest's
      // default — and it moved, rather than merely being copied: nothing
      // is left behind under the vacated key.
      expect(await pipeline.getPluginSettings("new-dir")).toEqual({
        greeting: "Howdy",
      });
      const stored = await readPluginSettingsFile(fixture.workspaceRoot);
      expect(stored["old-dir"]).toBeUndefined();
      expect(stored["new-dir"]).toEqual({ greeting: "Howdy" });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // sameId reappearing under a new directoryName is
  // only ever a rename when that directory is new to discovery this batch.
  // A duplicate that already existed — a second directory declaring the
  // same manifest name, demoted to its own directoryName as id by
  // discovery's tie-break — getting promoted into the id its winner just
  // vacated is a completely different plugin taking over an id, never the
  // winner's own content arriving there. Settings must not follow.

  it("does not carry settings to a duplicate promoted by the installed winner's removal", async () => {
    const fixture = await createPluginWorkspace({
      directoryName: "aaa-dir",
      pluginId: "foo",
      displayName: "foo",
    });
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "foo",
        displayName: "foo",
        entry: "src/index.ts",
        settings: [
          { key: "greeting", type: "string", label: "Greeting", default: "Hello" },
        ],
      }, null, 2)}\n`,
    );

    // A second directory declaring the same manifest name — lexically
    // after "aaa-dir", so discovery's tie-break demotes it: it starts
    // life as an already-known, invalid duplicate under its own
    // directoryName as id, never "foo" itself, while "aaa-dir" is running.
    const duplicateRoot = join(fixture.workspaceRoot, "plugins", "zzz-dir");
    await mkdir(join(duplicateRoot, "src"), { recursive: true });
    await writeFile(
      join(duplicateRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "foo",
        displayName: "foo",
        entry: "src/index.ts",
        settings: [
          { key: "greeting", type: "string", label: "Greeting", default: "Hello" },
        ],
      }, null, 2)}\n`,
    );
    await writeFile(join(duplicateRoot, "src", "index.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("foo");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().some((p) => p.directoryName === "aaa-dir" && p.status === "ready"),
        "The winner did not reach ready.",
      );
      // The collision itself, from the very start: both directories
      // declare "foo", and the duplicate is already known to discovery.
      expect(pipeline.list().find((p) => p.directoryName === "zzz-dir"))
        .toMatchObject({ id: "zzz-dir", valid: false });

      const saved = await pipeline.setPluginSettings("aaa-dir", "foo", {
        greeting: "Howdy",
      });
      expect(saved).toEqual({ greeting: "Howdy" });

      // The winner is deleted outright — freeing "foo" for the duplicate
      // discovery already knew about to be promoted into.
      await rm(fixture.pluginRoot, { recursive: true, force: true });
      pipeline.handleWatcherEvents([
        { path: "plugins/aaa-dir", operation: "delete" },
      ]);

      await waitFor(
        () => pipeline.list().some((p) => p.directoryName === "zzz-dir" && p.id === "foo"),
        "The duplicate was never promoted to the vacated id.",
      );

      // The promoted duplicate reads its own manifest's default — never
      // the departed winner's saved answer, which named a plugin that
      // never actually moved here.
      expect(await pipeline.getPluginSettings("zzz-dir")).toEqual({
        greeting: "Hello",
      });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // An invalid, never-installed candidate (a broken
  // manifest, or none at all) gets no status entry — seedCandidateStatus
  // returns early with nothing to set — so its own arrival or departure
  // fires no "changed"/"removed" event either. Anything reading discovery
  // (offers, the plugin list) is stale until this fires.

  it("emits discovery-changed when an invalid, never-installed candidate's directory appears or disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-plugin-discovery-changed-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const stateDir = join(root, "state");
    await mkdir(join(workspaceRoot, "plugins"), { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const events: PluginPipelineStatusEvent[] = [];
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      onStatusChange: (event) => events.push(event),
    });

    try {
      await pipeline.start();

      // A broken manifest lands at plugins/broken — invalid, never
      // installed, no status entry of its own.
      const brokenRoot = join(workspaceRoot, "plugins", "broken");
      await mkdir(join(brokenRoot, "src"), { recursive: true });
      await writeFile(join(brokenRoot, "dohc-plugin.json"), "{ not valid json\n");
      pipeline.handleWatcherEvents([{ path: "plugins/broken", operation: "create" }]);
      await waitFor(
        () => pipeline.list().some((p) => p.directoryName === "broken"),
        "The invalid candidate was never discovered.",
      );
      expect(events).toContainEqual({ kind: "discovery-changed" });

      events.length = 0;
      await rm(brokenRoot, { recursive: true, force: true });
      pipeline.handleWatcherEvents([{ path: "plugins/broken", operation: "delete" }]);
      await waitFor(
        () => !pipeline.list().some((p) => p.directoryName === "broken"),
        "The invalid candidate's departure was never discovered.",
      );
      expect(events).toContainEqual({ kind: "discovery-changed" });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Comparing only the invalid set's directoryNames
  // misses a malformed manifest replaced by a differently malformed one —
  // the directory NAME set never changes, but the row's own diagnostics
  // (what the Plugins view actually shows for it) did.

  it("emits discovery-changed when an invalid candidate's own diagnostics change, even though its directory does not", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-plugin-discovery-changed-diagnostics-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const stateDir = join(root, "state");
    await mkdir(join(workspaceRoot, "plugins"), { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const events: PluginPipelineStatusEvent[] = [];
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      onStatusChange: (event) => events.push(event),
    });

    try {
      await pipeline.start();

      const brokenRoot = join(workspaceRoot, "plugins", "broken");
      await mkdir(join(brokenRoot, "src"), { recursive: true });
      await writeFile(join(brokenRoot, "dohc-plugin.json"), "{ not valid json\n");
      pipeline.handleWatcherEvents([{ path: "plugins/broken", operation: "create" }]);
      await waitFor(
        () => pipeline.list().some((p) => p.directoryName === "broken"),
        "The invalid candidate was never discovered.",
      );
      const firstDiagnostics = pipeline.list()
        .find((p) => p.directoryName === "broken")?.diagnostics;
      expect(firstDiagnostics).toBeDefined();

      events.length = 0;
      // Still invalid, still at "broken" — a different malformed manifest:
      // syntactically valid JSON this time, but missing what the schema
      // requires, so the parser reports a different diagnostic.
      await writeFile(
        join(brokenRoot, "dohc-plugin.json"),
        `${JSON.stringify({ notAVersionField: true }, null, 2)}\n`,
      );
      pipeline.handleWatcherEvents([{ path: "plugins/broken", operation: "update" }]);
      await waitFor(() => {
        const current = pipeline.list().find((p) => p.directoryName === "broken");
        return current !== undefined &&
          JSON.stringify(current.diagnostics) !== JSON.stringify(firstDiagnostics);
      }, "The invalid candidate's diagnostics never changed.");

      expect(events).toContainEqual({ kind: "discovery-changed" });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // The sourceless retry (this same pattern, but for a
  // never-approved install whose manifest broke under a directory name
  // different from its record's key) used to resolve cleanup by pluginId
  // alone — the fallback id finishSourcelessUninstall's synthetic candidate
  // carries, never the original id a persisted record survives under. The
  // source delete from the first, partially-failed attempt already
  // succeeded; only the record-by-directory join can still find the
  // original id once discovery has nothing left to join by rootPath.
  it("clears the originally-keyed state on a sourceless retry after a partial delete", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-sourceless-retry-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const pluginRoot = join(workspaceRoot, "plugins", "my-chat-copy");
    await mkdir(join(pluginRoot, "src"), { recursive: true });
    await writeFile(
      join(pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "agent-chat", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(pluginRoot, "src", "main.ts"), "export default {};\n");

    await mutatePluginRecord(stateDir, workspaceRoot, "agent-chat", () => ({
      directoryName: "my-chat-copy",
    }));
    const dohcDir = pluginDataDir(stateDir, workspaceRoot);
    const strandedStateRoot = pluginStateRoot(dohcDir, "agent-chat");
    await mkdir(strandedStateRoot, { recursive: true });
    await writeFile(join(strandedStateRoot, "session.json"), "{}");

    await writeFile(join(pluginRoot, "dohc-plugin.json"), "{ this is not valid JSON\n");

    let pipeline: PluginPipeline;
    let failChatDataRemoval = false;
    const stoppedRuntimeIds: string[] = [];
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      onRuntimeStopped: (stoppedPluginId) => {
        stoppedRuntimeIds.push(stoppedPluginId);
      },
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        removePath: async (path, options) => {
          if (failChatDataRemoval && String(path).startsWith(strandedStateRoot)) {
            throw new Error("simulated data delete failure");
          }
          await rm(path, options);
        },
      },
    });

    try {
      await pipeline.start();
      const pluginId = pipeline.list()[0]!.id;
      expect(pluginId).toBe("my-chat-copy");

      failChatDataRemoval = true;
      const staleAliasPreflight = await pipeline.uninstallPreflight(
        "agent-chat",
        pluginId,
      );
      if (!staleAliasPreflight.ok) {
        throw new Error(staleAliasPreflight.error.message);
      }
      const firstPreflight = await pipeline.uninstallPreflight(pluginId, pluginId);
      if (!firstPreflight.ok) throw new Error(firstPreflight.error.message);
      const failed = await pipeline.uninstall(pluginId, pluginId, firstPreflight.confirmationToken);
      expect(failed.ok).toBe(false);

      // The source is gone; the originally-keyed state and record survive
      // this partial failure, exactly as the delete failure left them.
      await expect(lstat(pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(strandedStateRoot)).resolves.toBeDefined();
      const midState = await readPluginLocalState(stateDir, workspaceRoot);
      if (!midState.ok) throw new Error(midState.warning);
      expect(midState.state.plugins["agent-chat"]).toBeDefined();

      // The watcher observes the deleted root: discovery has no candidate
      // left, and only the status row (and the record-by-directory join)
      // still name this installation.
      pipeline.handleWatcherEvents([{ path: "plugins/my-chat-copy", operation: "delete" }]);
      await waitFor(
        () => pipeline.list().length === 1,
        "The watcher sweep never reconciled the deleted root.",
      );

      // The retry is the same action from the same row, and it finishes —
      // clearing the original "agent-chat" key's state and record too, not only
      // pluginId's own (which never had anything under it to begin with).
      failChatDataRemoval = false;
      const retryPreflight = await pipeline.uninstallPreflight(pluginId, pluginId);
      if (!retryPreflight.ok) throw new Error(retryPreflight.error.message);
      // This retry's own preflight — the sourceless
      // path, with no discovery candidate left at all — must still name
      // the original "agent-chat" key's data before the user confirms deleting
      // it, not only report on pluginId's own (empty) state.
      expect(retryPreflight.preflight.stateData).toMatchObject({ fileCount: 1 });
      expect(retryPreflight.preflight.stateData?.path).toContain(strandedStateRoot);
      const transient = transientStateOf(pipeline);
      const trackedStatus = pipeline.list()[0];
      expect(trackedStatus).toBeDefined();
      transient.statuses.set("agent-chat", trackedStatus!);
      transient.lastApprovedAttemptHash.set(pluginId, "a".repeat(64));
      transient.lastApprovedAttemptHash.set("agent-chat", "b".repeat(64));
      stoppedRuntimeIds.length = 0;
      const finished = await pipeline.uninstall(
        pluginId,
        pluginId,
        retryPreflight.confirmationToken,
      );
      expect(finished.ok).toBe(true);
      if (!finished.ok) throw new Error(finished.error.message);
      expect(finished.identity).toBe("released");
      expect(stoppedRuntimeIds.toSorted()).toEqual(["agent-chat", "my-chat-copy"]);

      await expect(lstat(strandedStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const finalState = await readPluginLocalState(stateDir, workspaceRoot);
      if (!finalState.ok) throw new Error(finalState.warning);
      expect(finalState.state.plugins["agent-chat"]).toBeUndefined();
      expect(finalState.state.plugins["my-chat-copy"]).toBeUndefined();
      expect(transient.statuses.has(pluginId)).toBe(false);
      expect(transient.statuses.has("agent-chat")).toBe(false);
      expect(transient.lastApprovedAttemptHash.has(pluginId)).toBe(false);
      expect(transient.lastApprovedAttemptHash.has("agent-chat")).toBe(false);
      expect(pipeline.list()).toEqual([]);
      const staleAliasRemoval = await pipeline.uninstall(
        "agent-chat",
        pluginId,
        staleAliasPreflight.confirmationToken,
      );
      expect(staleAliasRemoval).toMatchObject({
        ok: false,
        error: { code: "confirmation-required" },
      });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Settings used to route by id alone, and two
  // directories can share an id (a duplicate manifest name — discovery's
  // own tie-break degrades one side, but both still carry the same id).
  // Reading and saving must name the exact directory a caller selected,
  // never whichever row that id happens to resolve to first.
  it("keeps two id-colliding directories' settings apart", async () => {
    const fixture = await createPluginWorkspace();
    const settingsManifest = {
      version: 1,
      name: "example-plugin",
      entry: "src/index.ts",
      settings: [
        {
          key: "greeting",
          type: "string",
          label: "Greeting",
          default: "Hello",
        },
      ],
    };
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify(settingsManifest, null, 2)}\n`,
    );

    // A second directory declaring the same manifest name — a genuine id
    // collision, not a broken-manifest fallback.
    const otherRoot = join(fixture.workspaceRoot, "plugins", "z-example-plugin");
    await mkdir(join(otherRoot, "src"), { recursive: true });
    await writeFile(
      join(otherRoot, "dohc-plugin.json"),
      `${JSON.stringify(settingsManifest, null, 2)}\n`,
    );
    await writeFile(join(otherRoot, "src", "index.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();

      const saved = await pipeline.setPluginSettings("example-plugin", "example-plugin", {
        greeting: "Hei",
      });
      expect(saved).toEqual({ greeting: "Hei" });

      // The exact directory just saved to reads back its own answer.
      expect(await pipeline.getPluginSettings("example-plugin")).toEqual({
        greeting: "Hei",
      });
      // The id-colliding other directory is untouched — still its own
      // manifest's default, never the answer just written under the
      // shared id.
      expect(await pipeline.getPluginSettings("z-example-plugin")).toEqual({
        greeting: "Hello",
      });
    } finally {
      await pipeline.dispose();
    }
  });

  it("keeps a built registration on its exact root when an invalid fallback id collides", async () => {
    const fixture = await createPluginWorkspace({
      directoryName: "zzz",
      pluginId: "aaa",
      displayName: "aaa",
    });
    const invalidRoot = join(fixture.workspaceRoot, "plugins", "aaa");
    await mkdir(invalidRoot, { recursive: true });
    await writeFile(
      join(invalidRoot, "dohc-plugin.json"),
      "{ this is not valid JSON\n",
    );

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.pluginRegistration("aaa")).toMatchObject({
        pluginRoot: fixture.pluginRoot,
        directoryName: "zzz",
        manifest: { name: "aaa" },
      });

      const installed = await pipeline.install("aaa");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }

      expect(pipeline.pluginRegistration("aaa")).toMatchObject({
        pluginRoot: fixture.pluginRoot,
        directoryName: "zzz",
        manifest: { name: "aaa" },
      });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // dohc's own build and state storage (liveRoot,
  // pluginStateRoot) is keyed by pluginId, not directoryName — an id an
  // invalid, never-installed collision loser shares with a genuinely
  // installed row's real id. Presence of an id alone must not report the
  // installed row's real bytes for the other directory that happens to
  // share it.

  it("reports no bytes for an id-colliding directory that never actually built or ran", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-sizes-collision-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const installedRoot = join(workspaceRoot, "plugins", "installed-dir");
    await mkdir(join(installedRoot, "src"), { recursive: true });
    await writeFile(
      join(installedRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "collide", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(
      join(installedRoot, "package.json"),
      `${JSON.stringify({
        name: "collide",
        version: "1.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.20.0",
      }, null, 2)}\n`,
    );
    await writeFile(join(installedRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n"));
    await writeFile(join(installedRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("collide");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().find((row) => row.directoryName === "installed-dir")?.status
          === "ready",
        "installed-dir did not reach ready.",
      );

      // The installed row's own bytes are real.
      const ownSizes = await pipeline.sizes("installed-dir", "collide");
      expect(ownSizes.installedBytes).not.toBeNull();

      // A second, unrelated directory declaring the same manifest name —
      // never installed, no build or state of its own.
      const otherRoot = join(workspaceRoot, "plugins", "other-dir");
      await mkdir(join(otherRoot, "src"), { recursive: true });
      await writeFile(
        join(otherRoot, "dohc-plugin.json"),
        `${JSON.stringify({ version: 1, name: "collide", entry: "src/main.ts" }, null, 2)}\n`,
      );
      await writeFile(join(otherRoot, "src", "main.ts"), "export default {};\n");
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);

      // Never the installed row's real bytes, reported under the other
      // directory's own name.
      expect(await pipeline.sizes("other-dir", "collide")).toEqual({
        installedBytes: null,
        dataBytes: null,
      });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Production starts a plugin from its built root, whose basename follows
  // the plugin id rather than the source directory. A real build and start
  // must carry the source directory "my-copy" through activation even though
  // the built root's basename is "foo".

  it("activates with the source directory's own name, never the built root's basename", async () => {
    const fixture = await createPluginWorkspace();
    await rm(fixture.pluginRoot, { recursive: true, force: true });
    const myCopyRoot = join(fixture.workspaceRoot, "plugins", "my-copy");
    await mkdir(join(myCopyRoot, "src"), { recursive: true });
    await writeFile(
      join(myCopyRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "foo", entry: "src/index.ts" }, null, 2)}\n`,
    );
    await writeFile(
      join(myCopyRoot, "package.json"),
      `${JSON.stringify({
        name: "foo",
        version: "1.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.20.0",
      }, null, 2)}\n`,
    );
    await writeFile(join(myCopyRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n"));
    await writeFile(
      join(myCopyRoot, "src", "index.ts"),
      'export default { activate() {} };\n',
    );

    const readPluginSettings = vi.fn(async () => ({}));
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      readPluginSettings,
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("foo");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().find((row) => row.id === "foo")?.status === "ready",
        "foo did not reach ready.",
      );

      // Asked for the SOURCE folder's settings — never "foo", the built
      // root's own basename.
      expect(readPluginSettings).toHaveBeenCalledWith("my-copy");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("identifies an NFC-spelled path under an NFD plugin root", async () => {
    const nfdDirectory = "caf\u0065\u0301";
    const nfcDirectory = "caf\u00e9";
    const fixture = await createPluginWorkspace({
      directoryName: nfdDirectory,
      pluginId: "unicode-plugin",
      displayName: "unicode-plugin",
    });
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      platform: "darwin",
      resourcesBasePath,
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();
      const callerPath = join(
        fixture.workspaceRoot,
        "plugins",
        nfcDirectory,
        "src",
        "index.ts",
      );
      expect(pipeline.pluginIdForPath(callerPath)).toBe("unicode-plugin");

    } finally {
      await pipeline.dispose();
    }
  });

  for (const scenario of [
    { name: "an empty directory", excludedOnly: false },
    { name: "a directory with only excluded content", excludedOnly: true },
  ]) {
    it.skipIf(process.platform !== "win32")(
      `auto-approves a case-drifted Windows door write under ${scenario.name}`,
      async () => {
        const fixture = await createPluginWorkspace();
        const existingDirectory = join(fixture.pluginRoot, "src", "NewDir");
        await mkdir(existingDirectory, { recursive: true });
        if (scenario.excludedOnly) {
          const excludedPath = join(existingDirectory, "node_modules", "x.js");
          await mkdir(dirname(excludedPath), { recursive: true });
          await writeFile(excludedPath, "excluded\n");
        }
        let pipeline: PluginPipeline;
        const host = new PluginHost({
          stateDir: fixture.stateDir,
          workspaceRoot: fixture.workspaceRoot,
          spawnTransport: fakeSpawnTransport(),
          routeSdkRequest: async () => ({}),
          onStatusChange: (pluginId, status) => {
            pipeline.noteRuntimeStatus(pluginId, status);
          },
        });
        pipeline = new PluginPipeline({
          isEngineCaptureAvailable: () => true,
          workspaceRoot: fixture.workspaceRoot,
          stateDir: fixture.stateDir,
          hostOwnership: new PluginHostOwnership(host),
          resourcesBasePath,
          pnpmRunnerEntry,
          operations: {
            install: (input) =>
              installPluginDependencies({
                ...input,
                forkProcess: nodeForkProcess,
              }),
          },
        });

        try {
          await pipeline.start();
          const installed = await pipeline.install("example-plugin");
          if (!installed.ok) throw new Error(installed.error.message);
          await waitFor(
            () => pipeline.list()[0]?.status === "ready",
            "Plugin did not reach ready after install.",
          );
          const originalHash = pipeline.list()[0]?.approvedHash;
          await authoredDoorWrite(
            pipeline,
            fixture.workspaceRoot,
            join("plugins", "example-plugin", "SRC", "newdir", "a.ts"),
            "export const added = true;\n",
          );

          await waitFor(
            () => {
              const plugin = pipeline.list()[0];
              return plugin?.status === "disabled-pending-approval" ||
                (plugin?.status === "ready" &&
                  plugin.approvedHash !== originalHash);
            },
            "Door write did not finish reconciliation.",
          );
          expect(pipeline.list()[0]).toMatchObject({
            status: "ready",
            disabledReason: null,
          });
          expect(pipeline.list()[0]?.approvedHash).not.toBe(originalHash);
        } finally {
          await pipeline.dispose();
        }
      },
      60_000,
    );
  }

  it("retries a provisional new-directory delta before hashing it", async () => {
    const fixture = await createPluginWorkspace();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    const canonicalDirectory = join(fixture.pluginRoot, "src", "NewDir");
    const canonicalPath = join(canonicalDirectory, "a.ts");
    const failedDirectory = resolve(join(fixture.pluginRoot, "src"));
    let transientFailures = 0;
    const readdirMock = vi.fn(async (...args: Parameters<typeof readdir>) => {
      if (
        resolve(String(args[0])) === failedDirectory &&
        transientFailures === 0
      ) {
        transientFailures += 1;
        throw new Error("simulated transient readdir failure");
      }
      return actualFs.readdir(...args);
    });
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => ({
      ...actualFs,
      readdir: readdirMock,
    }));

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      platform: "darwin",
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const originalHash = pipeline.list()[0]?.approvedHash;
      await mkdir(canonicalDirectory, { recursive: true });

      const { createPluginAuthoredTextWriter: createWriterWithTransientRead } =
        await import("./pluginAuthoredWrite");
      const write = createWriterWithTransientRead({
        platform: "darwin",
        signal: undefined,
        requireWritableCapture: async () => ({
          workspaceRoot: fixture.workspaceRoot,
          capture: {
            writeAuthoredTextFile: async (_absolutePath, text) => {
              await writeFile(canonicalPath, text);
              return { resolvedAbsolutePath: _absolutePath };
            },
          },
        }),
        pipeline: () => pipeline,
      });
      await write(
        join("plugins", "example-plugin", "SRC", "newdir", "a.ts"),
        "export const recovered = true;\n",
        {
          overwrite: true,
          author: {
            kind: "agent",
            agentId: "plugin:example-plugin",
            onBehalfOf: "local",
            agentRunId: "spawn-1",
          },
        },
      );

      await waitFor(
        () => {
          const plugin = pipeline.list()[0];
          return plugin?.status === "ready" &&
            plugin.approvedHash !== originalHash;
        },
        "The retried door write did not reach ready.",
        60_000,
      );
      expect(transientFailures).toBe(1);
      expect(pipeline.list()[0]?.disabledReason).toBeNull();
    } finally {
      await pipeline.dispose();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  }, 120_000);

  it("attributes an authored write before delayed case recovery lets a watcher reconcile it", async () => {
    const fixture = await createPluginWorkspace();
    const recoveryStarted = deferred();
    const releaseRecovery = deferred();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    let readCount = 0;
    const readdirMock = vi.fn(async (...args: Parameters<typeof readdir>) => {
      readCount += 1;
      if (readCount === 1) {
        recoveryStarted.resolve();
        await releaseRecovery.promise;
      }
      return actualFs.readdir(...args);
    });
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => ({
      ...actualFs,
      readdir: readdirMock,
    }));

    const observedStatuses: string[] = [];
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      platform: "darwin",
      resourcesBasePath,
      pnpmRunnerEntry,
      onStatusChange: (event) => {
        if (event.kind === "changed") observedStatuses.push(event.plugin.status);
      },
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.pluginIdForPath(
        join(fixture.workspaceRoot, "PLUGINS", "EXAMPLE-PLUGIN", "src", "index.ts"),
      )).toBe("example-plugin");
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const originalHash = pipeline.list()[0]?.approvedHash;
      observedStatuses.length = 0;

      const { createPluginAuthoredTextWriter: createWriterWithDelayedRecovery } =
        await import("./pluginAuthoredWrite");
      const write = createWriterWithDelayedRecovery({
        platform: "darwin",
        signal: undefined,
        requireWritableCapture: async () => ({
          workspaceRoot: fixture.workspaceRoot,
          capture: {
            writeAuthoredTextFile: async (_absolutePath, text) => {
              await writeFile(fixture.entryPath, text);
              return { resolvedAbsolutePath: _absolutePath };
            },
          },
        }),
        pipeline: () => pipeline,
      });
      const pendingWrite = write(
        join("plugins", "example-plugin", "SRC", "index.ts"),
        [
          'export const marker = "watcher-window";',
          "export default { activate() {} };",
          "",
        ].join("\n"),
        {
          overwrite: true,
          author: {
            kind: "agent",
            agentId: "plugin:example-plugin",
            onBehalfOf: "local",
            agentRunId: "spawn-1",
          },
        },
      );
      await recoveryStarted.promise;

      await pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);
      await waitFor(
        () =>
          pipeline.list()[0]?.status === "disabled-pending-approval" ||
          (pipeline.list()[0]?.status === "ready" &&
            pipeline.list()[0]?.approvedHash !== originalHash),
        "The watcher-window reconciliation did not settle.",
        60_000,
      );
      const statusesDuringRecovery = [...observedStatuses];
      releaseRecovery.resolve();
      await pendingWrite;
      await waitFor(
        () =>
          pipeline.list()[0]?.status === "ready" &&
          pipeline.list()[0]?.approvedHash !== originalHash,
        "The attributed write did not finish rebuilding.",
        60_000,
      );

      expect(statusesDuringRecovery).not.toContain("disabled-pending-approval");
    } finally {
      releaseRecovery.resolve();
      await pipeline.dispose();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  }, 120_000);

  it("keeps the second same-file write from two separate writers when the first recovery finishes last", async () => {
    const fixture = await createPluginWorkspace();
    const firstRecoveryStarted = deferred();
    const releaseFirstRecovery = deferred();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    let readCount = 0;
    const readdirMock = vi.fn(async (...args: Parameters<typeof readdir>) => {
      readCount += 1;
      if (readCount === 1) {
        firstRecoveryStarted.resolve();
        await releaseFirstRecovery.promise;
      }
      return actualFs.readdir(...args);
    });
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => ({
      ...actualFs,
      readdir: readdirMock,
    }));

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      platform: "darwin",
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      const { createPluginAuthoredTextWriter: createIndependentWriter } =
        await import("./pluginAuthoredWrite");
      const input = {
        platform: "darwin" as const,
        signal: undefined,
        requireWritableCapture: async () => ({
          workspaceRoot: fixture.workspaceRoot,
          capture: {
            writeAuthoredTextFile: async (_absolutePath: string, text: string) => {
              await writeFile(fixture.entryPath, text);
              return { resolvedAbsolutePath: _absolutePath };
            },
          },
        }),
        pipeline: () => pipeline,
      };
      const firstWriter = createIndependentWriter(input);
      const secondWriter = createIndependentWriter(input);
      const relativePath = join(
        "plugins",
        "example-plugin",
        "SRC",
        "index.ts",
      );
      const firstWrite = firstWriter(
        relativePath,
        [
          'export const marker = "writer-one";',
          "export default { activate() {} };",
          "",
        ].join("\n"),
        {
          overwrite: true,
          author: {
            kind: "agent",
            agentId: "plugin:example-plugin",
            onBehalfOf: "local",
            agentRunId: "spawn-1",
          },
        },
      );
      await firstRecoveryStarted.promise;
      await secondWriter(
        relativePath,
        [
          'export const marker = "writer-two";',
          "export default { activate() {} };",
          "",
        ].join("\n"),
        {
          overwrite: true,
          author: {
            kind: "agent",
            agentId: "plugin:example-plugin",
            onBehalfOf: "local",
            agentRunId: "spawn-2",
          },
        },
      );
      releaseFirstRecovery.resolve();
      await firstWrite;

      await vi.waitFor(
        async () => {
          expect(pipeline.list()[0]?.status).toBe("ready");
          expect(await readFile(
            liveBundlePath(fixture, "example-plugin"),
            "utf8",
          )).toContain("writer-two");
        },
        { timeout: 60_000, interval: 20 },
      );
      expect(pipeline.list()[0]?.disabledReason).toBeNull();
    } finally {
      releaseFirstRecovery.resolve();
      await pipeline.dispose();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  }, 120_000);

  it("installs, hot reloads with one coalesced follow-up, disables, enables, approves, and uninstalls", async () => {
    const fixture = await createPluginWorkspace();
    const installGate = deferred();
    let installCalls = 0;
    let pipeline: PluginPipeline;
    const spawnTransport = fakeSpawnTransport();
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport,
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: async (input) => {
          installCalls += 1;
          if (installCalls === 2) await installGate.promise;
          return installPluginDependencies({
            ...input,
            forkProcess: nodeForkProcess,
          });
        },
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.list()[0]?.status).toBe("discovered");
      // A5: a door-written write's absolute path must resolve to the plugin
      // that owns it, so main.ts can route it into
      // handleDoorWrittenSourceChange instead of only the watcher path.
      expect(pipeline.pluginIdForPath(fixture.entryPath)).toBe("example-plugin");
      expect(pipeline.pluginIdForPath(fixture.pluginRoot)).toBe("example-plugin");
      // A ".." that is not a whole segment is still inside the root: prefix
      // containment left a "..cache/" write unattributed, and the plugin
      // later held for its own door write.
      expect(pipeline.pluginIdForPath(join(fixture.pluginRoot, "..cache", "x.ts")))
        .toBe("example-plugin");
      expect(pipeline.pluginIdForPath(join(fixture.workspaceRoot, "notes.md")))
        .toBeNull();
      expect(pipeline.pluginIdForPath(
        join(fixture.workspaceRoot, "plugins", "example-plugin-sibling", "x.ts"),
      )).toBeNull();

      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const firstHash = pipeline.list()[0]?.approvedHash;
      expect(firstHash).toMatch(/^[0-9a-f]{64}$/);
      expect(await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      )).toContain("one");

      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "two";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await waitFor(() => installCalls === 2, "Hot reload did not reach install.");

      const thirdText = [
        'export const marker = "three";',
        "export default { activate() {} };",
        "",
      ].join("\n");
      await writeFile(fixture.entryPath, thirdText);
      const thirdWrite = { absolutePath: fixture.entryPath, text: thirdText };
      pipeline.handleDoorWrittenSourceChange("example-plugin", thirdWrite);
      pipeline.handleDoorWrittenSourceChange("example-plugin", thirdWrite);
      pipeline.handleDoorWrittenSourceChange("example-plugin", thirdWrite);
      installGate.resolve();

      await waitFor(
        () => installCalls === 3 && pipeline.list()[0]?.status === "ready",
        "The coalesced hot-reload follow-up did not finish.",
      );
      await settleWithin(
        (pipeline as unknown as {
          enqueueActionValue: (
            pluginId: string,
            run: () => Promise<void>,
          ) => Promise<void>;
        }).enqueueActionValue("example-plugin", async () => undefined),
        "Queued hot reloads did not finish.",
      );
      expect(installCalls).toBe(3);
      expect(pipeline.list()[0]?.approvedHash).not.toBe(firstHash);
      expect(await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      )).toContain("three");

      expect((await pipeline.disable("example-plugin")).ok).toBe(true);
      expect(pipeline.list()[0]?.status).toBe("disabled");
      expect((await pipeline.enable("example-plugin")).ok).toBe(true);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after enable.",
      );

      await writeFile(fixture.entryPath, [
        'export const marker = "four";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "Watcher edit did not enter disabled-pending-approval.",
      );
      expect((await pipeline.approve("example-plugin")).ok).toBe(true);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after approval.",
      );

      // Renaming an approved manifest identity must not carry its approval
      // forward. "renamed-plugin" has never been approved, even though
      // "example-plugin" was approved and running at this same root.
      await writeFile(join(fixture.pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
        version: 1,
        name: "renamed-plugin",
        displayName: "Renamed plugin",
        entry: "src/index.ts",
      }, null, 2)}\n`);
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/dohc-plugin.json",
        operation: "update",
      }]);
      await waitFor(
        () => {
          const plugins = pipeline.list();
          return plugins.some((plugin) =>
            plugin.id === "renamed-plugin" && plugin.status === "discovered"
          ) && !plugins.some((plugin) => plugin.id === "example-plugin");
        },
        "Manifest identity change did not finish as an unapproved discovery.",
      );
      expect(pipeline.list().some((plugin) => plugin.id === "example-plugin")).toBe(false);
      expect(
        pipeline.list().find((plugin) => plugin.id === "renamed-plugin")?.approvedHash,
      ).toBeNull();
      await expect(lstat(join(
        fixture.stateDir,
        "plugin-data",
        workspaceStateKey(fixture.workspaceRoot),
        "plugins",
        "example-plugin",
      ))).rejects.toMatchObject({ code: "ENOENT" });

      const renamedInstall = await pipeline.install("renamed-plugin");
      if (!renamedInstall.ok) {
        throw new Error(
          `${renamedInstall.error.stage}/${renamedInstall.error.code}: ${renamedInstall.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().some((plugin) =>
          plugin.id === "renamed-plugin" && plugin.status === "ready"
        ),
        "Renamed identity did not reach ready after its own fresh install.",
      );

      // Durable plugin state (what a wrapper like t3 stores): the preflight
      // must name it as permanently deleted, and uninstall must delete it.
      const stateRoot = pluginStateRoot(
        pluginDataDir(fixture.stateDir, fixture.workspaceRoot),
        "renamed-plugin",
      );
      await mkdir(join(stateRoot, "t3"), { recursive: true });
      await writeFile(join(stateRoot, "t3", "state.sqlite"), "session-bytes");

      const preflight = await pipeline.uninstallPreflight("renamed-plugin", "example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      expect(preflight.preflight.warning?.kind).toBe("plugin-state");
      expect(preflight.preflight.stateData).toMatchObject({
        path: stateRoot,
        fileCount: 1,
      });
      const uninstalled = await pipeline.uninstall(
        "renamed-plugin",
        "example-plugin",
        preflight.confirmationToken,
      );
      expect(uninstalled.ok).toBe(true);
      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(pipeline.list()).toEqual([]);
      expect(spawnTransport).toHaveBeenCalledTimes(6);
    } finally {
      installGate.resolve();
      await pipeline.dispose();
    }
  }, 120_000);

  it("refuses to start a bundle tampered after the build, even though its source hash is unchanged", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const spawnTransport = fakeSpawnTransport();
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport,
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const approvedHashBeforeTamper = pipeline.list()[0]?.approvedHash;

      // Tamper bundle.mjs directly without editing the source under plugins/.
      // The source hash and approvedHash stay unchanged; bundle verification
      // must still reject the changed executable.
      const bundlePath = liveBundlePath(fixture, "example-plugin");
      const builtBundle = await readFile(bundlePath, "utf8");
      expect(builtBundle).toContain("one");
      await writeFile(bundlePath, builtBundle.replaceAll("one", "TAMPERED-PAYLOAD"));

      // Stop the running (legitimate) instance and ask the pipeline to start
      // it again — ensureStarted()'s fast path, the exact call the panel
      // surface makes every time a panel opens, and the path this pipeline
      // takes on every app restart for an already-approved plugin whose host
      // isn't running yet.
      await host.stop("example-plugin");
      const { result } = await ensureFromCommand(pipeline, "example-plugin");

      expect(result.ok).toBe(true);
      // Source was still approved, so the pipeline self-heals with a fresh,
      // trustworthy rebuild rather than refusing outright — but it must
      // never start, or leave live, the tampered bytes.
      const liveBundleAfter = await readFile(bundlePath, "utf8");
      expect(liveBundleAfter).not.toContain("TAMPERED-PAYLOAD");
      expect(liveBundleAfter).toContain("one");
      expect(pipeline.list()[0]?.approvedHash).toBe(approvedHashBeforeTamper);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("leaves no staging residue and the live root byte-identical when the new build's approval cannot be persisted", async () => {
    const fixture = await createPluginWorkspace();
    let failRecordWrite = false;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        mutateRecord: async (stateDir, workspaceRoot, pluginId, mutate) => {
          if (failRecordWrite) throw new Error("approval record write failed");
          return mutatePluginRecord(stateDir, workspaceRoot, pluginId, mutate);
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      expect(installed.ok).toBe(true);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const bundlePath = liveBundlePath(fixture, "example-plugin");
      expect(await readFile(bundlePath, "utf8")).toContain("one");
      const approvedHashBefore = pipeline.list()[0]?.approvedHash;
      const dataRoot = pluginsDataRoot(fixture);
      const liveRoot = join(dataRoot, "example-plugin");
      // The installed snapshot is the working copy the next install and build
      // run in, and snapshotPluginSource refreshes it before either — so it
      // is the published build output, not the whole live root, that a failed
      // attempt has to leave untouched.
      const publishedOutputs = (hashes: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(hashes).filter(([path]) => !path.startsWith("snapshot/")),
        );
      const liveBefore = publishedOutputs(await fileHashes(liveRoot));
      expect(Object.keys(liveBefore).sort()).toEqual([
        "baseline-manifest.json",
        "bundle.mjs",
        "bundle.mjs.map",
        "dohc-plugin.generated.json",
        "meta.json",
      ]);

      await writeFile(fixture.entryPath, [
        'export const marker = "two";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      failRecordWrite = true;
      const rebuilt = await pipeline.install("example-plugin");

      expect(rebuilt.ok).toBe(false);
      // The new bundle was built but never published, so the bytes on disk
      // are still the ones whose approval is durably recorded.
      const liveBundle = await readFile(bundlePath, "utf8");
      expect(liveBundle).toContain("one");
      expect(liveBundle).not.toContain("two");
      expect(pipeline.list()[0]?.approvedHash).toBe(approvedHashBefore);
      // The failure path's discard() ran: nothing staged or set aside
      // survives beside the live root, and the live root itself is exactly
      // the tree the approved build left.
      expect(await readdir(dataRoot)).toEqual(["example-plugin"]);
      const liveAfter = await fileHashes(liveRoot);
      expect(publishedOutputs(liveAfter)).toEqual(liveBefore);
      expect(Object.keys(liveAfter)).toEqual(
        expect.arrayContaining(["snapshot/src/index.ts"]),
      );
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("preserves a valid plugin's own validity in a failure recorded after its discovery entry disappeared", async () => {
    const fixture = await createPluginWorkspace();
    const installGate = deferred();
    let pipeline: PluginPipeline;
    let discoverCalls = 0;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        // Real discovery once (to seed a real, valid status), then empty —
        // simulating the plugin's directory disappearing while its own
        // install is still in flight below.
        discover: async (workspaceRoot, installedDirectoryNames) => {
          discoverCalls += 1;
          return discoverCalls === 1
            ? await discoverInstalledPlugins(workspaceRoot, installedDirectoryNames)
            : [];
        },
        install: async () => {
          await installGate.promise;
          throw new Error("synthetic install failure (R23 PoC)");
        },
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.list()[0]).toMatchObject({ id: "example-plugin", valid: true });

      const installPromise = pipeline.install("example-plugin");
      // The watcher observes the plugin's directory vanishing while the
      // install above is still in flight — discovery.find(id) inside
      // failure() (below) will miss by the time the install rejects.
      pipeline.handleWatcherEvents([
        { path: "plugins/example-plugin", operation: "delete" },
      ]);
      await waitFor(() => discoverCalls >= 2, "Watcher-driven rediscovery did not run.");
      installGate.resolve();

      const result = await installPromise;
      expect(result.ok).toBe(false);
      expect(result.plugin).toMatchObject({ id: "example-plugin", valid: true });
    } finally {
      installGate.resolve();
      await pipeline.dispose();
    }
  });

  it("restores the running status after a watcher reconcile that finds no real change", async () => {
    const fixture = await createPluginWorkspace();
    let snapshotCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        snapshot: (input) => {
          snapshotCalls += 1;
          return snapshotPluginSource(input);
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // Rewriting the exact same bytes touches mtime but never the source
      // hash — a real no-op from the pipeline's own point of view, exactly
      // what a watcher can observe from an editor's save-with-no-changes
      // or a sync tool settling.
      const originalSource = await readFile(fixture.entryPath, "utf8");
      await writeFile(fixture.entryPath, originalSource);
      const snapshotsBefore = snapshotCalls;
      await pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);

      // The pipeline sets "snapshotting" on its way into the source check, so
      // its snapshot call is the moment the plugin is inside that busy window.
      // Reaching "ready" from there is the restore under test, not the status
      // the plugin already carried.
      await waitFor(
        () => snapshotCalls > snapshotsBefore,
        "The no-op watcher reconcile never checked the source.",
      );
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        () =>
          `No-op reconcile left status at "${pipeline.list()[0]?.status}" ` +
          `instead of restoring "ready".`,
      );
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("keeps an explicitly disabled plugin disabled after approving an out-of-band change", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // The user explicitly disables it — their own, standalone choice.
      expect((await pipeline.disable("example-plugin")).ok).toBe(true);
      expect(pipeline.list()[0]).toMatchObject({ status: "disabled", disabledReason: "user" });

      // An out-of-band (watcher-observed) source change arrives while it
      // sits disabled — unrelated to the user's disable decision.
      await writeFile(fixture.entryPath, [
        'export const marker = "out-of-band";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "Watcher edit on a disabled plugin did not enter disabled-pending-approval.",
      );

      const approved = await pipeline.approve("example-plugin");
      expect(approved.ok).toBe(true);
      // The new content is now trusted (a future enable() will work cleanly
      // from it), but the user's own explicit disable must still hold.
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled",
        disabledReason: "user",
        runtimeStatus: null,
      });
      expect(host.getStatus("example-plugin")).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("never runs a plugin-authored .pnpmfile.cjs hook during install", async () => {
    const fixture = await createPluginWorkspace();
    const canaryPath = join(
      fixture.stateDir,
      "plugin-data",
      workspaceStateKey(fixture.workspaceRoot),
      "plugins",
      "example-plugin",
      "snapshot",
      "PNPMFILE_CANARY.txt",
    );
    // --ignore-scripts alone does not stop this: .pnpmfile.cjs hooks
    // (readPackage/afterAllResolved) are a separate pnpm mechanism that runs
    // arbitrary Node code during dependency resolution.
    await writeFile(
      join(fixture.pluginRoot, ".pnpmfile.cjs"),
      [
        'const fs = require("fs");',
        'const path = require("path");',
        "module.exports = {",
        "  hooks: {",
        "    readPackage(pkg) {",
        '      fs.writeFileSync(path.join(__dirname, "PNPMFILE_CANARY.txt"), "ran\\n");',
        "      return pkg;",
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");

      // The snapshot refuses package-manager configuration, so pnpm's cwd never
      // contains a .Pnpmfile.cjs. --ignore-pnpmfile provides another check.
      await expect(lstat(canaryPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(installed).toMatchObject({
        ok: false,
        error: { stage: "snapshot", code: "unsupported-package-manager-config" },
      });
      await expectNoLiveSnapshot(fixture, "example-plugin");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("refuses to delete when source changed after the last check, immediately before the delete", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    // The full preflight runs once for the dialog. Execution hashes the source
    // before stopping and again immediately before deletion; the second probe
    // sees drift across the real host-stop await window.
    let preflightCalls = 0;
    let hashSourceCalls = 0;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        uninstallPreflight: async (input) => {
          preflightCalls += 1;
          return pluginUninstallPreflight(input);
        },
        hashSource: async (rootPath) => {
          hashSourceCalls += 1;
          const real = await hashPluginSourceFiles(rootPath);
          return hashSourceCalls === 1
            ? real
            : { ...real, sourceHash: "f".repeat(64) };
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      const preflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const result = await pipeline.uninstall(
        "example-plugin",
        "example-plugin",
        preflight.confirmationToken,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toMatchObject({
        stage: "uninstall",
        code: "confirmation-stale",
      });
      // Refused, not deleted.
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();
      expect(preflightCalls).toBe(1);
      expect(hashSourceCalls).toBe(2);
      // Restore an actionable status the user can retry from; the plugin must
      // not stay on the "uninstalling" spinner.
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled",
        disabledReason: "user",
        runtimeStatus: null,
      });
      expect(pipeline.list()[0]?.error).toMatchObject({
        code: "confirmation-stale",
      });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("refuses to delete when the source could not be fingerprinted", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    // The dialog can read the source, but execution's fail-closed hash probe
    // cannot. A present source with an unreadable hash must never compare as
    // equivalent to an absent source.
    let preflightCalls = 0;
    let hashSourceCalls = 0;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        uninstallPreflight: async (input) => {
          preflightCalls += 1;
          return pluginUninstallPreflight(input);
        },
        hashSource: async () => {
          hashSourceCalls += 1;
          throw new Error("simulated unreadable source");
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      const preflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const result = await pipeline.uninstall(
        "example-plugin",
        "example-plugin",
        preflight.confirmationToken,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toMatchObject({
        stage: "uninstall",
        code: "confirmation-stale",
      });
      expect(result.error.message).toContain(
        "could not be read to confirm what uninstall would delete",
      );
      expect(preflightCalls).toBe(1);
      expect(hashSourceCalls).toBe(1);
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();
      await expect(lstat(join(fixture.pluginRoot, "dohc-plugin.json")))
        .resolves.toBeDefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("never lets a same-batch identity vacate and get reclaimed carry its approval across", async () => {
    // Two identities change in the same watcher batch: "temp"@aaa-renamed
    // (sorts first, lexically, so it's processed first) renames to "bar",
    // landing on the exact id "bar"@zzz-original is simultaneously
    // vacating. Processing "temp"'s replacement (the new "bar") before
    // "bar"@zzz-original's own departure is fully applied would let the
    // replacement read the departing identity's still-present, about-to-
    // be-deleted approvedHash under the very id it's claiming.
    const fixture = await createPluginWorkspace({
      directoryName: "zzz-original",
      pluginId: "bar",
      displayName: "bar",
    });
    const renamedRoot = join(fixture.workspaceRoot, "plugins", "aaa-renamed");
    await mkdir(join(renamedRoot, "src"), { recursive: true });
    await writeFile(join(renamedRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1, name: "temp", displayName: "temp", entry: "src/index.ts",
    }, null, 2)}\n`);
    await writeFile(join(renamedRoot, "package.json"), `${JSON.stringify({
      name: "temp", version: "1.0.0", private: true, type: "module",
      packageManager: "pnpm@11.20.0",
    }, null, 2)}\n`);
    await writeFile(join(renamedRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n"));
    await writeFile(join(renamedRoot, "src", "index.ts"), [
      'export const marker = "one";',
      "export default { activate() {} };",
      "",
    ].join("\n"));

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      // Approve "bar" for real, at its original root.
      const installed = await pipeline.install("bar");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().find((p) => p.id === "bar")?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      // Stop the live host directly (not disable(), which would also flip
      // the persisted approval's disabled bit) — approved but not currently
      // running, so a hash-match at reconcile time falls through to
      // runFullBuild's real "start it" branch instead of the unrelated
      // already-running no-op shortcut.
      await pipeline.host.stop("bar");
      // Discover "temp" too, so it's a tracked candidate before the batch.
      pipeline.handleWatcherEvents([{ path: "plugins/aaa-renamed", operation: "create" }]);
      await waitFor(
        () => pipeline.list().some((p) => p.id === "temp"),
        "temp was never discovered.",
      );

      // Now, in one batch: "aaa-renamed" renames from "temp" to "bar" with
      // content byte-identical to what "bar" already had approved, while
      // the original "bar"@zzz-original is deleted outright.
      await writeFile(join(renamedRoot, "dohc-plugin.json"), `${JSON.stringify({
        version: 1, name: "bar", displayName: "bar", entry: "src/index.ts",
      }, null, 2)}\n`);
      await writeFile(join(renamedRoot, "package.json"), `${JSON.stringify({
        name: "bar", version: "1.0.0", private: true, type: "module",
        packageManager: "pnpm@11.20.0",
      }, null, 2)}\n`);
      await rm(fixture.pluginRoot, { recursive: true, force: true });
      const identityReplacement = pipeline.handleWatcherEvents([
        { path: "plugins/aaa-renamed", operation: "update" },
        { path: "plugins/zzz-original", operation: "delete" },
      ]);

      await waitFor(
        () => pipeline.list().some((p) => p.id === "bar" && p.rootPath === renamedRoot),
        "The renamed identity was never rediscovered at its new root.",
      );
      await settleWithin(
        identityReplacement,
        "The identity replacement watcher batch did not finish.",
      );
      await settleWithin(
        (pipeline as unknown as {
          enqueueActionValue: (
            pluginId: string,
            run: () => Promise<void>,
          ) => Promise<void>;
        }).enqueueActionValue("bar", async () => undefined),
        "The replacement identity refresh did not finish.",
      );
      const moved = pipeline.list().find((p) => p.id === "bar" && p.rootPath === renamedRoot);
      expect(moved).toMatchObject({ status: "discovered", approvedHash: null });
      expect(host.getStatus("bar")).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("holds for approval instead of auto-approving a disk-only change that lands while a door write's own refresh is queued", async () => {
    const fixture = await createPluginWorkspace();
    const installGate = deferred();
    let installCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: async (input) => {
          installCalls += 1;
          // The 2nd overall install call is approve()'s — it occupies this
          // plugin's job queue so the door-write refresh queued below has
          // to wait behind it, giving the disk-only mutation a real window.
          if (installCalls === 2) await installGate.promise;
          return installPluginDependencies({ ...input, forkProcess: nodeForkProcess });
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // approve() runs unconditionally and blocks on the gated 2nd install
      // call, occupying the queue — standing in for "some other job is
      // already running when the door write arrives" (installCalls === 2
      // is deliberately generic: any job ahead in the queue creates the
      // same delay).
      const approvePromise = pipeline.approve("example-plugin");
      await waitFor(() => installCalls === 2, "approve() never reached the gated install.");

      // The door write itself: authored content lands on disk, then the
      // owning plugin is told about it immediately — path and bytes —
      // exactly like main.ts's writeAuthoredText ->
      // handleDoorWrittenSourceChange call.
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-written";',
        "export default { activate() {} };",
        "",
      ].join("\n"));

      // Before that refresh gets a turn (it is still queued behind
      // approve()'s blocked install), an unrelated, non-door-authored actor
      // mutates the same file on disk.
      await writeFile(fixture.entryPath, [
        'export const marker = "disk-only-interloper";',
        "export default { activate() {} };",
        "",
      ].join("\n"));

      installGate.resolve();
      const approved = await approvePromise;
      expect(approved.ok).toBe(true);

      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        `The disk-only change was not held for approval; status is `
          + `"${pipeline.list()[0]?.status}".`,
      );
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled-pending-approval",
        disabledReason: "approval",
      });
      // The interloper's content never ran.
      expect(await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      )).not.toContain("disk-only-interloper");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("names the source change that raced a fresh install, and tells that hold apart from a plain post-install edit", async () => {
    const fixture = await createPluginWorkspace();
    const installGate = deferred();
    let installCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: async (input) => {
          installCalls += 1;
          // The first install is the fresh one. Holding it open stands in
          // for the real cold run: the dependency install takes minutes,
          // and the tree it was told to trust was hashed before it started.
          if (installCalls === 1) await installGate.promise;
          return installPluginDependencies({ ...input, forkProcess: nodeForkProcess });
        },
      },
    });

    try {
      await pipeline.start();
      const installPromise = pipeline.install("example-plugin");
      await waitFor(
        () => installCalls === 1,
        "install() never reached the gated dependency install.",
      );

      // The write that races: it lands after the install's snapshot hashed
      // the tree and before the install finishes, so the hash the install
      // is about to record already describes bytes that are gone.
      await writeFile(fixture.entryPath, [
        'export const marker = "raced-the-install";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);

      installGate.resolve();
      const installed = await installPromise;
      expect(installed.ok).toBe(true);

      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        `The raced change was not held for approval; status is `
          + `"${pipeline.list()[0]?.status}".`,
      );
      // The hold itself is the invariant and stays: nothing auto-approved
      // the raced bytes.
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled-pending-approval",
        disabledReason: "approval",
      });
      expect(await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      )).not.toContain("raced-the-install");
      // What #803 adds: the plugin no longer switches itself off in silence.
      expect(pipeline.list()[0]?.error).toMatchObject({
        stage: "snapshot",
        code: "source-changed-during-install",
      });
      expect(pipeline.list()[0]?.error?.message)
        .toContain("changed while dohc was installing it");

      // The named recovery: approving installs the new bytes through the
      // normal flow, which is the only thing that ever approves them.
      const approved = await pipeline.approve("example-plugin");
      expect(approved.ok).toBe(true);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The raced bytes never installed after approval.",
      );
      expect(pipeline.list()[0]?.error).toBe(null);
      expect(await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      )).toContain("raced-the-install");

      // The contrast that keeps the name honest: with no install in flight,
      // the same hold reports the edit the user actually made.
      await writeFile(fixture.entryPath, [
        'export const marker = "edited-later";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "The later edit was not held for approval.",
      );
      expect(pipeline.list()[0]?.error).toMatchObject({
        stage: "snapshot",
        code: "source-changed-after-install",
      });
      expect(pipeline.list()[0]?.error?.message)
        .toContain("changed after dohc installed it");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("leaves a failed uninstall in an actionable, retryable state instead of a stuck spinner", async () => {
    const fixture = await createPluginWorkspace();
    let removeCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        removePath: async (path, options) => {
          removeCalls += 1;
          // The very first delete attempt fails (a locked file, a permission
          // error) — everything after must still be recoverable.
          if (removeCalls === 1) {
            throw new Error("simulated: target is busy");
          }
          return rm(path, options);
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      const preflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const failed = await pipeline.uninstall(
        "example-plugin",
        "example-plugin",
        preflight.confirmationToken,
      );

      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error("unreachable");
      expect(failed.error).toMatchObject({ stage: "uninstall", code: "delete-failed" });
      // Actionable, not a stuck "uninstalling" spinner — and no orphan: the
      // source directory is still exactly where it was.
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled-pending-repair",
        disabledReason: "repair",
      });
      expect(pipeline.list()[0]?.error).not.toBeNull();
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();

      // The record survived, so a fresh preflight + retry succeeds once the
      // underlying problem (here, the mocked one-shot failure) is gone.
      const retryPreflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!retryPreflight.ok) throw new Error(retryPreflight.error.message);
      const retried = await pipeline.uninstall(
        "example-plugin",
        "example-plugin",
        retryPreflight.confirmationToken,
      );
      expect(retried.ok).toBe(true);
      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("builds from the manifest in the snapshot, not the stale copy discovery cached", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // A second entry file, and dohc-plugin.json repointed at it directly
      // on disk — with no watcher event fired for either, so discovery's
      // in-memory candidate.manifest is never refreshed and stays pinned to
      // the original "src/index.ts" entry.
      await writeFile(join(fixture.pluginRoot, "src", "v2-entry.ts"), [
        'export const marker = "v2-entry";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await writeFile(join(fixture.pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
        version: 1,
        name: "example-plugin",
        displayName: "Example plugin",
        entry: "src/v2-entry.ts",
      }, null, 2)}\n`);

      // approve() rebuilds unconditionally without any prior discovery
      // rescan, so this exercises the stale in-memory manifest directly.
      const approved = await pipeline.approve("example-plugin");
      expect(approved.ok).toBe(true);

      const bundle = await readFile(liveBundlePath(fixture, "example-plugin"), "utf8");
      // The snapshot taken for this very build already contains
      // dohc-plugin.json's real, current entry ("src/v2-entry.ts") — the
      // build must read that, not discovery's stale cached manifest, which
      // still says "src/index.ts" (whose content has no "v2-entry" marker
      // at all).
      expect(bundle).toContain("v2-entry");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("uninstall removes a build left staged beside the live root", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // What a build killed between its own renames leaves behind. It holds
      // built plugin bytes, and it is outside the live root, so uninstall's
      // recursive delete of the live root alone would walk straight past it.
      const dataRoot = pluginsDataRoot(fixture);
      const orphanedStaging = join(
        dataRoot,
        `example-plugin.staging-${randomUUID()}`,
      );
      await mkdir(orphanedStaging, { recursive: true });
      await writeFile(join(orphanedStaging, "bundle.mjs"), "orphaned bytes\n");
      // npm names allow dots, so this is another installed plugin's own live
      // root — not an artifact of this one, and never uninstall's to delete.
      const neighbourRoot = join(dataRoot, "example-plugin.bar");
      await mkdir(join(neighbourRoot, "snapshot"), { recursive: true });
      await writeFile(join(neighbourRoot, "bundle.mjs"), "neighbour bytes\n");

      const preflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "example-plugin",
        "example-plugin",
        preflight.confirmationToken,
      );

      expect(uninstalled.ok).toBe(true);
      expect(await readdir(dataRoot)).toEqual(["example-plugin.bar"]);
      expect(await readFile(join(neighbourRoot, "bundle.mjs"), "utf8"))
        .toBe("neighbour bytes\n");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("keeps uninstall available for an installed plugin whose manifest later broke", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const newHost = () => {
      const created = new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
      return created;
    };
    const newPipeline = (host: PluginHost) =>
      new PluginPipeline({
        isEngineCaptureAvailable: () => true,
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        hostOwnership: new PluginHostOwnership(host),
        resourcesBasePath,
        pnpmRunnerEntry,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
    } finally {
      await pipeline.dispose();
    }

    // The manifest breaks while dohc is not running, so no watcher event ever
    // observes the transition — the next launch simply discovers an invalid
    // candidate whose installed artifacts are all still on disk.
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      "{ this is not valid JSON\n",
    );

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const row = pipeline.list()[0];
      expect(row).toMatchObject({
        id: "example-plugin",
        valid: false,
        status: "invalid",
      });
      // The installation identity is what Settings reads to offer Uninstall.
      expect(row?.approvedHash).not.toBeNull();
      expect(row?.error?.code).toBe("invalid-plugin");

      const preflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "example-plugin",
        "example-plugin",
        preflight.confirmationToken,
      );
      expect(uninstalled.ok).toBe(true);

      // Every trace uninstall owns: the workspace source, the userData live
      // root, and the local-state record.
      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(pluginsDataRoot(fixture))).toEqual([]);
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("rebuilds instead of starting stale bytes after a failed publish", async () => {
    const fixture = await createPluginWorkspace();
    let failPublish = false;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        build: async (input) => {
          const result = await buildPluginBundle(input);
          if (!result.ok || !failPublish) return result;
          // Stands for any IO failure inside publish's rename swap. The
          // approval record for these exact bytes is written before publish
          // runs, so the record ends up naming a bundle the disk never got.
          return {
            ...result,
            publish: () => Promise.reject(new Error("simulated publish failure")),
          };
        },
      },
    });

    const bundleHashOnDisk = async (): Promise<string> =>
      createHash("sha256")
        .update(await readFile(liveBundlePath(fixture, "example-plugin")))
        .digest("hex");
    const recordedBundleHash = async (): Promise<string | undefined> => {
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      return state.state.plugins["example-plugin"]?.approvedBundleHash;
    };

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      await writeFile(fixture.entryPath, [
        'export const marker = "two";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      failPublish = true;
      const failed = await pipeline.install("example-plugin");

      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error("unreachable");
      expect(failed.error).toMatchObject({
        stage: "build",
        code: "publish-failed",
      });
      // The recorded approval names the new build; the disk still holds the
      // old bundle. That disagreement is the whole point of the pin.
      const staleBundle = await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      );
      expect(staleBundle).toContain("one");
      expect(staleBundle).not.toContain("two");
      expect(await recordedBundleHash()).not.toBe(await bundleHashOnDisk());

      // Fail closed: the next start must not run those stale bytes. It
      // rebuilds from the still-approved source instead.
      failPublish = false;
      await host.stop("example-plugin");
      const { result: restarted } = await ensureFromCommand(
        pipeline,
        "example-plugin",
      );

      expect(restarted.ok).toBe(true);
      const republished = await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      );
      expect(republished).toContain("two");
      expect(await recordedBundleHash()).toBe(await bundleHashOnDisk());
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("persists a failed fresh install as an actionable repair state", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: () => Promise.reject(new Error("synthetic install failure")),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");

      expect(installed.ok).toBe(false);
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled-pending-repair",
        disabledReason: "repair",
        runtimeStatus: null,
      });
      expect(pipeline.list()[0]?.error).not.toBeNull();
      // Persisted, not just displayed: a plugin whose first install died
      // half-way must not come back enabled on the next launch, and it must
      // not carry an approval it never earned.
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]).toMatchObject({
        disabled: true,
      });
      expect(state.state.plugins["example-plugin"]?.approvedHash).toBeUndefined();
      expect(host.getStatus("example-plugin")).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("leaves a failed source check actionable instead of stuck at snapshotting", async () => {
    const fixture = await createPluginWorkspace();
    let failSnapshot = false;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        snapshot: async (input) => {
          const real = await snapshotPluginSource(input);
          if (!failSnapshot) return real;
          return {
            ok: false,
            error: {
              code: "snapshot-io",
              message: "simulated snapshot failure",
              path: null,
            },
            pnpmPaths: real.pnpmPaths,
          };
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      expect((await pipeline.disable("example-plugin")).ok).toBe(true);

      failSnapshot = true;
      const enabled = await pipeline.enable("example-plugin");

      expect(enabled.ok).toBe(false);
      // "snapshotting" is a busy status: it disables every action for this
      // plugin, and nothing else restores it.
      expect(pipeline.list()[0]?.status).not.toBe("snapshotting");
      expect(pipeline.list()[0]).toMatchObject({ status: "failed" });
      expect(pipeline.list()[0]?.error).toMatchObject({
        stage: "snapshot",
        code: "snapshot-io",
      });

      // Actionable means the next attempt really works.
      failSnapshot = false;
      expect((await pipeline.enable("example-plugin")).ok).toBe(true);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not recover after the snapshot failure cleared.",
      );
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("leaves the live snapshot serving approved bytes while a change waits for approval", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    const liveEntry = join(
      liveSnapshotRoot(fixture, "example-plugin"),
      "src",
      "index.ts",
    );
    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      expect(await readFile(liveEntry, "utf8")).toContain('marker = "one"');

      // An out-of-band change nobody has approved.
      await writeFile(fixture.entryPath, [
        'export const marker = "unapproved";',
        "export default { activate() {} };",
        "",
      ].join("\n"));

      const held = await pipeline.enable("example-plugin");

      expect(held.ok).toBe(true);
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled-pending-approval",
      });
      // startPluginPanel serves this directory, and the child-process broker
      // spawns snapshot/server.mjs out of it. Publishing on sight put the
      // unapproved bytes there before anything had approved them.
      expect(await readFile(liveEntry, "utf8")).toContain('marker = "one"');
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .not.toContain("unapproved");
      // The discarded staging leaves nothing behind.
      expect(await stagingLeftovers(fixture, "example-plugin")).toEqual([]);

      const approved = await pipeline.approve("example-plugin");
      expect(approved.ok).toBe(true);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after approval.",
      );

      expect(await readFile(liveEntry, "utf8")).toContain('marker = "unapproved"');
      expect(await stagingLeftovers(fixture, "example-plugin")).toEqual([]);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("holds a change that lands between a door write's check and the build's own snapshot", async () => {
    const fixture = await createPluginWorkspace();
    let interloperArmed = false;
    let armedSnapshotCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        // The window itself: the refresh's first snapshot passed the door
        // predicate, and this fires as the build takes its own second,
        // fresh snapshot.
        snapshot: async (input) => {
          if (interloperArmed && ++armedSnapshotCalls === 2) {
            interloperArmed = false;
            await writeFile(fixture.entryPath, [
              'export const marker = "window-interloper";',
              "export default { activate() {} };",
              "",
            ].join("\n"));
          }
          return snapshotPluginSource(input);
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      interloperArmed = true;
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-written";',
        "export default { activate() {} };",
        "",
      ].join("\n"));

      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "The change inside the build window was not held for approval; status is "
          + `"${pipeline.list()[0]?.status}".`,
      );
      // Neither the door-written content nor the interloper was approved,
      // and the interloper never ran.
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .not.toContain("window-interloper");
      expect(await readFile(
        join(liveSnapshotRoot(fixture, "example-plugin"), "src", "index.ts"),
        "utf8",
      )).toContain('marker = "one"');
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("keeps uninstall available for a scoped plugin in a differently named directory whose manifest broke", async () => {
    const fixture = await createPluginWorkspace({
      directoryName: "foo",
      pluginId: "@scope/bar",
      displayName: "@scope/bar",
    });
    let pipeline: PluginPipeline;
    const newHost = () =>
      new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
    const newPipeline = (host: PluginHost) =>
      new PluginPipeline({
        isEngineCaptureAvailable: () => true,
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        hostOwnership: new PluginHostOwnership(host),
        resourcesBasePath,
        pnpmRunnerEntry,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const installed = await pipeline.install("@scope/bar");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
    } finally {
      await pipeline.dispose();
    }

    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      "{ this is not valid JSON\n",
    );

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      // Discovery falls back to the directory name "foo", which is not the
      // key this installation's record is stored under. Joining on the
      // recorded directory is what keeps the installation visible.
      const row = pipeline.list()[0];
      expect(row).toMatchObject({
        id: "@scope/bar",
        directoryName: "foo",
        valid: false,
        status: "invalid",
      });
      expect(row?.approvedHash).not.toBeNull();

      const preflight = await pipeline.uninstallPreflight("@scope/bar", "foo");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "@scope/bar",
        "foo",
        preflight.confirmationToken,
      );
      expect(uninstalled.ok).toBe(true);

      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(pluginsDataRoot(fixture))).toEqual([]);
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["@scope/bar"]).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("keeps an installation with its own directory when a second root claims its id", async () => {
    const fixture = await createPluginWorkspace({
      directoryName: "zeta",
      pluginId: "shared-id",
      displayName: "shared-id",
    });
    let pipeline: PluginPipeline;
    const newHost = () =>
      new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
    const newPipeline = (host: PluginHost) =>
      new PluginPipeline({
        isEngineCaptureAvailable: () => true,
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        hostOwnership: new PluginHostOwnership(host),
        resourcesBasePath,
        pnpmRunnerEntry,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const installed = await pipeline.install("shared-id");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
    } finally {
      await pipeline.dispose();
    }

    // Two more directories now declare the same manifest id, one on each side
    // of "zeta" lexically. The earlier one used to take the id outright, and
    // with it the approval, the uninstall paths, and the identity of an
    // installation it has nothing to do with; the later one used to overwrite
    // the installation's own status by joining its record.
    const earlierRoot = join(fixture.workspaceRoot, "plugins", "alpha");
    const laterRoot = join(fixture.workspaceRoot, "plugins", "zzz");
    await cp(fixture.pluginRoot, earlierRoot, { recursive: true });
    await cp(fixture.pluginRoot, laterRoot, { recursive: true });

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const installedRow = () =>
        pipeline.list().find((plugin) => plugin.directoryName === "zeta");
      await waitFor(
        () => installedRow()?.status === "ready",
        "The installed plugin did not keep its identity after reopening.",
      );
      expect(installedRow()).toMatchObject({
        id: "shared-id",
        rootPath: fixture.pluginRoot,
        valid: true,
        approvedHash: expect.any(String),
      });
      // Both interlopers are listed, but only as invalid duplicates: neither
      // holds an approval or an installation of its own. Each keeps its own
      // directory-derived id — one id per row — and its duplicate
      // diagnostics stay reachable on that row.
      const listed = pipeline.list();
      expect(new Set(listed.map((plugin) => plugin.id)).size).toBe(listed.length);
      for (const directoryName of ["alpha", "zzz"]) {
        const row = listed.find((plugin) => plugin.directoryName === directoryName);
        expect(row).toMatchObject({
          id: directoryName,
          valid: false,
          status: "invalid",
          approvedHash: null,
        });
        expect(row?.diagnostics.join(" "))
          .toContain('duplicate plugin id "shared-id"');
      }

      const preflight = await pipeline.uninstallPreflight("shared-id", "zeta");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "shared-id",
        "zeta",
        preflight.confirmationToken,
      );
      expect(uninstalled.ok).toBe(true);
      // Uninstall deleted the directory the record names, not the one that
      // sorted first.
      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(join(earlierRoot, "dohc-plugin.json")))
        .resolves.toBeDefined();
      await expect(lstat(join(laterRoot, "dohc-plugin.json")))
        .resolves.toBeDefined();
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("keeps an installation when its directory is renamed", async () => {
    const fixture = await createPluginWorkspace({
      directoryName: "zeta",
      pluginId: "shared-id",
      displayName: "shared-id",
    });
    let pipeline: PluginPipeline;
    const newHost = () =>
      new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
    const newPipeline = (host: PluginHost) =>
      new PluginPipeline({
        isEngineCaptureAvailable: () => true,
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        hostOwnership: new PluginHostOwnership(host),
        resourcesBasePath,
        pnpmRunnerEntry,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const installed = await pipeline.install("shared-id");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
    } finally {
      await pipeline.dispose();
    }

    // The manifest is intact, so the id is unchanged: this is the same
    // installation in a renamed folder, and it keeps its record.
    const renamedRoot = join(fixture.workspaceRoot, "plugins", "beta");
    await rename(fixture.pluginRoot, renamedRoot);

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const row = pipeline.list()[0];
      expect(row).toMatchObject({
        id: "shared-id",
        directoryName: "beta",
        rootPath: renamedRoot,
        valid: true,
      });
      expect(row?.approvedHash).not.toBeNull();

      const preflight = await pipeline.uninstallPreflight("shared-id", "beta");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "shared-id",
        "beta",
        preflight.confirmationToken,
      );
      expect(uninstalled.ok).toBe(true);
      await expect(lstat(renamedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("leaves a dotted neighbour's data alone when an identity is renamed", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // The same sweep uninstall uses also runs on any identity change, so a
      // plugin named "example-plugin.bar" loses its live root there too.
      const dataRoot = pluginsDataRoot(fixture);
      const neighbourRoot = join(dataRoot, "example-plugin.bar");
      await mkdir(join(neighbourRoot, "snapshot"), { recursive: true });
      await writeFile(join(neighbourRoot, "bundle.mjs"), "neighbour bytes\n");

      await writeFile(join(fixture.pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
        version: 1,
        name: "renamed-plugin",
        displayName: "Renamed plugin",
        entry: "src/index.ts",
      }, null, 2)}\n`);
      await pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/dohc-plugin.json",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list().some((plugin) => plugin.id === "renamed-plugin"),
        "Manifest identity change did not land as a new discovery.",
      );

      expect(await readdir(dataRoot)).toEqual(["example-plugin.bar"]);
      expect(await readFile(join(neighbourRoot, "bundle.mjs"), "utf8"))
        .toBe("neighbour bytes\n");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("retries a staged tree's cleanup when the first discard rejects", async () => {
    const fixture = await createPluginWorkspace();
    let failNextDiscard = false;
    const discards: string[] = [];
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        snapshot: async (input) => {
          const result = await snapshotPluginSource(input);
          if (!result.ok) return result;
          return {
            ...result,
            discard: async () => {
              discards.push(result.snapshotRoot);
              // The first removal rejects and leaves the tree where it was —
              // a locked file, a scanner, a permission error.
              if (failNextDiscard) {
                failNextDiscard = false;
                throw new Error("simulated: staged tree is busy");
              }
              await result.discard();
            },
          };
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // Source no longer matches the approved hash, so ensureStarted stages a
      // tree and then has to drop it again.
      await writeFile(fixture.entryPath, [
        'export const marker = "unapproved";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      failNextDiscard = true;
      const surface = await ensureFromSurface(pipeline, "example-plugin");
      const started = surface.result;

      // Reject the start and leave no staging bytes beside the live root. The
      // same job's cleanup retries the rejected discard.
      expect(started.ok).toBe(false);
      expect(discards).toHaveLength(2);
      expect(await stagingLeftovers(fixture, "example-plugin")).toEqual([]);
      await surface.release();
      expect(await readFile(
        join(liveSnapshotRoot(fixture, "example-plugin"), "src", "index.ts"),
        "utf8",
      )).toContain('marker = "one"');
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("retries the build's own discard when the source moved under a door write", async () => {
    const fixture = await createPluginWorkspace();
    let mismatchNextSnapshot = false;
    let failNextDiscard = false;
    const discards: string[] = [];
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        snapshot: async (input) => {
          const result = await snapshotPluginSource(input);
          if (!result.ok || !mismatchNextSnapshot) return result;
          mismatchNextSnapshot = false;
          return {
            ...result,
            // A disk-only change landed between the door write's hash check
            // and this snapshot, so the build must drop the staged tree and
            // hold for approval instead of building it.
            sourceHash: "0".repeat(64),
            discard: async () => {
              discards.push(result.snapshotRoot);
              if (failNextDiscard) {
                failNextDiscard = false;
                throw new Error("simulated: staged tree is busy");
              }
              await result.discard();
            },
          };
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      mismatchNextSnapshot = true;
      failNextDiscard = true;
      pipeline.handleDoorWrittenSourceChange("example-plugin", {
        absolutePath: fixture.entryPath,
        text: await readFile(fixture.entryPath, "utf8"),
      });

      // The rejected discard is retried by the same job's cleanup, which runs
      // before the job reports its failure, so no staged bytes are left
      // beside the live root.
      await waitFor(
        () => pipeline.list()[0]?.status === "failed",
        "The build never reported the rejected discard.",
      );
      expect(discards).toHaveLength(2);
      expect(await stagingLeftovers(fixture, "example-plugin")).toEqual([]);
      expect(await readFile(
        join(liveSnapshotRoot(fixture, "example-plugin"), "src", "index.ts"),
        "utf8",
      )).toContain('marker = "one"');
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  registerEstablishedPluginRecoveryTests();

  it("keeps an installation whose manifest breaks while it is watched, and recovers it when the manifest returns", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const manifestPath = join(fixture.pluginRoot, "dohc-plugin.json");
      const manifestText = await readFile(manifestPath, "utf8");
      const liveRoot = join(pluginsDataRoot(fixture), "example-plugin");
      const liveBefore = await fileHashes(liveRoot);

      // A half-written manifest is an ordinary state while an agent acting for a user
      // edits the plugin. The root never left; only its manifest did.
      await writeFile(manifestPath, "{ half written\n");
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/dohc-plugin.json",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "invalid",
        "The broken manifest never landed as an invalid row.",
      );

      // Still installed: the record, the approval, the built bundle, and the
      // published snapshot all survive, and Settings still offers Uninstall.
      expect(pipeline.list()[0]).toMatchObject({
        id: "example-plugin",
        valid: false,
        status: "invalid",
      });
      expect(pipeline.list()[0]?.approvedHash).not.toBeNull();
      const broken = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!broken.ok) throw new Error(broken.warning);
      expect(broken.state.plugins["example-plugin"]?.approvedHash).toEqual(
        expect.any(String),
      );
      expect(await fileHashes(liveRoot)).toEqual(liveBefore);

      // Restoring the same bytes restores the installation on its own
      // approval — no new approval prompt, no reinstall.
      await writeFile(manifestPath, manifestText);
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/dohc-plugin.json",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The restored manifest did not return the plugin to ready.",
      );
      expect(pipeline.list()[0]).toMatchObject({
        id: "example-plugin",
        valid: true,
        approvedHash: broken.state.plugins["example-plugin"]?.approvedHash,
      });
      // The built bundle is the same one: recovery verified the approved
      // source and started it, it did not rebuild. (The published source
      // snapshot beside it is re-copied by any reconcile whose install
      // rewrote the lockfile, which is not what this test is about.)
      expect((await fileHashes(liveRoot))["bundle.mjs"])
        .toBe(liveBefore["bundle.mjs"]);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("finishes an uninstall whose source delete succeeded and whose data delete failed", async () => {
    const fixture = await createPluginWorkspace();
    let failDataRemoval = false;
    let hashSourceCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        hashSource: async (rootPath) => {
          hashSourceCalls += 1;
          return hashPluginSourceFiles(rootPath);
        },
        removePath: async (path, options) => {
          if (
            failDataRemoval &&
            String(path).startsWith(pluginsDataRoot(fixture))
          ) {
            throw new Error("plugin data delete failed");
          }
          await rm(path, options);
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      failDataRemoval = true;
      const firstPreflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!firstPreflight.ok) throw new Error(firstPreflight.error.message);
      const failed = await pipeline.uninstall(
        "example-plugin",
        "example-plugin",
        firstPreflight.confirmationToken,
      );
      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error("unreachable");
      expect(failed.error).toMatchObject({
        stage: "uninstall",
        code: "delete-failed",
      });
      // The source is gone; the plugin data and the record are not.
      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(hashSourceCalls).toBe(2);
      expect(await readdir(pluginsDataRoot(fixture))).toEqual([
        "example-plugin",
      ]);
      expect(pipeline.list()[0]).toMatchObject({
        id: "example-plugin",
        status: "disabled-pending-repair",
        approvedHash: expect.any(String),
      });

      // The watcher then observes the deleted root and sweeps the identity,
      // which drops the record and fails on the same plugin data. Discovery
      // now has no candidate at all, and the row is the only thing left that
      // names the installation.
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin",
        operation: "delete",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.error?.code === "identity-cleanup-failed",
        "The watcher sweep never reported its failed cleanup.",
      );
      const swept = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!swept.ok) throw new Error(swept.warning);
      expect(swept.state.plugins["example-plugin"]).toBeUndefined();
      expect(await readdir(pluginsDataRoot(fixture))).toEqual([
        "example-plugin",
      ]);
      expect(pipeline.list()[0]).toMatchObject({
        id: "example-plugin",
        approvedHash: expect.any(String),
      });

      // The retry is the same action from the same row, and it finishes.
      failDataRemoval = false;
      const retryPreflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!retryPreflight.ok) throw new Error(retryPreflight.error.message);
      expect(retryPreflight.preflight.liveHash).toBeNull();
      const finished = await pipeline.uninstall(
        "example-plugin",
        "example-plugin",
        retryPreflight.confirmationToken,
      );
      expect(finished.ok).toBe(true);
      // A confirmed absent source still re-resolves its identity twice, but
      // neither check tries to hash a path already proven absent.
      expect(hashSourceCalls).toBe(2);

      expect(await readdir(pluginsDataRoot(fixture))).toEqual([]);
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]).toBeUndefined();
      expect(pipeline.list()).toEqual([]);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("refuses a sourceless token after the same id is restored and restarted", async () => {
    const fixture = await createPluginWorkspace();
    const backupRoot = join(fixture.root, "source-backup");
    await cp(fixture.pluginRoot, backupRoot, { recursive: true });
    let failDataRemoval = false;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        removePath: async (path, options) => {
          if (
            failDataRemoval &&
            String(path).startsWith(pluginsDataRoot(fixture))
          ) {
            throw new Error("plugin data delete failed");
          }
          await rm(path, options);
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      failDataRemoval = true;
      const firstPreflight = await pipeline.uninstallPreflight(
        "example-plugin",
        "example-plugin",
      );
      if (!firstPreflight.ok) throw new Error(firstPreflight.error.message);
      const partial = await pipeline.uninstall(
        "example-plugin",
        "example-plugin",
        firstPreflight.confirmationToken,
      );
      expect(partial).toMatchObject({
        ok: false,
        error: { stage: "uninstall", code: "delete-failed" },
      });
      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });

      failDataRemoval = false;
      const sourceless = await pipeline.uninstallPreflight(
        "example-plugin",
        "example-plugin",
      );
      if (!sourceless.ok) throw new Error(sourceless.error.message);
      expect(sourceless.preflight.liveHash).toBeNull();

      await cp(backupRoot, fixture.pluginRoot, { recursive: true });
      await pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin",
        operation: "update",
      }]);
      const enabled = await pipeline.enable("example-plugin");
      if (!enabled.ok) throw new Error(enabled.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The restored plugin did not restart.",
      );
      const runningRecord = host.currentRecord("example-plugin");
      expect(runningRecord).toBeDefined();
      const dataBundle = await readFile(liveBundlePath(fixture, "example-plugin"));
      const stateRoot = pluginStateRoot(
        pluginDataDir(fixture.stateDir, fixture.workspaceRoot),
        "example-plugin",
      );
      await mkdir(stateRoot, { recursive: true });
      await writeFile(join(stateRoot, "new-session.json"), "new state\n");

      const stale = await pipeline.uninstall(
        "example-plugin",
        "example-plugin",
        sourceless.confirmationToken,
      );

      expect(stale).toMatchObject({
        ok: false,
        error: { stage: "uninstall", code: "confirmation-stale" },
      });
      expect(host.currentRecord("example-plugin")).toBe(runningRecord);
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();
      expect(await readFile(liveBundlePath(fixture, "example-plugin")))
        .toEqual(dataBundle);
      expect(await readFile(join(stateRoot, "new-session.json"), "utf8"))
        .toBe("new state\n");
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]).toBeDefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("holds a change that lands between reconcile's verify pass and the build's own snapshot", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const newHost = () =>
      new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });

    // Session 1: a normal install records the approval.
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(newHost()),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });
    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
    } finally {
      await pipeline.dispose();
    }
    const approvedState = await readPluginLocalState(
      fixture.stateDir,
      fixture.workspaceRoot,
    );
    if (!approvedState.ok) throw new Error(approvedState.warning);
    const approvedHash = approvedState.state.plugins["example-plugin"]?.approvedHash;
    expect(approvedHash).toEqual(expect.any(String));

    // Session 2: the startup reconcile verifies the approved source
    // (snapshot 1) and then rebuilds it (snapshot 2). The interloper lands
    // exactly between the two.
    let snapshotCalls = 0;
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(newHost()),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        snapshot: async (input) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await writeFile(fixture.entryPath, [
              'export const marker = "window-interloper";',
              "export default { activate() {} };",
              "",
            ].join("\n"));
          }
          return snapshotPluginSource(input);
        },
      },
    });
    try {
      await pipeline.start();
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "The change inside reconcile's build window was not held for approval.",
      );
      // The interloper was neither recorded as approved nor executed.
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]?.approvedHash).toBe(approvedHash);
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .not.toContain("window-interloper");
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("holds a change that lands between enable's verify pass and the rebuild's own snapshot", async () => {
    const fixture = await createPluginWorkspace();
    let armed = false;
    let armedSnapshots = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        snapshot: async (input) => {
          if (armed) {
            armedSnapshots += 1;
            // Call 1 is enable's verify pass; call 2 is the rebuild's own
            // snapshot. The interloper lands exactly between.
            if (armedSnapshots === 2) {
              await writeFile(fixture.entryPath, [
                'export const marker = "window-interloper";',
                "export default { activate() {} };",
                "",
              ].join("\n"));
            }
          }
          return snapshotPluginSource(input);
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const approvedState = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!approvedState.ok) throw new Error(approvedState.warning);
      const approvedHash =
        approvedState.state.plugins["example-plugin"]?.approvedHash;

      const disabledResult = await pipeline.disable("example-plugin");
      expect(disabledResult.ok).toBe(true);
      // The built bundle is tampered while the plugin is off, so enable's
      // bundle check fails and it has to rebuild from the verified source.
      await writeFile(
        liveBundlePath(fixture, "example-plugin"),
        "globalThis.tampered = true;\n",
      );

      armed = true;
      const enabled = await pipeline.enable("example-plugin");
      expect(enabled.ok).toBe(true);
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled-pending-approval",
        disabledReason: "approval",
      });
      // The interloper was neither recorded as approved nor built.
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]?.approvedHash).toBe(approvedHash);
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .toBe("globalThis.tampered = true;\n");
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("bounds a noisy candidate's diagnostics so the plugin list and its status events stay inside the IPC schema", async () => {
    const fixture = await createPluginWorkspace();
    const noisy: InstalledPluginRecord = {
      id: "noisy-plugin",
      directoryName: "noisy-plugin",
      rootPath: join(fixture.workspaceRoot, "plugins", "noisy-plugin"),
      manifest: null,
      iconPath: null,
      valid: false,
      diagnostics: Array.from(
        { length: 400 },
        (_, index) => `manifest problem ${index}: ${"x".repeat(40)}`,
      ),
      supersededPluginId: null,
    };
    // An installed record for the noisy candidate, so its seeded status —
    // the payload the status emit crosses IPC with — carries the error too.
    await mutatePluginRecord(
      fixture.stateDir,
      fixture.workspaceRoot,
      "noisy-plugin",
      () => ({
        disabled: false,
        approvedHash: "ab".repeat(32),
        installedBaselineHash: "ab".repeat(32),
        directoryName: "noisy-plugin",
      }),
    );
    const events: PluginPipelineStatusEvent[] = [];
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      onStatusChange: (event) => events.push(event),
      operations: {
        discover: async () => [noisy],
      },
    });

    try {
      await pipeline.start();
      await waitFor(
        () => events.some((event) =>
          event.kind === "changed" && event.plugin.id === "noisy-plugin"
        ),
        "The noisy plugin status event was not delivered.",
      );

      const row = pipeline.list().find((entry) => entry.id === "noisy-plugin");
      expect(row?.error?.message).toContain("characters elided");
      expect(row?.error?.message).toContain(
        "this message is capped at 8000 characters.",
      );
      expect(row?.error?.message.length ?? 0).toBeLessThanOrEqual(8_000);
      // The production oracle: the bridge schema every listed record and
      // every status event must pass to cross IPC at all.
      const parsedRow = PluginStatusRecord.safeParse(row);
      expect(parsedRow.success, parsedRow.error?.message).toBe(true);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        const parsed = PluginStatusChangedEvent.safeParse({
          workspaceId: "workspace-a",
          ...event,
        });
        expect(parsed.success, parsed.error?.message).toBe(true);
      }
    } finally {
      await pipeline.dispose();
    }
  });

  it("compares the newest door write's hash when a second write lands while the refresh is queued", async () => {
    const fixture = await createPluginWorkspace();
    const installGate = deferred();
    let installCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: async (input) => {
          installCalls += 1;
          // approve()'s install call blocks, occupying this plugin's job
          // queue so both door writes land while the refresh is queued.
          if (installCalls === 2) await installGate.promise;
          return installPluginDependencies({ ...input, forkProcess: nodeForkProcess });
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const originalHash = pipeline.list()[0]?.approvedHash;

      const approvePromise = pipeline.approve("example-plugin");
      await waitFor(() => installCalls === 2, "approve() never reached the gated install.");

      // A routine multi-file agent edit: two door writes in quick
      // succession. The dedup drops the second notification's queue entry,
      // and the surviving refresh must still see the newest recorded delta
      // — the tree that contains both writes.
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-one";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-two";',
        "export default { activate() {} };",
        "",
      ].join("\n"));

      installGate.resolve();
      const approved = await approvePromise;
      expect(approved.ok).toBe(true);

      // Every byte arrived through the door, so the single surviving
      // refresh auto-approves the combined tree and the plugin runs.
      await waitFor(
        () => {
          const row = pipeline.list()[0];
          return row?.status === "ready" && row.approvedHash !== originalHash;
        },
        "The combined door-written tree was not auto-approved.",
        60_000,
      );
      expect(pipeline.list()[0]?.disabledReason).toBeNull();
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .toContain("door-two");
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("brings a plugin back from an approval hold without a user-disable label once its door writes settle", async () => {
    const fixture = await createPluginWorkspace();
    const installGate = deferred();
    let installCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: async (input) => {
          installCalls += 1;
          if (installCalls === 2) await installGate.promise;
          return installPluginDependencies({ ...input, forkProcess: nodeForkProcess });
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // A disk-only write races the door write, so the refresh holds for approval.
      const approvePromise = pipeline.approve("example-plugin");
      await waitFor(() => installCalls === 2, "approve() never reached the gated install.");
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-held";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await writeFile(fixture.entryPath, [
        'export const marker = "disk-only-interloper";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      installGate.resolve();
      const approved = await approvePromise;
      expect(approved.ok).toBe(true);
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "The interloper was not held for approval.",
        60_000,
      );
      expect(pipeline.list()[0]?.disabledReason).toBe("approval");

      // Then: the agent's next door write matches the live tree exactly.
      // The hold's disabled bit came from the approval path, not the user,
      // so the plugin must come back running — not stay stopped under a
      // "user" label the user never chose.
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-fixed";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        `The settled door write did not bring the plugin back; status is ` +
          `"${pipeline.list()[0]?.status}" ` +
          `(disabledReason "${pipeline.list()[0]?.disabledReason}").`,
        60_000,
      );
      expect(pipeline.list()[0]?.disabledReason).toBeNull();
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]?.disabled).toBe(false);
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .toContain("door-fixed");
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("holds ambient bytes already on disk when a door write lands, instead of folding them into its approval", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const approvedHash = pipeline.list()[0]?.approvedHash;

      // A watcher-class change — a git checkout, a mirror delivery — that
      // is already on disk when the door write arrives. Nothing raced: the
      // door write is simply not the author of these bytes.
      await writeFile(fixture.entryPath, [
        'export const marker = "ambient-interloper";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await doorWrite(
        pipeline,
        "example-plugin",
        join(fixture.pluginRoot, "src", "extra.ts"),
        'export const doorAuthored = true;\n',
      );

      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        `The ambient bytes were not held for approval; status is ` +
          `"${pipeline.list()[0]?.status}".`,
        60_000,
      );
      // The interloper's bytes were never approved, recorded, or built.
      expect(pipeline.list()[0]?.approvedHash).toBe(approvedHash);
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]?.approvedHash).toBe(approvedHash);
      expect(state.state.plugins["example-plugin"]?.installedBaselineHash)
        .toBe(approvedHash);
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .not.toContain("ambient-interloper");
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("keeps holding while an interloper file survives door writes, and releases once the tree is baseline plus door deltas", async () => {
    const fixture = await createPluginWorkspace();
    let snapshotCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        snapshot: async (input) => {
          snapshotCalls += 1;
          return snapshotPluginSource(input);
        },
      },
    });
    const interloperPath = join(fixture.pluginRoot, "src", "evil.ts");

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // An interloper FILE lands out of band and the watcher holds it.
      await writeFile(interloperPath, "globalThis.evil = true;\n");
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/evil.ts",
        operation: "create",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "The interloper file was not held for approval.",
        60_000,
      );

      // A later door write that does not remove the interloper. The door
      // cannot delete (the SDK write surface has no delete), so the
      // interloper file survives — and it must keep the hold: under the
      // whole-tree door hash it rode this write straight to approval.
      const refreshesBefore = snapshotCalls;
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-progress";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await waitFor(
        () => snapshotCalls > refreshesBefore,
        "The door write's refresh never ran.",
        60_000,
      );
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        `The surviving interloper did not keep the hold; status is ` +
          `"${pipeline.list()[0]?.status}".`,
        60_000,
      );
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .not.toContain("door-progress");

      // The interloper is removed out of band; the tree now equals the
      // approved baseline plus the accumulated door deltas, so the next
      // door write's refresh releases the hold and the plugin runs.
      await rm(interloperPath);
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-final";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        `The restored tree did not release the hold; status is ` +
          `"${pipeline.list()[0]?.status}" ` +
          `(disabledReason "${pipeline.list()[0]?.disabledReason}").`,
        60_000,
      );
      expect(pipeline.list()[0]?.disabledReason).toBeNull();
      const bundle = await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      );
      expect(bundle).toContain("door-final");
      expect(bundle).not.toContain("evil");

      // Finally: an interloper overwrites a file and a door write restores
      // its exact approved bytes. The live tree then equals the approved
      // hash itself, and the hold — written by the approval path, never
      // the user — releases through the same predicate.
      const approvedText = [
        'export const marker = "door-final";',
        "export default { activate() {} };",
        "",
      ].join("\n");
      await writeFile(fixture.entryPath, [
        'export const marker = "second-interloper";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "The second interloper was not held for approval.",
        60_000,
      );
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, approvedText);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        `The door-restored approved bytes did not release the hold; status ` +
          `is "${pipeline.list()[0]?.status}" ` +
          `(disabledReason "${pipeline.list()[0]?.disabledReason}").`,
        60_000,
      );
      expect(pipeline.list()[0]?.disabledReason).toBeNull();
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("builds a door-write sequence whose second refresh was deduped behind a queued watcher reconcile", async () => {
    const fixture = await createPluginWorkspace();
    const installGate = deferred();
    let installCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: async (input) => {
          installCalls += 1;
          // The first door write's own rebuild blocks here, occupying the
          // queue while the watcher reconcile and the second door write
          // arrive.
          if (installCalls === 2) await installGate.promise;
          return installPluginDependencies({ ...input, forkProcess: nodeForkProcess });
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // Door write 1: its refresh starts building and blocks at install.
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-one";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await waitFor(() => installCalls === 2, "The first door rebuild never started.");

      // The watcher observes door write 1's own disk change and queues a
      // reconcile behind the running job. Awaiting the batch is what makes
      // the dedup below the thing under test: the reconcile holds the one
      // refresh slot before door write 2 asks for it.
      await pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);

      // Door write 2: its refresh notification is dropped by the dedup —
      // the watcher reconcile already holds the queue slot. The surviving
      // reconcile must still take the door path: every deviation from the
      // baseline arrived through the door.
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-two";',
        "export default { activate() {} };",
        "",
      ].join("\n"));

      installGate.resolve();
      // Door write 1's own rebuild publishes its door-one tree first, and the
      // plugin passes back through "ready" there while the surviving
      // reconcile is still queued. The sequence has settled only once that
      // reconcile's own rebuild — the third install — has finished.
      await waitFor(
        () => {
          const row = pipeline.list()[0];
          return installCalls === 3 && row?.status === "ready" &&
            row.disabledReason === null;
        },
        () =>
          `The deduped door sequence did not end ready; status is ` +
          `"${pipeline.list()[0]?.status}" ` +
          `(disabledReason "${pipeline.list()[0]?.disabledReason}") ` +
          `after ${installCalls} installs.`,
        120_000,
      );
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .toContain("door-two");
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("bounds a drifted snapshot manifest's diagnostics so the failure crosses the bridge schema", async () => {
    const fixture = await createPluginWorkspace();
    // Every field bound is respected — 100 panels is the declared maximum —
    // yet each empty panel entry yields several parse issues, so the joined
    // diagnostics far exceed the bridge's 10,000-character message cap.
    const noisyManifest = `${JSON.stringify({
      version: 1,
      name: "example-plugin",
      entry: "src/index.ts",
      panels: Array.from({ length: 100 }, () => ({})),
    })}\n`;
    let corruptNextSnapshot = false;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        // The manifest drifts inside the snapshot window — the same window
        // an agent's partial write hits routinely.
        snapshot: async (input) => {
          const result = await snapshotPluginSource(input);
          if (result.ok && corruptNextSnapshot) {
            corruptNextSnapshot = false;
            await writeFile(
              join(result.snapshotRoot, "dohc-plugin.json"),
              noisyManifest,
            );
          }
          return result;
        },
      },
    });

    try {
      await pipeline.start();
      corruptNextSnapshot = true;
      const installed = await pipeline.install("example-plugin");
      expect(installed.ok).toBe(false);
      if (installed.ok) throw new Error("unreachable");
      expect(installed.error.code).toBe("invalid-manifest");
      expect(installed.error.message.length).toBeLessThanOrEqual(8_000);
      expect(installed.error.message).toContain("characters elided");
      expect(installed.error.message).toContain(
        "this message is capped at 8000 characters.",
      );
      // The production oracles: the bridge schemas the action result and
      // every listed row must pass to cross IPC at all.
      const parsedAction = PluginActionResult.safeParse(installed);
      expect(parsedAction.success, parsedAction.error?.message).toBe(true);
      for (const row of pipeline.list()) {
        const parsedRow = PluginStatusRecord.safeParse(row);
        expect(parsedRow.success, parsedRow.error?.message).toBe(true);
      }
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("reconciles a scoped plugin in a differently named directory when its manifest returns", async () => {
    const fixture = await createPluginWorkspace({
      directoryName: "foo",
      pluginId: "@scope/bar",
      displayName: "@scope/bar",
    });
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("@scope/bar");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const manifestPath = join(fixture.pluginRoot, "dohc-plugin.json");
      const manifestText = await readFile(manifestPath, "utf8");

      await writeFile(manifestPath, "{ half written\n");
      pipeline.handleWatcherEvents([{
        path: "plugins/foo/dohc-plugin.json",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "invalid",
        "The broken manifest never landed as an invalid row.",
      );

      // While the manifest was broken, discovery knew this root only by its
      // fallback id "foo" — not "@scope/bar". Restoring the manifest has to
      // reconcile through the root the two identities share, or the plugin
      // never returns to running.
      await writeFile(manifestPath, manifestText);
      pipeline.handleWatcherEvents([{
        path: "plugins/foo/dohc-plugin.json",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The restored manifest did not return the scoped plugin to ready.",
        60_000,
      );
      expect(pipeline.list()[0]).toMatchObject({
        id: "@scope/bar",
        directoryName: "foo",
        valid: true,
      });
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("refuses uninstall preflight when the source root cannot be inspected", async () => {
    const fixture = await createPluginWorkspace();
    let epermArmed = false;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        inspectPath: (async (path: string | Buffer | URL) => {
          // A locked plugin root on Windows: lstat fails with EPERM, which
          // is not "the tree is gone".
          if (epermArmed && resolve(String(path)) === resolve(fixture.pluginRoot)) {
            const error = new Error(
              "EPERM: operation not permitted, lstat",
            ) as NodeJS.ErrnoException;
            error.code = "EPERM";
            throw error;
          }
          return lstat(path);
        }) as typeof lstat,
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      epermArmed = true;
      const preflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      expect(preflight.ok).toBe(false);
      if (preflight.ok) throw new Error("unreachable");
      expect(preflight.error.message).toContain("could not be inspected");
      // Nothing was decided, so nothing was dropped: the record, the source
      // tree, and the plugin data are all still there.
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]?.approvedHash).toEqual(
        expect.any(String),
      );
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();

      // Once the root is inspectable again, the same uninstall proceeds.
      epermArmed = false;
      const retry = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      expect(retry.ok).toBe(true);
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("stops the old runtime before it publishes, and refuses a bundle swapped after publication", async () => {
    const fixture = await createPluginWorkspace();
    let tamperOnPublish = false;
    const order: string[] = [];
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    const realStop = host.stop.bind(host);
    vi.spyOn(host, "stop").mockImplementation(async (pluginId: string) => {
      order.push("stop");
      await realStop(pluginId);
    });
    const startSpy = vi.spyOn(host, "start");
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        snapshot: async (input) => {
          const snapshot = await snapshotPluginSource(input);
          if (!snapshot.ok) return snapshot;
          return {
            ...snapshot,
            publish: async () => {
              // The live source tree is as reachable by a running plugin as
              // the bundle is, so the stop has to precede this publish too,
              // not just the bundle's.
              order.push("snapshot-publish");
              return snapshot.publish();
            },
          };
        },
        build: async (input) => {
          const built = await buildPluginBundle(input);
          if (!built.ok) return built;
          return {
            ...built,
            publish: async () => {
              const published = await built.publish();
              order.push("publish");
              // The still-running full-trust host knows its own live root, so
              // this is the window it could overwrite the published bundle in.
              if (tamperOnPublish) {
                await writeFile(
                  join(built.liveRoot, "bundle.mjs"),
                  "globalThis.unapproved = true;\n",
                );
              }
              return published;
            },
          };
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const startsAfterInstall = startSpy.mock.calls.length;

      order.length = 0;
      tamperOnPublish = true;
      const rebuilt = await pipeline.install("example-plugin");

      // Stop the runtime before publishing either the snapshot or the bundle.
      // Checking only bundle publication would allow the stop between publishes.
      expect(order).toEqual(["stop", "snapshot-publish", "publish"]);
      // The published bytes are not the bytes the record just approved, so
      // the start is refused and they never execute.
      expect(rebuilt.ok).toBe(false);
      if (rebuilt.ok) throw new Error("unreachable");
      expect(rebuilt.error).toMatchObject({
        stage: "build",
        code: "bundle-changed",
      });
      expect(startSpy.mock.calls.length).toBe(startsAfterInstall);
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .toBe("globalThis.unapproved = true;\n");
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("keeps a crash-loop disabled plugin disabled through a watcher event that changes nothing", async () => {
    const fixture = await createPluginWorkspace();
    let snapshotCalls = 0;
    let installCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      // Every activation fails immediately, so the host's own crash-loop
      // accounting reaches its threshold and writes the real disabled record.
      spawnTransport: vi.fn<PluginHostOptions["spawnTransport"]>(() => ({
        request: async <T = unknown>(method: string): Promise<T> => {
          if (method === "plugin.activate") {
            throw new Error("plugin activation failed");
          }
          return {} as T;
        },
        notify: () => undefined,
        dispose: async () => undefined,
      })),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    const resetCrashAccounting = vi.spyOn(host, "resetCrashAccounting");
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) => {
          installCalls += 1;
          return installPluginDependencies({ ...input, forkProcess: nodeForkProcess });
        },
        snapshot: async (input) => {
          snapshotCalls += 1;
          return snapshotPluginSource(input);
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.disabledReason === "crash-loop",
        `The plugin never crash-loop disabled; status is ` +
          `"${pipeline.list()[0]?.status}".`,
        60_000,
      );
      const disabledState = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      expect(disabledState.ok && disabledState.state.plugins["example-plugin"]?.disabled)
        .toBe(true);

      const snapshotsBefore = snapshotCalls;
      const installsBefore = installCalls;
      resetCrashAccounting.mockClear();

      // Churn under the plugin root that leaves the source hash exactly where
      // it was — a metadata touch, a node_modules write. Nothing about the
      // crash loop is fixed, so nothing may rebuild, restart, or forgive the
      // failures already counted.
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);
      await waitFor(
        () => snapshotCalls > snapshotsBefore,
        "The watcher reconcile never ran.",
        60_000,
      );
      // Wait for the reconcile to settle, not a fixed delay: under load the
      // no-op reconcile is still mid-flight ("snapshotting") long after its
      // snapshot started. A wrong re-enable never returns to "disabled" and
      // times out here; a wrong rebuild is caught by the counters below.
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled",
        () =>
          `The reconcile never settled back to disabled; status is ` +
          `"${pipeline.list()[0]?.status}".`,
        60_000,
      );

      const row = pipeline.list()[0];
      expect(row?.status).toBe("disabled");
      expect(row?.disabledReason).toBe("crash-loop");
      // A rebuild would take its own second snapshot and install again.
      expect(snapshotCalls).toBe(snapshotsBefore + 1);
      expect(installCalls).toBe(installsBefore);
      expect(resetCrashAccounting).not.toHaveBeenCalled();
      const afterState = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      expect(afterState.ok && afterState.state.plugins["example-plugin"]?.disabled)
        .toBe(true);
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("retires a crash-loop-disabled host record before enabling its replacement", async () => {
    const fixture = await createPluginWorkspace();
    const exits: Array<() => void> = [];
    let pipeline: PluginPipeline;
    const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>((params) => {
      const attempt = exits.length + 1;
      exits.push(() => params.onExit({ code: 1, signal: null }));
      return {
        request: async <T = unknown>(method: string): Promise<T> => {
          if (method === PLUGIN_HOST_METHODS.activate && attempt <= 3) {
            throw new Error(`plugin activation failed ${attempt}`);
          }
          return (method === PLUGIN_HOST_METHODS.activate
            ? { commands: [], drivers: [] }
            : {}) as T;
        },
        notify: () => undefined,
        dispose: async () => undefined,
      };
    });
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport,
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.disabledReason === "crash-loop",
        "The plugin never crash-loop disabled.",
        60_000,
      );
      const disabledRecord = host.currentRecord("example-plugin");
      expect(disabledRecord).toBeDefined();
      expect(host.getStatus("example-plugin")).toBe("disabled");
      expect(spawnTransport).toHaveBeenCalledTimes(3);
      const disabledState = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      expect(disabledState.ok && disabledState.state.plugins["example-plugin"]?.disabled)
        .toBe(true);

      const enabled = await pipeline.enable("example-plugin");
      expect(enabled.ok).toBe(true);
      const replacementRecord = host.currentRecord("example-plugin");
      expect(replacementRecord).toBeDefined();
      expect(replacementRecord).not.toBe(disabledRecord);
      expect(spawnTransport).toHaveBeenCalledTimes(4);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        () => `The enabled plugin stayed "${pipeline.list()[0]?.status}".`,
        60_000,
      );

      const enabledState = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      expect(enabledState.ok && enabledState.state.plugins["example-plugin"]?.disabled)
        .toBe(false);

      for (const exit of exits.slice(0, 3)) exit();
      await Promise.resolve();
      await Promise.resolve();
      expect(host.currentRecord("example-plugin")).toBe(replacementRecord);
      expect(host.getStatus("example-plugin")).toBe("ready");
      expect(pipeline.list()[0]?.status).toBe("ready");
      expect(spawnTransport).toHaveBeenCalledTimes(4);

      exits[3]!();
      await waitFor(
        () => spawnTransport.mock.calls.length === 5 &&
          pipeline.list()[0]?.status === "ready",
        "The replacement did not respawn after its first crash.",
        60_000,
      );
      expect(host.currentRecord("example-plugin")).toBe(replacementRecord);
      expect(host.getStatus("example-plugin")).toBe("ready");
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("retires an inert crash-loop record when disabled-state persistence fails before enabling its replacement", async () => {
    const fixture = await createPluginWorkspace();
    const exits: Array<() => void> = [];
    let pipeline: PluginPipeline;
    const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>((params) => {
      exits.push(() => params.onExit({ code: 1, signal: null }));
      return {
        request: async <T = unknown>(method: string): Promise<T> => {
          return (method === PLUGIN_HOST_METHODS.activate
            ? { commands: [], drivers: [] }
            : {}) as T;
        },
        notify: () => undefined,
        dispose: async () => undefined,
      };
    });
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport,
      routeSdkRequest: async () => ({}),
      mutatePluginRecord: async () => {
        throw new Error("simulated disabled-state write failure");
      },
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The installed plugin did not start.",
      );
      for (let crash = 0; crash < 2; crash += 1) {
        exits[crash]!();
        await waitFor(
          () =>
            spawnTransport.mock.calls.length === crash + 2 &&
            pipeline.list()[0]?.status === "ready",
          `The plugin did not recover from crash ${crash + 1}.`,
        );
      }
      exits[2]!();
      await waitFor(
        () =>
          spawnTransport.mock.calls.length === 3 &&
          host.getSpawnId("example-plugin") === undefined &&
          pipeline.list()[0]?.status === "crashed",
        () =>
          `The failed crash-loop persistence did not leave the expected inert record; ` +
          `spawns=${spawnTransport.mock.calls.length}, ` +
          `status="${pipeline.list()[0]?.status}".`,
        60_000,
      );
      const inertRecord = host.currentRecord("example-plugin");
      expect(inertRecord).toBeDefined();
      expect(host.hasLiveSpawn("example-plugin")).toBe(false);
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      expect(
        state.ok && state.state.plugins["example-plugin"]?.disabled,
      ).toBe(false);

      const enabled = await pipeline.enable("example-plugin");
      expect(enabled.ok).toBe(true);
      expect(host.currentRecord("example-plugin")).not.toBe(inertRecord);
      expect(host.getSpawnId("example-plugin")).toBeDefined();
      expect(spawnTransport).toHaveBeenCalledTimes(4);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        () => `The enabled plugin stayed "${pipeline.list()[0]?.status}".`,
        60_000,
      );
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("carries every declared contribution across the bridge, so a plugin's views and web apps reach the renderer", async () => {
    const fixture = await createPluginWorkspace();
    await writeFile(join(fixture.pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1,
      name: "example-plugin",
      entry: "src/index.ts",
      panels: [
        { id: "main", title: "Main", entry: "panel/index.html" },
        {
          id: "sites",
          title: "Sites",
          entry: "panel/sites.html",
          placement: "view",
          icon: "icon.svg",
        },
      ],
      webApps: [{ id: "preview", title: "Preview", instanced: true }],
    }, null, 2)}\n`);
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();
      const listed = pipeline.list();

      // The production oracle: main.ts's listPlugins handler parses exactly
      // this. A contribution the pipeline drops fails the whole list here,
      // taking every plugin's row down with it.
      const parsed = ListPluginsResult.safeParse({ ok: true, plugins: listed });
      expect(parsed.success, parsed.error?.message).toBe(true);

      expect(listed[0]?.panels).toEqual([
        { id: "main", title: "Main", placement: "editor", icon: null },
        { id: "sites", title: "Sites", placement: "view", icon: "icon.svg" },
      ]);
      expect(listed[0]?.webApps).toEqual([
        { id: "preview", title: "Preview", instanced: true },
      ]);
    } finally {
      await pipeline.dispose();
    }
  });

  it("bounds an enormous manifest diagnostic so the whole plugin list still crosses the bridge", async () => {
    const fixture = await createPluginWorkspace();
    // A hostile dohc-plugin.json: every declared field is valid and the file
    // is far under the manifest reader's 256 KiB cap, but one unrecognized
    // key carries its whole name into the strict-object diagnostic.
    await writeFile(join(fixture.pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1,
      name: "example-plugin",
      entry: "src/index.ts",
      [`k${"x".repeat(10_100)}`]: 1,
    })}\n`);
    const seededRoot = join(fixture.workspaceRoot, "plugins", "seeded-plugin");
    await mkdir(join(seededRoot, "src"), { recursive: true });
    await writeFile(join(seededRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1,
      name: "seeded-plugin",
      entry: "src/index.ts",
      [`k${"x".repeat(30_000)}`]: 1,
    })}\n`);
    // An installed record for the second root, so its status is seeded and
    // emitted rather than listed straight from the discovery candidate: both
    // ways a diagnostic reaches a status record are covered.
    await mutatePluginRecord(
      fixture.stateDir,
      fixture.workspaceRoot,
      "seeded-plugin",
      () => ({
        disabled: false,
        approvedHash: "ab".repeat(32),
        installedBaselineHash: "ab".repeat(32),
        directoryName: "seeded-plugin",
      }),
    );
    const events: PluginPipelineStatusEvent[] = [];
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      onStatusChange: (event) => events.push(event),
    });

    try {
      await pipeline.start();
      await waitFor(
        () => events.some((event) =>
          event.kind === "changed" && event.plugin.id === "seeded-plugin"
        ),
        "The seeded plugin diagnostic status event was not delivered.",
      );

      const listed = pipeline.list();
      expect(listed).toHaveLength(2);
      for (const row of listed) {
        expect(row.diagnostics.some((line) => line.includes("characters elided")))
          .toBe(true);
        for (const line of row.diagnostics) {
          expect(line.length).toBeLessThanOrEqual(8_000);
        }
      }
      // The production oracle: main.ts's listPlugins handler parses exactly
      // this, and one over-cap entry denied the whole Plugins section —
      // including every other plugin's Disable and Uninstall.
      const parsed = ListPluginsResult.safeParse({ ok: true, plugins: listed });
      expect(parsed.success, parsed.error?.message).toBe(true);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        const parsedEvent = PluginStatusChangedEvent.safeParse({
          workspaceId: "workspace-a",
          ...event,
        });
        expect(parsedEvent.success, parsedEvent.error?.message).toBe(true);
      }
    } finally {
      await pipeline.dispose();
    }
  });

  it("bounds an enormous lifecycle warning so the plugin list still crosses the bridge", async () => {
    const fixture = await createPluginWorkspace();
    // A package version is free text. This one is valid semver build
    // metadata, so the pinned pnpm installs it, and 20,000 characters long,
    // so the scan's allowed-hook warning line carries all of it.
    await writeFile(join(fixture.pluginRoot, "package.json"), `${JSON.stringify({
      name: "example-plugin",
      version: `1.0.0+${"x".repeat(20_000)}`,
      private: true,
      type: "module",
      packageManager: "pnpm@11.20.0",
      scripts: { postinstall: "node --version" },
    }, null, 2)}\n`);
    await writeFile(join(fixture.pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1,
      name: "example-plugin",
      displayName: "Example plugin",
      entry: "src/index.ts",
      allowSkippedScripts: ["example-plugin"],
    }, null, 2)}\n`);
    const events: PluginPipelineStatusEvent[] = [];
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      onStatusChange: (event) => events.push(event),
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      const row = pipeline.list()[0];
      expect(row?.warnings.some((line) => line.includes("characters elided")))
        .toBe(true);
      for (const line of row?.warnings ?? []) {
        expect(line.length).toBeLessThanOrEqual(8_000);
      }
      const parsed = ListPluginsResult.safeParse({
        ok: true,
        plugins: pipeline.list(),
      });
      expect(parsed.success, parsed.error?.message).toBe(true);
      for (const event of events) {
        const parsedEvent = PluginStatusChangedEvent.safeParse({
          workspaceId: "workspace-a",
          ...event,
        });
        expect(parsedEvent.success, parsedEvent.error?.message).toBe(true);
      }
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("never auto-approves a door write against a baseline it cannot prove", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });
    const baselinePath = pluginBaselineManifestPath(
      pluginDataDir(fixture.stateDir, fixture.workspaceRoot),
      "example-plugin",
    );
    const source = (marker: string): string =>
      [
        `export const marker = "${marker}";`,
        "export default { activate() {} };",
        "",
      ].join("\n");
    /** One door write against the current baseline; it must hold, not run. */
    const expectHold = async (marker: string): Promise<void> => {
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, source(marker));
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        `The door write auto-approved against an unprovable baseline; status ` +
          `is "${pipeline.list()[0]?.status}".`,
        60_000,
      );
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .not.toContain(marker);
    };
    const approveAndRun = async (): Promise<void> => {
      const approved = await pipeline.approve("example-plugin");
      if (!approved.ok) throw new Error(approved.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The approved plugin did not come back.",
        60_000,
      );
    };

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      // The baseline of the first approved tree, kept for probe 2.
      const firstBaseline = await readFile(baselinePath, "utf8");

      // Probe 1: no baseline at all. Nothing describes the approved tree, so
      // there is no overlay to compare a door write against.
      await rm(baselinePath);
      await expectHold("probe-one");
      await approveAndRun();

      // Probe 2: a self-consistent baseline that describes an older approved
      // tree. It proves nothing about the hash recorded now.
      await writeFile(baselinePath, firstBaseline);
      await expectHold("probe-two");
      await approveAndRun();

      // Probe 3: a baseline whose file list was forged. Its own sourceHash no
      // longer re-derives from the files it claims.
      const forged = JSON.parse(await readFile(baselinePath, "utf8")) as {
        sourceHash: string;
        files: { relPath: string; sha256: string }[];
      };
      forged.files.push({ relPath: "src/ghost.ts", sha256: "cd".repeat(32) });
      await writeFile(baselinePath, `${JSON.stringify(forged, null, 2)}\n`);
      await expectHold("probe-three");
    } finally {
      await pipeline.dispose();
    }
  }, 240_000);

  it("carries the manifest's metadata through the pipeline into the IPC contract", async () => {
    const fixture = await createPluginWorkspace();
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "example-plugin",
        displayName: "Example plugin",
        description: "Does one example thing on this workspace.",
        publisher: "dohc",
        pluginVersion: "0.0.33",
        repository: "https://github.com/pingdotgg/t3code",
        issues: "https://github.com/pingdotgg/t3code/issues",
        license: "MIT",
        icon: "icon.svg",
        entry: "src/index.ts",
      }, null, 2)}\n`,
    );
    await writeFile(join(fixture.pluginRoot, "icon.svg"), "<svg/>");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();
      const listed = pipeline.list();

      expect(listed[0]).toMatchObject({
        id: "example-plugin",
        displayName: "Example plugin",
        description: "Does one example thing on this workspace.",
        publisher: "dohc",
        pluginVersion: "0.0.33",
        repository: "https://github.com/pingdotgg/t3code",
        issues: "https://github.com/pingdotgg/t3code/issues",
        license: "MIT",
        icon: "icon.svg",
      });
      // The renderer only ever sees what survives this parse, so the
      // contract's bounds are part of the plumbing, not a separate check.
      const parsed = ListPluginsResult.safeParse({ ok: true, plugins: listed });
      if (!parsed.success) throw new Error(parsed.error.message);
      expect(parsed.data.ok && parsed.data.plugins[0]?.publisher).toBe("dohc");
      expect(parsed.data.ok && parsed.data.plugins[0]?.pluginVersion)
        .toBe("0.0.33");
      expect(parsed.data.ok && parsed.data.plugins[0]?.repository)
        .toBe("https://github.com/pingdotgg/t3code");
      expect(parsed.data.ok && parsed.data.plugins[0]?.license).toBe("MIT");
    } finally {
      await pipeline.dispose();
    }
  });

  it("saves a setting and tells the plugin's host what its settings became", async () => {
    const fixture = await createPluginWorkspace();
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "example-plugin",
        entry: "src/index.ts",
        settings: [
          {
            key: "greeting",
            type: "string",
            label: "Greeting",
            default: "Hello",
          },
          { key: "shout", type: "boolean", label: "Shout", default: false },
        ],
      }, null, 2)}\n`,
    );

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    const told = vi.spyOn(host, "notifySettingsChanged");
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();

      const values = await pipeline.setPluginSettings("example-plugin", "example-plugin", {
        greeting: "Hei",
      });

      // Every declared setting under the one answer the user changed: a
      // plugin hears what its settings are, never the patch.
      expect(values).toEqual({ greeting: "Hei", shout: false });
      expect(told).toHaveBeenCalledWith("example-plugin", "example-plugin", values);
      // Saved, not only announced.
      expect(await pipeline.getPluginSettings("example-plugin")).toEqual(values);
    } finally {
      await pipeline.dispose();
    }
  });

  it("advertises no icon, and says why, when the declared file is missing", async () => {
    const fixture = await createPluginWorkspace();
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "example-plugin",
        icon: "icon.svg",
        entry: "src/index.ts",
      }, null, 2)}\n`,
    );

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      isEngineCaptureAvailable: () => true,
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();
      const listed = pipeline.list();

      expect(listed[0]?.icon).toBeNull();
      expect(listed[0]?.diagnostics.join(" ")).toContain("could not be read");
      // A broken icon is not a broken plugin.
      expect(listed[0]?.valid).toBe(true);
      expect(listed[0]?.status).toBe("discovered");
    } finally {
      await pipeline.dispose();
    }
  });
});
