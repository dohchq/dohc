import type { WatcherEvent } from "@dohc/workspace-core";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { JsonRpcTransport } from "../agents/JsonRpcTransport";
import type { CreatedWorkspace } from "../workspaces/createWorkspaceFolder";
import { createTestScratch } from "../workspaces/testTemp";
import {
  startWorkspaceWatch,
  type WorkspaceWatchHandle,
} from "../workspaces/workspaceWatcher";
import { PluginHost, type PluginHostOptions } from "./PluginHost";
import { readPluginManifestFile } from "./pluginManifest";
import { invokePluginSdkHost, type PluginSdkHostContext } from "./pluginSdkHost";
import {
  MAX_PLUGIN_FILE_WATCHES_PER_OWNER,
  PluginWorkspaceEvents,
  type PluginFileWatchEvent,
  type PluginWorkspaceEventsOwner,
} from "./pluginWorkspaceEvents";

interface Emitted {
  subscriptionId: string;
  event: string;
  data: unknown;
}

function collector(): { emitted: Emitted[]; emitEvent: (id: string, event: string, data: unknown) => void } {
  const emitted: Emitted[] = [];
  return {
    emitted,
    emitEvent: (subscriptionId, event, data) =>
      emitted.push({ subscriptionId, event, data }),
  };
}

function update(path: string, sha256?: string): WatcherEvent {
  return sha256 === undefined
    ? { path, operation: "update" }
    : { path, operation: "update", sha256 };
}

function paths(emitted: Emitted[]): string[] {
  return emitted.map((entry) => (entry.data as PluginFileWatchEvent).path);
}

function processOwner(
  pluginId: string,
  spawnId: string,
): PluginWorkspaceEventsOwner {
  return { kind: "process", pluginId, spawnId };
}

