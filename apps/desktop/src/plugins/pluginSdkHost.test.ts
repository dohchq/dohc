import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

async function workspaceRoot(): Promise<string> {
  const root = await createTestScratch("dohc-plugin-sdk-host-");
  roots.push(root);
  return root;
}

function context(root: string, writes: AuthoredWrite[] = []): PluginSdkHostContext {
  return {
    pluginId: "hello-plugin",
    workspaceRoot: root,
    spawnId: "spawn-123",
    isWritable: () => true,
    writeAvailable: async () => true,
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
      collections: { read: false },
      provenance: { record: false },
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

    await expect(
      invokePluginSdkHost(context(root, writes), "files.write", {
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
      "files.write cannot overwrite canonical Markdown documents. Use a dohc document editing capability so locks, history, and collaboration are preserved.",
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
      invokePluginSdkHost(context(root), "databases.read", {
        path: "data/plugin.sqlite",
      }),
    ).rejects.toThrow("Unsupported dohc SDK method: databases.read");
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
});
