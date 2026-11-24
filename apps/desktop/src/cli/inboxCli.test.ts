import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { executeCli } from "@dohc/cli";
import { requestDeclaredTool, requestDeclaredWriteTool, type ToolContext } from "@dohc/mcp/tools";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { startCliServer, type CliServerHandle, type CliWorkspaceContext } from "./cliServer";
import {
  addInboxItem,
  archiveInboxItem,
  listInboxItems,
  moveInboxItem,
  type WorkspaceInboxHost,
} from "../workspaces/workspaceInbox";

const tempDirs: string[] = [];
const handles: CliServerHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()!.close();
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const localPerson: Extract<MomentWriteAuthor, { kind: "human" }> = {
  kind: "human",
  humanId: "owner-1",
};

function makeFakeHost(rootPath: string): WorkspaceInboxHost {
  let opCounter = 0;
  return {
    capture: {
      writeAuthoredFile: async (absolutePath, content, _author, options) => {
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, options?.createOnly ? { flag: "wx" } : undefined);
        return {
          resolvedAbsolutePath: absolutePath,
          materializeOutcome: "applied",
          objectId: `obj-${createHash("sha256").update(absolutePath).digest("hex").slice(0, 8)}`,
          momentId: `mom-${createHash("sha256").update(absolutePath).digest("hex").slice(0, 8)}`,
          deduped: false,
        };
      },
      openRecordSession: async (relativePath) => {
        const absolutePath = join(rootPath, relativePath);
        const doc = markdownToYDoc(await readFile(absolutePath, "utf8"));
        return {
          applyDecidedLocalUpdate: async (decide, onArmed) => {
            onArmed();
            const update = decide(doc);
            if (!update) return false;
            Y.applyUpdate(doc, update);
            return true;
          },
          settleNow: async () => {
            await writeFile(absolutePath, yDocToMarkdown(doc), "utf8");
          },
          close: async () => {
            doc.destroy();
          },
        };
      },
    },
    withAdapter: async () => null,
    onCaptureSettled: () => () => undefined,
    moveFile: async ({ fromPath, toPath }) => {
      const toAbs = join(rootPath, toPath);
      await mkdir(dirname(toAbs), { recursive: true });
      await rename(join(rootPath, fromPath), toAbs);
      opCounter += 1;
      return {
        fromPath,
        toPath,
        operationId: `dohc-operation:22222222-2222-4222-8222-${String(opCounter).padStart(12, "0")}`,
      };
    },
    registeredRoots: () => [rootPath],
  };
}

async function startInboxServer(options: { readOnly?: boolean } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "dohc-inbox-cli-state-"));
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-inbox-cli-ws-"));
  tempDirs.push(stateDir, rootPath);
  const host = makeFakeHost(rootPath);
  const workspace = {
    workspaceId: "ws-inbox-cli",
    rootPath,
    readOnly: options.readOnly ?? false,
  };
  const operation = {
    workspace,
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
  };

  const server = await startCliServer({
    stateDir,
    listWorkspaces: () => [workspace],
    reads: {
      inboxList: (ws, input) => listInboxItems(ws, input, host),
    },
    openWorkspace: async (): Promise<CliWorkspaceContext> => {
      const inbox: NonNullable<CliWorkspaceContext["inbox"]> = {
        add: (input, source, origin) =>
          addInboxItem(
            operation,
            input,
            origin
              ? {
                  kind: "agent",
                  agentId: origin.actorOriginId ?? "agent-1",
                  onBehalfOf: localPerson.humanId,
                }
              : localPerson,
            source,
            host,
          ),
        archive: (input, origin) =>
          archiveInboxItem(
            operation,
            input,
            origin
              ? {
                  kind: "agent",
                  agentId: origin.actorOriginId ?? "agent-1",
                  onBehalfOf: localPerson.humanId,
                }
              : localPerson,
            localPerson,
            host,
          ),
        move: (input, origin) =>
          moveInboxItem(
            operation,
            input,
            origin
              ? {
                  kind: "agent",
                  agentId: origin.actorOriginId ?? "agent-1",
                  onBehalfOf: localPerson.humanId,
                }
              : localPerson,
            host,
          ),
      };
      return {
        workspaceId: workspace.workspaceId,
        rootPath,
        readOnly: workspace.readOnly,
        store: {} as CliWorkspaceContext["store"],
        inbox,
      } as unknown as CliWorkspaceContext;
    },
    chatWrites: {} as never,
    localUserDisplayName: () => "Owner",
    localPersonId: () => localPerson.humanId,
    agentRunDepth: () => 0,
    dispatchedAgent: () => null,
    dispatchedRunId: () => null,
    agentWriteRunId: () => null,
    dispatchedRunSecret: () => null,
    agentRunWorkspace: () => undefined,
    connectedAgent: async () => null,
    onWrite: vi.fn(),
  });
  handles.push(server);
  return { stateDir, rootPath };
}