describe("PluginWorkspaceEvents", () => {
  it("applies prefix containment to a panel owner's subscription", () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    const { subscriptionId } = events.subscribe(
      {
        owner: {
          kind: "panel",
          workspaceId: "ws-plugins",
          pluginId: "sites",
          panelId: "main",
        },
        emitEvent: sink.emitEvent,
      },
      { path: "docs" },
    );

    events.handleWatcherEvents([
      update("docs/index.md", "aaa"),
      update("elsewhere/index.md", "bbb"),
    ]);

    expect(sink.emitted).toEqual([
      {
        subscriptionId,
        event: "change",
        data: { path: "docs/index.md", operation: "update", sha256: "aaa" },
      },
    ]);
  });

  it("delivers a settled change under the prefix and nothing outside it", () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    const { subscriptionId } = events.subscribe(
      { owner: processOwner("sites", "spawn-1"), emitEvent: sink.emitEvent },
      { path: "docs" },
    );

    events.handleWatcherEvents([
      update("docs/index.md", "aaa"),
      update("elsewhere/index.md", "bbb"),
      update("docs", "ccc"),
      // Segment-aware: a sibling folder whose name merely starts with the
      // prefix is not inside it.
      update("docsx/index.md", "ddd"),
    ]);

    expect(paths(sink.emitted)).toEqual(["docs/index.md", "docs"]);
    expect(sink.emitted[0]).toEqual({
      subscriptionId,
      event: "change",
      data: { path: "docs/index.md", operation: "update", sha256: "aaa" },
    });
  });

  it('watches the whole workspace under "."', () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    events.subscribe(
      { owner: processOwner("sites", "spawn-1"), emitEvent: sink.emitEvent },
      { path: "." },
    );

    events.handleWatcherEvents([update("a.md"), update("deep/nested/b.md")]);

    expect(paths(sink.emitted)).toEqual(["a.md", "deep/nested/b.md"]);
  });

  it("carries a delete without a hash, and an update with the one the feed read", () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    events.subscribe(
      { owner: processOwner("sites", "spawn-1"), emitEvent: sink.emitEvent },
      { path: "docs" },
    );

    events.handleWatcherEvents([
      { path: "docs/gone.md", operation: "delete" },
      update("docs/kept.md", "hash-1"),
      // Present but unreadable at settle: the feed reports the change with no
      // hash rather than inventing one.
      update("docs/locked.md"),
    ]);

    expect(sink.emitted.map((entry) => entry.data)).toEqual([
      { path: "docs/gone.md", operation: "delete" },
      { path: "docs/kept.md", operation: "update", sha256: "hash-1" },
      { path: "docs/locked.md", operation: "update" },
    ]);
  });

  it("refuses a prefix that escapes the workspace", () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    const context = {
      owner: processOwner("sites", "spawn-1"),
      emitEvent: sink.emitEvent,
    };

    for (const escape of [
      "../secrets",
      "docs/../../secrets",
      "/etc/passwd",
      "C:\\Windows",
      "%2e%2e/secrets",
      "..\\secrets",
    ]) {
      expect(() => events.subscribe(context, { path: escape })).toThrow();
    }
    // Nothing escaped into the registry, so nothing can be delivered.
    events.handleWatcherEvents([update("secrets/keys.txt")]);
    expect(sink.emitted).toEqual([]);
  });

  it("names the per-owner subscription cap and keeps owner budgets separate", () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    const context = {
      owner: {
        kind: "panel" as const,
        workspaceId: "ws-plugins",
        pluginId: "sites",
        panelId: "main",
      },
      emitEvent: sink.emitEvent,
    };

    for (let index = 0; index < MAX_PLUGIN_FILE_WATCHES_PER_OWNER; index += 1) {
      events.subscribe(context, { path: `docs/${index}` });
    }

    expect(() => events.subscribe(context, { path: "docs/overflow" })).toThrow(
      `Plugin "sites" panel "main" already holds ${MAX_PLUGIN_FILE_WATCHES_PER_OWNER} workspace file subscriptions. MAX_PLUGIN_FILE_WATCHES_PER_OWNER allows at most ${MAX_PLUGIN_FILE_WATCHES_PER_OWNER} open files.watch subscriptions per owner.`,
    );
    const secondOwner = {
      ...context,
      owner: { ...context.owner, panelId: "secondary" },
    };
    for (let index = 0; index < MAX_PLUGIN_FILE_WATCHES_PER_OWNER; index += 1) {
      expect(() =>
        events.subscribe(secondOwner, { path: `other/${index}` }),
      ).not.toThrow();
    }
  });

  it("stops delivering after unsubscribe, and reports ids it does not own", () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    const context = {
      owner: processOwner("sites", "spawn-1"),
      emitEvent: sink.emitEvent,
    };
    const { subscriptionId } = events.subscribe(context, { path: "docs" });

    events.handleWatcherEvents([update("docs/before.md")]);
    expect(events.unsubscribe(context, { subscriptionId })).toBe(true);
    events.handleWatcherEvents([update("docs/after.md")]);

    expect(paths(sink.emitted)).toEqual(["docs/before.md"]);
    // The broker serves the same SDK method, so an id this registry never
    // issued is passed on rather than swallowed.
    expect(events.unsubscribe(context, { subscriptionId: "broker-owned" })).toBe(false);
    expect(events.unsubscribe(context, {})).toBe(false);
  });

  it("refuses to close a subscription another spawn owns", () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    const { subscriptionId } = events.subscribe(
      { owner: processOwner("sites", "spawn-1"), emitEvent: sink.emitEvent },
      { path: "docs" },
    );

    expect(() =>
      events.unsubscribe(
        { owner: processOwner("sites", "spawn-2") },
        { subscriptionId },
      ),
    ).toThrow("another owner owns it");
    expect(() =>
      events.unsubscribe(
        { owner: processOwner("other", "spawn-1") },
        { subscriptionId },
      ),
    ).toThrow("another owner owns it");

    events.handleWatcherEvents([update("docs/still.md")]);
    expect(paths(sink.emitted)).toEqual(["docs/still.md"]);
  });

  it("drops a spawn's subscriptions when the spawn ends", () => {
    const events = new PluginWorkspaceEvents();
    const ending = collector();
    const surviving = collector();
    const panel = collector();
    events.subscribe(
      { owner: processOwner("sites", "spawn-1"), emitEvent: ending.emitEvent },
      { path: "docs" },
    );
    events.subscribe(
      {
        owner: processOwner("sites", "spawn-2"),
        emitEvent: surviving.emitEvent,
      },
      { path: "docs" },
    );
    events.subscribe(
      {
        owner: {
          kind: "panel",
          workspaceId: "ws-plugins",
          pluginId: "sites",
          panelId: "main",
        },
        emitEvent: panel.emitEvent,
      },
      { path: "docs" },
    );

    events.disposeSpawn("sites", "spawn-1");
    events.handleWatcherEvents([update("docs/after.md")]);

    expect(ending.emitted).toEqual([]);
    expect(paths(surviving.emitted)).toEqual(["docs/after.md"]);
    expect(paths(panel.emitted)).toEqual(["docs/after.md"]);
  });

  it("disposes only the exact panel owner", () => {
    const events = new PluginWorkspaceEvents();
    const process = collector();
    const panelA = collector();
    const panelB = collector();
    events.subscribe(
      {
        owner: { kind: "process", pluginId: "p", spawnId: "s" },
        emitEvent: process.emitEvent,
      },
      { path: "docs" },
    );
    events.subscribe(
      {
        owner: {
          kind: "panel",
          workspaceId: "ws-plugins",
          pluginId: "p",
          panelId: "a",
        },
        emitEvent: panelA.emitEvent,
      },
      { path: "docs" },
    );
    events.subscribe(
      {
        owner: {
          kind: "panel",
          workspaceId: "ws-plugins",
          pluginId: "p",
          panelId: "b",
        },
        emitEvent: panelB.emitEvent,
      },
      { path: "docs" },
    );

    events.disposeOwner({
      kind: "panel",
      workspaceId: "ws-plugins",
      pluginId: "p",
      panelId: "a",
    });
    events.handleWatcherEvents([update("docs/after.md")]);

    expect(panelA.emitted).toEqual([]);
    expect(paths(process.emitted)).toEqual(["docs/after.md"]);
    expect(paths(panelB.emitted)).toEqual(["docs/after.md"]);
  });

  it("delivers nothing to another workspace's plugins", () => {
    const workspaceA = new PluginWorkspaceEvents();
    const workspaceB = new PluginWorkspaceEvents();
    const inA = collector();
    const inB = collector();
    workspaceA.subscribe(
      { owner: processOwner("sites", "spawn-1"), emitEvent: inA.emitEvent },
      { path: "docs" },
    );
    workspaceB.subscribe(
      { owner: processOwner("sites", "spawn-1"), emitEvent: inB.emitEvent },
      { path: "docs" },
    );

    workspaceA.handleWatcherEvents([update("docs/only-in-a.md")]);

    expect(paths(inA.emitted)).toEqual(["docs/only-in-a.md"]);
    expect(inB.emitted).toEqual([]);
  });

  it("delivers nothing after the workspace closes", () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    events.subscribe(
      { owner: processOwner("sites", "spawn-1"), emitEvent: sink.emitEvent },
      { path: "docs" },
    );

    events.dispose();
    events.handleWatcherEvents([update("docs/after.md")]);

    expect(sink.emitted).toEqual([]);
  });

  it("lets a plugin watch its own source tree", () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    events.subscribe(
      { owner: processOwner("sites", "spawn-1"), emitEvent: sink.emitEvent },
      { path: "plugins/sites" },
    );

    events.handleWatcherEvents([
      update("plugins/sites/src/index.ts", "hash-1"),
      update("plugins/other/src/index.ts", "hash-2"),
    ]);

    // A plugin may see edits to its own source. It already reads that source
    // with files.read, and knowing it changed is how it can tell the user why
    // approval is about to hold it.
    expect(paths(sink.emitted)).toEqual(["plugins/sites/src/index.ts"]);
  });

  it("does not change the batch the approval pipeline reads", () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    events.subscribe(
      { owner: processOwner("sites", "spawn-1"), emitEvent: sink.emitEvent },
      { path: "." },
    );
    const batch: WatcherEvent[] = [
      { path: "plugins/sites/plugin.ts", operation: "update", sha256: "hash-1" },
      { path: "notes/today.md", operation: "delete" },
    ];
    const before = structuredClone(batch);

    events.handleWatcherEvents(batch);

    // The pipeline reads the same array from the same settled batch, so
    // delivery must leave every entry exactly as it found it.
    expect(batch).toEqual(before);
    expect(sink.emitted).toHaveLength(2);
  });

  it("does not deliver an operation the SDK event type cannot carry", () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    events.subscribe(
      { owner: processOwner("sites", "spawn-1"), emitEvent: sink.emitEvent },
      { path: "docs" },
    );

    events.handleWatcherEvents([
      { path: "docs/new.md", operation: "create" },
      { path: "docs/moved.md", operation: "rename", fromPath: "docs/old.md" },
      update("docs/edited.md"),
    ]);

    expect(paths(sink.emitted)).toEqual(["docs/edited.md"]);
  });
});

