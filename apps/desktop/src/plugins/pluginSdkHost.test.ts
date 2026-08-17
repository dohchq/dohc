import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { databaseOpLogPath } from "@dohc/workspace-core";
import type { MomentAuthor } from "@dohc/workspace-contracts/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import {
  invokePluginSdkHost,
  type PluginSdkHostContext,
} from "./pluginSdkHost";
import { createPluginPanelSdkAuthorityRegistry } from "./pluginPanelSdkAuthority";

const roots: string[] = [];

interface AuthoredWrite {
  path: string;
  text: string;
  options: { overwrite: boolean; author: MomentAuthor };
}

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
};

async function seedDatabase(
  root: string,
  path: string,
  marker: string,
): Promise<void> {
  await mkdir(join(root, dirname(path)), { recursive: true });
  const database = new DatabaseSync(join(root, path));
  try {
    database.exec(
      `CREATE TABLE sentinel (id TEXT PRIMARY KEY, marker TEXT); INSERT INTO sentinel VALUES ('1', '${marker}');`,
    );
  } finally {
    database.close();
  }
}

async function workspaceRoot(): Promise<string> {
  const root = await createTestScratch("dohc-plugin-sdk-host-");
  roots.push(root);
  return root;
}

function context(root: string, writes: AuthoredWrite[] = []): PluginSdkHostContext {
  const controller = new AbortController();
  return {
    pluginId: "hello-plugin",
    workspaceRoot: root,
    spawnId: "spawn-123",
    requestPath: "plugin-process",
    isWritable: () => true,
    writeAvailable: async () => true,
    signal: controller.signal,
    invokeChildProcess: vi.fn(async () => ({})),
    writeAuthoredText: vi.fn<PluginSdkHostContext["writeAuthoredText"]>(
      async (path, text, options) => {
        writes.push({ path, text, options });
        return { path };
      },
    ),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("invokePluginSdkHost", () => {
  it("reports only the routed plugin capabilities", async () => {
    const root = await workspaceRoot();

    await expect(invokePluginSdkHost(context(root), "capabilities")).resolves.toEqual({
      files: { read: true, list: true, write: true, watch: false },
      workspace: { search: true },
      databases: { read: true, edit: true },
      // The plugin's own process has no renderer to open a tab in.
      ui: { open: false },
      childProcesses: { spawn: true, output: true, send: true, terminate: true },
      collections: { read: false },
      provenance: { record: false },
    });
  });

  it("reports databases.edit on workspace authority alone, without an engine capture", async () => {
    const root = await workspaceRoot();
    const unavailable = { ...context(root), writeAvailable: async () => false };

    await expect(
      invokePluginSdkHost(unavailable, "capabilities"),
    ).resolves.toMatchObject({
      files: { write: false },
      databases: { read: true, edit: true },
    });
  });

  it("reports unavailable engine capture honestly and still refuses direct writes", async () => {
    const root = await workspaceRoot();
    const unavailable = {
      ...context(root),
      writeAvailable: async () => false,
    };

    await expect(
      invokePluginSdkHost(unavailable, "capabilities"),
    ).resolves.toMatchObject({ files: { write: false } });
    await expect(
      invokePluginSdkHost(unavailable, "files.write", {
        path: "notes/no-engine.txt",
        text: "must not write",
      }),
    ).rejects.toThrow(/file writes are unavailable/i);
    expect(unavailable.writeAuthoredText).not.toHaveBeenCalled();
  });

  it("routes file reads, file lists, and workspace searches through the site host", async () => {
    const root = await workspaceRoot();
    await mkdir(join(root, "notes"));
    await writeFile(
      join(root, "notes", "router.txt"),
      "plugin router sentinel\n",
    );
    const hostContext = context(root);

    await expect(
      invokePluginSdkHost(hostContext, "files.read", { path: "notes/router.txt" }),
    ).resolves.toMatchObject({ text: "plugin router sentinel\n" });
    await expect(
      invokePluginSdkHost(hostContext, "files.list", { path: "notes" }),
    ).resolves.toContainEqual(
      expect.objectContaining({ path: "notes/router.txt", name: "router.txt" }),
    );
    await expect(
      invokePluginSdkHost(hostContext, "workspace.search", {
        query: "plugin router sentinel",
      }),
    ).resolves.toContainEqual(expect.objectContaining({ path: "notes/router.txt" }));
  });

  it("forwards host-derived attribution to authored writes", async () => {
    const root = await workspaceRoot();
    const writes: AuthoredWrite[] = [];
    const hostContext = context(root, writes);

    await expect(
      invokePluginSdkHost(hostContext, "files.write", {
        path: "notes/from-plugin.txt",
        text: "hello\n",
        overwrite: false,
      }),
    ).resolves.toEqual({ path: "notes/from-plugin.txt" });

    expect(writes).toEqual([
      {
        path: "notes/from-plugin.txt",
        text: "hello\n",
        options: {
          overwrite: false,
          author: {
            kind: "agent",
            agentId: "plugin:hello-plugin",
            onBehalfOf: "local",
            agentRunId: "spawn-123",
          },
        },
      },
    ]);
    expect(hostContext.writeAuthoredText).toHaveBeenCalledWith(
      "notes/from-plugin.txt",
      "hello\n",
      expect.objectContaining({ overwrite: false }),
    );
  });

  it("rejects a non-boolean overwrite before writing", async () => {
    const root = await workspaceRoot();
    const writes: AuthoredWrite[] = [];

    await expect(
      invokePluginSdkHost(context(root, writes), "files.write", {
        path: "notes/x.txt",
        text: "y",
        overwrite: "false",
      }),
    ).rejects.toThrow(
      'files.write overwrite must be a boolean; received a value of type "string".',
    );
    expect(writes).toEqual([]);
  });

  it("accepts overwrite false", async () => {
    const root = await workspaceRoot();
    const writes: AuthoredWrite[] = [];

    await expect(
      invokePluginSdkHost(context(root, writes), "files.write", {
        path: "notes/x.txt",
        text: "y",
        overwrite: false,
      }),
    ).resolves.toEqual({ path: "notes/x.txt" });
    expect(writes[0]?.options.overwrite).toBe(false);
  });

  it("ignores plugin-supplied write attribution", async () => {
    const root = await workspaceRoot();
    const writes: AuthoredWrite[] = [];

    await invokePluginSdkHost(context(root, writes), "files.write", {
      path: "notes/forged.txt",
      text: "spoof attempt",
      author: {
        kind: "agent",
        agentId: "forged-author",
        onBehalfOf: "forged-user",
        agentRunId: "forged-run",
      },
      agentId: "another-forged-author",
    });

    expect(writes[0]?.options.author).toEqual({
      kind: "agent",
      agentId: "plugin:hello-plugin",
      onBehalfOf: "local",
      agentRunId: "spawn-123",
    });
  });

  it.each([
    [
      "data/plugin.sqlite",
      "files.write cannot overwrite database files. Use databases.edit so structured transactions, history, and collaboration are preserved.",
    ],
    [
      "notes/canonical.md",
      "files.write cannot overwrite live documents. Use a dohc document editing capability so locks, history, and collaboration are preserved.",
    ],
    [
      "drawings/plan.excalidraw",
      "files.write cannot overwrite live documents. Use a dohc document editing capability so locks, history, and collaboration are preserved.",
    ],
  ])("refuses raw writes to %s", async (path, message) => {
    const root = await workspaceRoot();

    const error = await invokePluginSdkHost(context(root), "files.write", {
      path,
      text: "not written",
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
  });

  it("rejects methods outside the plugin capability subset", async () => {
    const root = await workspaceRoot();

    await expect(
      invokePluginSdkHost(context(root), "collections.list", { name: "people" }),
    ).rejects.toThrow("Unsupported dohc SDK method: collections.list");
  });

  it("reads a database snapshot through the site host", async () => {
    const root = await workspaceRoot();
    await seedDatabase(root, "data/app.sqlite", "start");

    await expect(
      invokePluginSdkHost(context(root), "databases.read", {
        path: "data/app.sqlite",
      }),
    ).resolves.toMatchObject({
      tables: [expect.objectContaining({ name: "sentinel" })],
    });
  });

  it("records the plugin, not the user, as the author of a database edit", async () => {
    const root = await workspaceRoot();
    await seedDatabase(root, "data/app.sqlite", "start");

    await invokePluginSdkHost(context(root), "databases.edit", {
      path: "data/app.sqlite",
      edit: {
        table: "sentinel",
        op: "update",
        pkColumn: "id",
        rowId: "1",
        payload: { marker: "edited-by-plugin" },
      },
    });

    const log = await readFile(
      join(root, databaseOpLogPath("data/app.sqlite")),
      "utf8",
    );
    const ops = log
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line) as { author: unknown });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.author).toEqual({
      kind: "agent",
      agentId: "plugin:hello-plugin",
      onBehalfOf: "local",
    });
  });

  it("refuses database edits from a read-only workspace authority", async () => {
    const root = await workspaceRoot();
    await seedDatabase(root, "data/app.sqlite", "start");
    const readOnly = { ...context(root), isWritable: () => false };

    await expect(
      invokePluginSdkHost(readOnly, "capabilities"),
    ).resolves.toMatchObject({ databases: { read: true, edit: false } });
    await expect(
      invokePluginSdkHost(readOnly, "databases.edit", {
        path: "data/app.sqlite",
        edit: {
          table: "sentinel",
          op: "update",
          pkColumn: "id",
          rowId: "1",
          payload: { marker: "must-not-land" },
        },
      }),
    ).rejects.toThrow(/read-only workspace authority/);
    // A shared view still reads.
    await expect(
      invokePluginSdkHost(readOnly, "databases.read", { path: "data/app.sqlite" }),
    ).resolves.toMatchObject({ tables: [expect.objectContaining({ name: "sentinel" })] });
    await expect(
      readFile(join(root, databaseOpLogPath("data/app.sqlite")), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates a ui.open target and serves it only to a panel request path", async () => {
    const root = await workspaceRoot();
    const panel: PluginSdkHostContext = {
      ...context(root),
      requestPath: "panel",
    };

    await expect(
      invokePluginSdkHost(panel, "capabilities"),
    ).resolves.toMatchObject({ ui: { open: true } });
    await expect(
      invokePluginSdkHost(panel, "ui.open", { target: "notes/today.md" }),
    ).resolves.toEqual({ target: "notes/today.md" });
    // The target is a workspace path, never an escape from it.
    await expect(
      invokePluginSdkHost(panel, "ui.open", { target: "../secret.txt" }),
    ).rejects.toThrow(/Invalid read path/);

    // The plugin's own process has no renderer, so it is told so by name.
    await expect(
      invokePluginSdkHost(context(root), "ui.open", { target: "notes/today.md" }),
    ).rejects.toThrow(/ui.open is unavailable for this request path/);
  });

  // The renderer answers ui.theme for a panel before it reaches main, so
  // BOTH paths refuse here — and say why rather than "unsupported method".
  it("refuses ui.theme by name on either request path", async () => {
    const root = await workspaceRoot();
    const paths: PluginSdkHostContext[] = [
      context(root),
      { ...context(root), requestPath: "panel" },
    ];
    for (const ctx of paths) {
      await expect(invokePluginSdkHost(ctx, "ui.theme", undefined)).rejects.toThrow(
        /ui.theme is unavailable for this request path/,
      );
    }
  });

  // ui.openWebApp is the only way an instance key ever enters dohc: the
  // plugin's page in dohc knows manifest ids and nothing about instances.
  describe("ui.openWebApp", () => {
    async function panelWithWebApps(): Promise<PluginSdkHostContext> {
      return {
        ...context(await workspaceRoot()),
        requestPath: "panel",
        declaredWebApps: [
          { id: "preview", instanced: true },
          { id: "app", instanced: false },
        ],
      };
    }

    it("returns the web app and instance a panel asked to open", async () => {
      await expect(
        invokePluginSdkHost(await panelWithWebApps(), "ui.openWebApp", {
          webAppId: "preview",
          instanceKey: "sites/marketing",
        }),
      ).resolves.toEqual({
        webAppId: "preview",
        instanceKey: "sites/marketing",
      });
    });

    // MUTATION (serve this from the plugin-process path too): a plugin with
    // no renderer would ask for a tab nothing can open.
    it("refuses the request path with no renderer behind it", async () => {
      const root = await workspaceRoot();
      await expect(
        invokePluginSdkHost(
          {
            ...context(root),
            declaredWebApps: [{ id: "preview", instanced: true }],
          },
          "ui.openWebApp",
          { webAppId: "preview", instanceKey: "sites/a" },
        ),
      ).rejects.toThrow(/ui.openWebApp is unavailable for this request path/);
    });

    // MUTATION (read the declared web apps from the request instead of the
    // registration): a panel could open a web app its manifest never declared
    // — approval covers the manifest, so this is the line approval sits on.
    it("refuses a web app this plugin's manifest never declared", async () => {
      await expect(
        invokePluginSdkHost(await panelWithWebApps(), "ui.openWebApp", {
          webAppId: "ghost",
          instanceKey: "sites/a",
        }),
      ).rejects.toThrow(/does not declare web app "ghost"/);
    });

    it("refuses an instance on a web app that opens a single tab", async () => {
      await expect(
        invokePluginSdkHost(await panelWithWebApps(), "ui.openWebApp", {
          webAppId: "app",
          instanceKey: "sites/a",
        }),
      ).rejects.toThrow(/must not name an instance/);
    });

    it("refuses an open with no instance to name", async () => {
      await expect(
        invokePluginSdkHost(await panelWithWebApps(), "ui.openWebApp", {
          webAppId: "preview",
        }),
      ).rejects.toThrow(/instanceKey must be a non-empty string/);
    });

    // MUTATION (drop the length bound): the key rides in a tab path that
    // restore rejects past 4096 characters, so an unbounded key would open a
    // tab that never comes back.
    it("names the limit when an instance key is too long", async () => {
      await expect(
        invokePluginSdkHost(await panelWithWebApps(), "ui.openWebApp", {
          webAppId: "preview",
          instanceKey: "s".repeat(513),
        }),
      ).rejects.toThrow(/513 characters, past the limit of 512 characters/);
    });

    // MUTATION (check only for NUL, or lean on the SDK's own check): the SDK
    // check is the caller's copy and a caller can skip it, so this side is
    // what keeps a control character out of a tab path and a tab label.
    it.each([
      ["a NUL byte", "sites/a\u0000b"],
      ["a newline", "sites/a\nb"],
      ["a unit separator", "sites/a\u001fb"],
      ["a delete character", "sites/a\u007fb"],
    ])("refuses %s in an instance key", async (_label, instanceKey) => {
      await expect(
        invokePluginSdkHost(await panelWithWebApps(), "ui.openWebApp", {
          webAppId: "preview",
          instanceKey,
        }),
      ).rejects.toThrow(/must not contain control characters/);
    });

    it("names the control-character range it refused", async () => {
      await expect(
        invokePluginSdkHost(await panelWithWebApps(), "ui.openWebApp", {
          webAppId: "preview",
          instanceKey: "sites/a\nb",
        }),
      ).rejects.toThrow(/U\+0000 to U\+001F, or U\+007F/);
    });

    it("keeps ordinary punctuation and spaces in an instance key", async () => {
      const instanceKey = "sites/My Site (draft) v2";
      await expect(
        invokePluginSdkHost(await panelWithWebApps(), "ui.openWebApp", {
          webAppId: "preview",
          instanceKey,
        }),
      ).resolves.toEqual({ webAppId: "preview", instanceKey });
    });
  });

  it("refuses writes from a read-only or stopped panel authority", async () => {
    const root = await workspaceRoot();
    const readOnly = { ...context(root), isWritable: () => false };
    await expect(
      invokePluginSdkHost(readOnly, "files.write", {
        path: "notes/x.txt",
        text: "x",
      }),
    ).rejects.toThrow(/read-only workspace authority/);
    await expect(invokePluginSdkHost(readOnly, "capabilities")).resolves.toMatchObject({
      files: { write: false },
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      invokePluginSdkHost(
        { ...context(root), signal: controller.signal },
        "files.write",
        { path: "notes/x.txt", text: "x" },
      ),
    ).rejects.toThrow(/no longer active/);
  });

  it("rechecks writability for a still-live host context", async () => {
    const root = await workspaceRoot();
    let writable = true;
    const registry = createPluginPanelSdkAuthorityRegistry();
    registry.register({
      senderId: 1,
      generation: 1,
      workspaceId: "workspace-a",
      pluginId: "hello-plugin",
      panelId: "main",
    });
    const authority = () =>
      registry.authorize({
        senderId: 1,
        generation: 1,
        activeWorkspaceId: "workspace-a",
        workspaceId: "workspace-a",
        pluginId: "hello-plugin",
        panelId: "main",
        panelRunning: true,
        liveSpawnId: "spawn-123",
      });
    const hostContext = {
      ...context(root),
      isWritable: () => writable,
      signal: authority().signal,
    };

    await expect(
      invokePluginSdkHost(hostContext, "capabilities"),
    ).resolves.toMatchObject({ files: { write: true } });
    writable = false;
    expect(authority().signal).toBe(hostContext.signal);
    await expect(
      invokePluginSdkHost(hostContext, "files.write", {
        path: "notes/after-share.txt",
        text: "must not write",
      }),
    ).rejects.toThrow(/read-only workspace authority/i);
    expect(hostContext.writeAuthoredText).not.toHaveBeenCalled();
  });

  it("routes child-process methods through the spawn-scoped broker context", async () => {
    const root = await workspaceRoot();
    const hostContext = context(root);
    hostContext.invokeChildProcess = vi.fn(async () => ({ childId: "child-1" }));

    await expect(
      invokePluginSdkHost(hostContext, "childProcesses.spawn", {
        modulePath: "server.mjs",
        args: ["--port", "0"],
      }),
    ).resolves.toEqual({ childId: "child-1" });
    expect(hostContext.invokeChildProcess).toHaveBeenCalledWith(
      "childProcesses.spawn",
      { modulePath: "server.mjs", args: ["--port", "0"] },
    );
  });

  it("rejects an in-flight router operation when its spawn signal aborts", async () => {
    const root = await workspaceRoot();
    const controller = new AbortController();
    const hostContext = context(root);
    hostContext.signal = controller.signal;
    hostContext.invokeChildProcess = vi.fn(
      () => new Promise<never>(() => undefined),
    );
    const request = invokePluginSdkHost(
      hostContext,
      "childProcesses.wait",
      { childId: "child-1" },
    );

    controller.abort();

    await expect(request).rejects.toMatchObject({
      code: "DOHC_ABORTED",
      message: "The plugin spawn ended before the SDK operation completed.",
    });
  });

  it("propagates writeAuthoredText's own cancellation message unmodified", async () => {
    // No generic DOHC_ABORTED normalizing here: PluginHost.test.ts's
    // "aborts a queued panel write when the plugin crashes" proves the real
    // engine capture names the specific reason ("Plugin panel is no longer
    // active.") a queued write was cancelled, and that message must reach
    // the caller as-is, not be replaced by a generic one.
    const root = await workspaceRoot();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const hostContext = context(root);
    hostContext.signal = controller.signal;
    hostContext.writeAuthoredText = vi.fn(
      () =>
        new Promise<{ path: string }>((_resolve, reject) => {
          started.resolve();
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("Plugin panel is no longer active.")),
            { once: true },
          );
        }),
    );
    const request = invokePluginSdkHost(hostContext, "files.write", {
      path: "notes/cancelled.txt",
      text: "not committed",
    });
    await started.promise;

    controller.abort();

    await expect(request).rejects.toThrow("Plugin panel is no longer active.");
  });

  it("reports childProcesses honestly, and rejects every method, when invokeChildProcess is absent (#779 round 3 finding 7 / R24)", async () => {
    // Panel-driven SDK calls never supply invokeChildProcess — only a
    // plugin's own routeSdkRequest path may broker child processes on its
    // behalf.
    const root = await workspaceRoot();
    const panelContext: PluginSdkHostContext = {
      ...context(root),
      requestPath: "panel",
    };
    delete panelContext.invokeChildProcess;

    await expect(
      invokePluginSdkHost(panelContext, "capabilities"),
    ).resolves.toMatchObject({
      childProcesses: { spawn: false, output: false, send: false, terminate: false },
    });
    await expect(
      invokePluginSdkHost(panelContext, "childProcesses.spawn", {
        modulePath: "server.mjs",
      }),
    ).rejects.toThrow(/unavailable for this request path/i);
    await expect(
      invokePluginSdkHost(panelContext, "childProcesses.wait", { childId: "child-1" }),
    ).rejects.toThrow(/unavailable for this request path/i);
  });
});