describe("inbox CLI & MCP doors", () => {
  it("supports owner CLI inbox list, add, archive, and move end-to-end over the socket", async () => {
    const { stateDir, rootPath } = await startInboxServer();
    await mkdir(join(rootPath, "Projects"), { recursive: true });
    const client = { stateDir };

    const empty = await executeCli({ argv: ["inbox", "list", "--json"], cwd: rootPath, client });
    expect(empty.exitCode).toBe(0);
    expect(JSON.parse(empty.stdout)).toMatchObject({ exists: false, items: [], hasMore: false });

    const added = await executeCli({
      argv: [
        "inbox",
        "add",
        "--title",
        "CLI note",
        "--url",
        "https://example.com/inbox",
        "Check this link",
        "--json",
      ],
      cwd: rootPath,
      client,
    });
    expect(added.exitCode).toBe(0);
    const addedJson = JSON.parse(added.stdout) as {
      ok: boolean;
      path: string;
      createdInbox: boolean;
    };
    expect(addedJson.ok).toBe(true);
    expect(addedJson.createdInbox).toBe(true);
    expect(addedJson.path).toMatch(/^Inbox\/\d{4}-\d{2}-\d{2}-cli-note\.md$/);

    const listed = await executeCli({ argv: ["inbox", "list", "--json"], cwd: rootPath, client });
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      exists: true,
      items: [{ path: addedJson.path, title: "CLI note", status: "New", source: "cli" }],
    });

    const archived = await executeCli({
      argv: ["inbox", "archive", addedJson.path, "--json"],
      cwd: rootPath,
      client,
    });
    expect(archived.exitCode).toBe(0);
    expect(JSON.parse(archived.stdout)).toMatchObject({
      ok: true,
      path: addedJson.path,
      previousStatus: "New",
    });

    const moved = await executeCli({
      argv: ["inbox", "move", addedJson.path, "Projects", "--json"],
      cwd: rootPath,
      client,
    });
    expect(moved.exitCode).toBe(0);
    const movedJson = JSON.parse(moved.stdout) as {
      ok: boolean;
      toPath: string;
      operationId: string;
    };
    expect(movedJson.ok).toBe(true);
    expect(movedJson.toPath).toMatch(/^Projects\/\d{4}-\d{2}-\d{2}-cli-note\.md$/);
    expect(movedJson.operationId).toMatch(/^dohc-operation:/);
  });

  it("attributes MCP inbox writes to agent and refuses read-only workspaces and received shares", async () => {
    const owner = await startInboxServer();
    const sharedDir = join(owner.rootPath, "shared-with-me", "team-share");
    await mkdir(sharedDir, { recursive: true });
    const client = { stateDir: owner.stateDir };

    // Received share folder refuses list, add, archive, move.
    for (const argv of [
      ["inbox", "list"],
      ["inbox", "add", "--title", "Blocked"],
      ["inbox", "archive", "Inbox/item.md"],
      ["inbox", "move", "Inbox/item.md", "Projects"],
    ]) {
      const refused = await executeCli({ argv, cwd: sharedDir, client });
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toMatch(/own workspace/i);
    }

    // MCP owner tool records Source: agent.
    const ctx: ToolContext = { root: owner.rootPath, home: owner.stateDir };
    const mcpAdded = await requestDeclaredWriteTool(ctx, "dohc_inbox_add", {
      title: "Agent triage item",
      body: "Captured by connected agent",
    });
    expect(mcpAdded).toMatchObject({ ok: true, title: "Agent triage item" });
    const mcpListed = (await requestDeclaredTool(ctx, "dohc_inbox_list", {})) as {
      exists: boolean;
      items: Array<{ title: string; source: string }>;
    };
    expect(mcpListed.exists).toBe(true);
    expect(mcpListed.items[0]).toMatchObject({ title: "Agent triage item", source: "agent" });

    // Colon in item/targetFolder is refused at the socket boundary.
    const colonRefused = await requestDeclaredWriteTool(ctx, "dohc_inbox_archive", {
      item: "Inbox/bad:name.md",
    });
    expect(colonRefused).toMatchObject({ ok: false });

    // Read-only workspace refuses Inbox list and writes.
    const readOnly = await startInboxServer({ readOnly: true });
    const roList = await executeCli({
      argv: ["inbox", "list"],
      cwd: readOnly.rootPath,
      client: { stateDir: readOnly.stateDir },
    });
    expect(roList.exitCode).not.toBe(0);
    expect(roList.stderr).toMatch(/owning writable workspace|read-only|own workspace/i);
    const roAdd = await executeCli({
      argv: ["inbox", "add", "--title", "Readonly"],
      cwd: readOnly.rootPath,
      client: { stateDir: readOnly.stateDir },
    });
    expect(roAdd.exitCode).not.toBe(0);
    expect(roAdd.stderr).toMatch(/read-only/i);
    const roArchive = await executeCli({
      argv: ["inbox", "archive", "Inbox/item.md"],
      cwd: readOnly.rootPath,
      client: { stateDir: readOnly.stateDir },
    });
    expect(roArchive.exitCode).not.toBe(0);
    expect(roArchive.stderr).toMatch(/read-only/i);
    const roMove = await executeCli({
      argv: ["inbox", "move", "Inbox/item.md", "Projects"],
      cwd: readOnly.rootPath,
      client: { stateDir: readOnly.stateDir },
    });
    expect(roMove.exitCode).not.toBe(0);
    expect(roMove.stderr).toMatch(/read-only/i);
  });
});