describe("the plugin SDK host's files.watch route", () => {
  function hostContext(overrides: Partial<PluginSdkHostContext> = {}): PluginSdkHostContext {
    return {
      pluginId: "sites",
      workspaceRoot: "C:/workspace",
      spawnId: "spawn-1",
      requestPath: "plugin-process",
      isWritable: () => true,
      writeAvailable: async () => true,
      writeAuthoredText: async (path) => ({ path }),
      ...overrides,
    };
  }

  it("refuses to open a subscription for a spawn that already ended", async () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    const ended = new AbortController();
    ended.abort();
    const context = hostContext({
      signal: ended.signal,
      subscribeFileWatch: (params) =>
        events.subscribe(
          {
            owner: processOwner("sites", "spawn-1"),
            emitEvent: sink.emitEvent,
          },
          params,
        ),
    });

    await expect(
      invokePluginSdkHost(context, "files.watch", { path: "docs" }),
    ).rejects.toMatchObject({ code: "DOHC_ABORTED" });

    // The refusal has to happen before the registry records anything: a
    // subscription outlives the call that opens it.
    events.handleWatcherEvents([update("docs/after.md")]);
    expect(sink.emitted).toEqual([]);
  });

  it("opens and advertises files.watch on the panel path", async () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    const owner: PluginWorkspaceEventsOwner = {
      kind: "panel",
      workspaceId: "ws-plugins",
      pluginId: "sites",
      panelId: "main",
    };
    const panel = hostContext({
      requestPath: "panel",
      subscribeFileWatch: (params) =>
        events.subscribe({ owner, emitEvent: sink.emitEvent }, params),
      unsubscribeFileWatch: (params) => events.unsubscribe({ owner }, params),
    });

    const capabilities = (await invokePluginSdkHost(panel, "capabilities")) as {
      files: { watch: boolean };
    };
    expect(capabilities.files.watch).toBe(true);

    const opened = (await invokePluginSdkHost(panel, "files.watch", {
      path: "docs",
    })) as { subscriptionId: string };
    expect(opened.subscriptionId.length).toBeGreaterThan(0);

    events.handleWatcherEvents([
      update("docs/index.md", "aaa"),
      update("elsewhere/index.md", "bbb"),
    ]);
    expect(sink.emitted).toEqual([
      {
        subscriptionId: opened.subscriptionId,
        event: "change",
        data: { path: "docs/index.md", operation: "update", sha256: "aaa" },
      },
    ]);
  });

  it("advertises files.watch on the plugin's own process path", async () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    const capabilities = (await invokePluginSdkHost(
      hostContext({
        subscribeFileWatch: (params) =>
          events.subscribe(
            {
              owner: processOwner("sites", "spawn-1"),
              emitEvent: sink.emitEvent,
            },
            params,
          ),
      }),
      "capabilities",
    )) as { files: { watch: boolean } };

    expect(capabilities.files.watch).toBe(true);
  });

  it("closes a file subscription through the shared unsubscribe method", async () => {
    const events = new PluginWorkspaceEvents();
    const sink = collector();
    const context = hostContext({
      subscribeFileWatch: (params) =>
        events.subscribe(
          {
            owner: processOwner("sites", "spawn-1"),
            emitEvent: sink.emitEvent,
          },
          params,
        ),
      unsubscribeFileWatch: (params) =>
        events.unsubscribe({ owner: processOwner("sites", "spawn-1") }, params),
      // A broker that would answer any id, so a file subscription left to it
      // would look closed while it kept delivering.
      invokeChildProcess: async () => ({}),
    });
    const opened = (await invokePluginSdkHost(context, "files.watch", {
      path: "docs",
    })) as { subscriptionId: string };

    await invokePluginSdkHost(context, "subscriptions.unsubscribe", {
      subscriptionId: opened.subscriptionId,
    });
    events.handleWatcherEvents([update("docs/after.md")]);

    expect(sink.emitted).toEqual([]);
  });
});

const pluginHostProcessPath = fileURLToPath(
  new URL("./pluginHostProcess.ts", import.meta.url),
);
const helloPluginRoot = fileURLToPath(
  new URL("../../e2e/fixtures/hello-plugin", import.meta.url),
);
const scratchRoots: string[] = [];
const liveHosts: PluginHost[] = [];
const liveWatchers: WorkspaceWatchHandle[] = [];

afterEach(async () => {
  await Promise.allSettled(liveHosts.splice(0).map((host) => host.stopAll()));
  await Promise.allSettled(liveWatchers.splice(0).map((watch) => watch.stop()));
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function until<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

interface WatchingPlugin {
  host: PluginHost;
  workspaceRoot: string;
  events: PluginWorkspaceEvents;
  /**
   * What the registry handed out, recorded before PluginHost's own
   * post-exit guard sees it — so a subscription that outlived its spawn is
   * visible here even though nothing would reach the dead process.
   */
  delivered: Emitted[];
  received: () => Promise<Array<{ event: string; data: PluginFileWatchEvent }>>;
  started: () => Promise<{ ok: boolean; message: string | null }>;
  stop: () => Promise<{ stopped: boolean }>;
}

/**
 * A real forked plugin process watching a prefix of a real workspace, fed by
 * the real settled watcher — every hop the production path uses.
 */
async function startWatchingPlugin(prefix: string): Promise<WatchingPlugin> {
  const scratch = await createTestScratch("dohc-plugin-watch-");
  scratchRoots.push(scratch);
  const root = join(scratch, "workspace");
  await mkdir(join(root, "notes"), { recursive: true });
  await mkdir(join(root, "elsewhere"), { recursive: true });

  const events = new PluginWorkspaceEvents();
  const delivered: Emitted[] = [];
  const writes = new Map<string, string>();
  const workspace = {
    workspaceId: "ws-plugin-watch",
    rootPath: root,
    kind: "personal",
    mode: "local-first",
  } as CreatedWorkspace;
  const watch = startWorkspaceWatch(workspace, {
    settleMs: 60,
    onSettledBatch: (batch) => events.handleWatcherEvents(batch),
  });
  liveWatchers.push(watch);

  const spawnTransport: PluginHostOptions["spawnTransport"] = (params) =>
    JsonRpcTransport.spawn({
      command: process.execPath,
      args: [pluginHostProcessPath],
      cwd: params.pluginRoot,
      env: {
        DOHC_PLUGIN_FIXTURE_MODE: "watch-workspace",
        DOHC_PLUGIN_WATCH_PREFIX: prefix,
      },
      detached: true,
      label: `plugin ${params.pluginId}`,
      onNotification: params.onNotification,
      onRequest: params.onRequest,
      onStderr: params.onStderr,
      onExit: (code, signal) => params.onExit({ code, signal }),
    });

  const host = new PluginHost({
    stateDir: join(scratch, "state"),
    workspaceRoot: root,
    spawnTransport,
    routeSdkRequest: (pluginId, method, params, spawnId, signal, emitEvent) =>
      invokePluginSdkHost(
        {
          pluginId,
          workspaceRoot: root,
          spawnId,
          requestPath: "plugin-process",
          isWritable: () => true,
          writeAvailable: async () => true,
          signal,
          subscribeFileWatch: (watchParams) =>
            events.subscribe(
              {
                owner: processOwner(pluginId, spawnId),
                emitEvent: (subscriptionId, event, data) => {
                  delivered.push({ subscriptionId, event, data });
                  emitEvent(subscriptionId, event, data);
                },
              },
              watchParams,
            ),
          unsubscribeFileWatch: (watchParams) =>
            events.unsubscribe({ owner: processOwner(pluginId, spawnId) }, watchParams),
          writeAuthoredText: async (path, text) => {
            writes.set(path, text);
            return { path };
          },
        },
        method,
        params,
      ),
    onSpawnEnd: (pluginId, spawnId) => {
      events.disposeSpawn(pluginId, spawnId);
      return Promise.resolve();
    },
  });
  liveHosts.push(host);

  const manifest = await readPluginManifestFile(helloPluginRoot);
  if (!manifest.ok) throw new Error(manifest.diagnostics.join("; "));
  // "watch-workspace" mode registers these three commands, not the
  // `hello.write` the on-disk manifest declares for the default mode.
  await host.start(helloPluginRoot, {
    ...manifest.manifest,
    commands: [
      { id: "watch.received", title: "watch.received" },
      { id: "watch.started", title: "watch.started" },
      { id: "watch.stop", title: "watch.stop" },
    ],
  });
  await until(
    () => (host.getStatus("hello-plugin") === "ready" ? true : undefined),
    "the watching plugin to activate",
    20_000,
  ).catch((error: unknown) => {
    throw new Error(
      `${String(error)} stderr: ${host.getStderrLog("hello-plugin").join(" | ")}`,
    );
  });
  await watch.ready;

  return {
    host,
    workspaceRoot: root,
    events,
    delivered,
    received: async () => {
      await host.invokeCommand("hello-plugin", "watch.received");
      return JSON.parse(writes.get("watch-received-report.json") ?? "[]") as Array<{
        event: string;
        data: PluginFileWatchEvent;
      }>;
    },
    started: async () => {
      await host.invokeCommand("hello-plugin", "watch.started");
      return JSON.parse(writes.get("watch-started-report.json") ?? "null") as {
        ok: boolean;
        message: string | null;
      };
    },
    stop: async () => {
      await host.invokeCommand("hello-plugin", "watch.stop");
      return JSON.parse(writes.get("watch-stop-report.json") ?? "null") as {
        stopped: boolean;
      };
    },
  };
}

describe("a plugin watching workspace files over the real host protocol", () => {
  it("delivers a real settled write under the prefix, and never one outside it", async () => {
    const plugin = await startWatchingPlugin("notes");
    expect(await plugin.started()).toEqual({
      ok: true,
      message: null,
    });

    await writeFile(join(plugin.workspaceRoot, "notes", "today.md"), "# Today\n");
    await writeFile(join(plugin.workspaceRoot, "elsewhere", "other.md"), "# Other\n");

    const change = await until(
      async () =>
        (await plugin.received()).find(
          (entry) => entry.data.path === "notes/today.md",
        ),
      "the settled write to reach the plugin",
      20_000,
    );
    expect(change.event).toBe("change");
    expect(change.data.operation).toBe("update");
    // The settled feed hashes what it read, so the plugin can tell a real
    // edit from a touch without reading the file back.
    expect(change.data.sha256).toMatch(/^[0-9a-f]{64}$/);

    const received = await plugin.received();
    expect(received.map((entry) => entry.data.path)).toEqual(["notes/today.md"]);
  }, 60_000);

  it("stops delivering once the plugin unsubscribes", async () => {
    const plugin = await startWatchingPlugin("notes");

    await writeFile(join(plugin.workspaceRoot, "notes", "first.md"), "one\n");
    await until(
      async () => ((await plugin.received()).length > 0 ? true : undefined),
      "the first change to reach the plugin",
      20_000,
    );

    expect(await plugin.stop()).toEqual({
      stopped: true,
    });
    await writeFile(join(plugin.workspaceRoot, "notes", "second.md"), "two\n");
    // Long enough for a settle window plus delivery, had the subscription
    // survived its own unsubscribe.
    await new Promise((settle) => setTimeout(settle, 1_000));

    const received = await plugin.received();
    expect(received.map((entry) => entry.data.path)).toEqual(["notes/first.md"]);
  }, 60_000);

  it("ends the subscription with the plugin spawn", async () => {
    const plugin = await startWatchingPlugin("notes");

    await writeFile(join(plugin.workspaceRoot, "notes", "before-stop.md"), "here\n");
    await until(
      () => (plugin.delivered.length > 0 ? true : undefined),
      "the first change to be delivered",
      20_000,
    );
    await plugin.host.stop("hello-plugin");
    const deliveredBeforeStop = plugin.delivered.length;

    await writeFile(join(plugin.workspaceRoot, "notes", "after-stop.md"), "gone\n");
    // A probe subscription proves the watcher and registry are still live, so
    // the dead spawn's silence is teardown rather than a stopped feed.
    const sink = collector();
    plugin.events.subscribe(
      {
        owner: processOwner("probe", "probe-spawn"),
        emitEvent: sink.emitEvent,
      },
      { path: "notes" },
    );
    await writeFile(join(plugin.workspaceRoot, "notes", "probe.md"), "probe\n");
    await until(
      () => (sink.emitted.length > 0 ? true : undefined),
      "the probe subscription to receive a change",
      20_000,
    );

    // Recorded inside the registry, before PluginHost's post-exit guard: a
    // subscription that survived its spawn would show up here.
    expect(plugin.delivered.length).toBe(deliveredBeforeStop);
  }, 60_000);

  it("delivers one workspace's changes only to that workspace's plugin", async () => {
    const [inside, outside] = await Promise.all([
      startWatchingPlugin("notes"),
      startWatchingPlugin("notes"),
    ]);

    await writeFile(join(inside.workspaceRoot, "notes", "local.md"), "local\n");
    await until(
      async () => ((await inside.received()).length > 0 ? true : undefined),
      "the change to reach its own workspace's plugin",
      20_000,
    );
    // Long enough for the other workspace's settle window to have passed.
    await new Promise((settle) => setTimeout(settle, 1_000));

    expect((await inside.received()).map((entry) => entry.data.path)).toEqual([
      "notes/local.md",
    ]);
    expect(await outside.received()).toEqual([]);
    expect(outside.delivered).toEqual([]);
  }, 90_000);

  it("refuses a prefix that escapes the workspace, over the real protocol", async () => {
    const plugin = await startWatchingPlugin("../outside");

    const started = await plugin.started();
    expect(started.ok).toBe(false);
    expect(started.message).toContain("traversal");
  }, 60_000);
});
