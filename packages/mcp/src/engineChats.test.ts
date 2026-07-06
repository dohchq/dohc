import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLinkedChatStore, createVersionedTextStore } from "@dohc/workspace-engine";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDohcMcpServer } from "./server";
import {
  deleteWorkspacePath,
  isSqliteBusyError,
  isWorkspaceEngineFlagged,
  listChannels,
  listChanges,
  listFileChats,
  readChat,
  replyToChat,
  startChannelChat,
  writeWorkspaceFile,
  type ToolContext,
} from "./tools";

// PR 0N-1 MCP posture on workspace-engine (flagged) workspaces:
//  - mutating tools stop writing legacy .dohc/history change sets (the
//    desktop watcher + agent-run slot capture the physical write with
//    attribution; an external MCP client without a dohc-tracked run yields
//    actor-neutral engine capture);
//  - the linked-chat tools make the file rail two-way, replying as the agent;
//  - unflagged workspaces keep legacy recording byte-for-byte.

async function withWorkspace<T>(fn: (ctx: ToolContext) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "dohc-mcp-engine-test-"));
  const root = join(base, "ws");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  try {
    return await fn({ root, home });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function seedEngineFlag(ctx: ToolContext, enabled = true): Promise<void> {
  await mkdir(join(ctx.root, ".dohc"), { recursive: true });
  await writeFile(
    join(ctx.root, ".dohc", "settings.local.json"),
    `${JSON.stringify({
      version: 1,
      agents: { mcpAutoStart: false, defaultDriverId: null, defaultModel: null },
      sites: { defaultPreviewMode: "auto" },
      privacy: { confirmExternalLinks: true },
      experimental: { workspaceEngineAlpha: enabled },
    }, null, 2)}\n`,
  );
}

async function seedManifest(ctx: ToolContext, workspaceId: string): Promise<void> {
  await mkdir(join(ctx.root, ".dohc"), { recursive: true });
  await writeFile(
    join(ctx.root, ".dohc", "manifest.json"),
    `${JSON.stringify({ version: 1, workspaceId, kind: "personal", mode: "local-first" })}\n`,
  );
}

// Seeds a tracked file + a linked chat directly in the engine stores (the
// same seeded-state pattern the desktop chats E2E uses).
async function seedLinkedChat(ctx: ToolContext, workspaceId: string) {
  const texts = createVersionedTextStore(ctx.root);
  await texts.ensureMainVersion({ workspaceId });
  const seeded = await texts.writeTextFile({
    workspaceId,
    versionId: "main",
    path: "notes/agenda.md",
    text: "# Agenda\n",
    metadata: { origin: "local-file" },
  });
  const chats = createLinkedChatStore(ctx.root);
  const thread = await chats.createThread({
    workspaceId,
    title: "Agenda review",
    linkedFile: { objectId: seeded.object.id, pathHint: "notes/agenda.md" },
  });
  await chats.sendMessage({
    workspaceId,
    threadId: thread.id,
    author: { kind: "human", displayName: "Ice de Vera" },
    body: "Can you tighten the agenda?",
  });
  await chats.close();
  await texts.close();
  return { thread, objectId: seeded.object.id };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isWorkspaceEngineFlagged", () => {
  it("reads the desktop's per-workspace settings file, failing closed", async () => {
    await withWorkspace(async (ctx) => {
      expect(await isWorkspaceEngineFlagged(ctx)).toBe(false);
      await seedEngineFlag(ctx, false);
      expect(await isWorkspaceEngineFlagged(ctx)).toBe(false);
      await seedEngineFlag(ctx, true);
      expect(await isWorkspaceEngineFlagged(ctx)).toBe(true);
      // Broken JSON reads as OFF, never a crash.
      await writeFile(join(ctx.root, ".dohc", "settings.local.json"), "{nope");
      expect(await isWorkspaceEngineFlagged(ctx)).toBe(false);
    });
  });

  it("refuses a symlinked settings file", async () => {
    await withWorkspace(async (ctx) => {
      const outside = join(ctx.home, "planted-settings.json");
      await writeFile(
        outside,
        JSON.stringify({ experimental: { workspaceEngineAlpha: true } }),
      );
      await mkdir(join(ctx.root, ".dohc"), { recursive: true });
      await symlink(outside, join(ctx.root, ".dohc", "settings.local.json"));
      expect(await isWorkspaceEngineFlagged(ctx)).toBe(false);
    });
  });
});

describe("mutating tools on a flagged workspace", () => {
  it("write and delete skip the legacy change set (engine capture owns history)", async () => {
    await withWorkspace(async (ctx) => {
      await seedEngineFlag(ctx);
      const write = await writeWorkspaceFile(ctx, {
        path: "notes/plan.md",
        content: "# Plan\n",
      });
      expect(write).toMatchObject({ ok: true, recordedBy: "workspace-engine" });
      expect(write).not.toHaveProperty("changeSetId");
      // The physical write landed...
      await expect(access(join(ctx.root, "notes/plan.md"))).resolves.toBeUndefined();
      // ...and NO legacy history record exists for it.
      await expect(listChanges(ctx, {})).resolves.toMatchObject({ count: 0 });

      const deleted = await deleteWorkspacePath(ctx, { path: "notes/plan.md" });
      expect(deleted).toMatchObject({ ok: true, recordedBy: "workspace-engine" });
      await expect(listChanges(ctx, {})).resolves.toMatchObject({ count: 0 });
    });
  });

  it("unflagged workspaces keep legacy recording exactly as before", async () => {
    await withWorkspace(async (ctx) => {
      const write = await writeWorkspaceFile(ctx, {
        path: "notes/plan.md",
        content: "# Plan\n",
      });
      expect(write).toMatchObject({ ok: true });
      expect(write).toHaveProperty("changeSetId");
      expect(write).not.toHaveProperty("recordedBy");
      await expect(listChanges(ctx, {})).resolves.toMatchObject({ count: 1 });
    });
  });
});

describe("linked chat tools", () => {
  it("refuse when the workspace engine flag is absent or off", async () => {
    await withWorkspace(async (ctx) => {
      const expected = { ok: false, reason: expect.stringContaining("not enabled") };
      expect(await listFileChats(ctx, { path: "notes/agenda.md" })).toMatchObject(expected);
      expect(await readChat(ctx, { threadId: "thread-1" })).toMatchObject(expected);
      expect(
        await replyToChat(ctx, { threadId: "thread-1", body: "hello" }),
      ).toMatchObject(expected);

      await seedEngineFlag(ctx, false);
      expect(await listFileChats(ctx, { path: "notes/agenda.md" })).toMatchObject(expected);
    });
  });

  it("refuse without a workspace identity", async () => {
    await withWorkspace(async (ctx) => {
      await seedEngineFlag(ctx);
      expect(await listFileChats(ctx, { path: "notes/agenda.md" })).toMatchObject({
        ok: false,
        reason: expect.stringContaining("manifest"),
      });
    });
  });

  it("rejects traversal paths before touching the engine", async () => {
    await withWorkspace(async (ctx) => {
      await seedEngineFlag(ctx);
      await seedManifest(ctx, "ws-chats");
      expect(await listFileChats(ctx, { path: "../outside.md" })).toMatchObject({
        ok: false,
        reason: expect.stringContaining("path rejected"),
      });
    });
  });

  it("lists a file's chats, reads the thread, and replies as the agent", async () => {
    await withWorkspace(async (ctx) => {
      await seedEngineFlag(ctx);
      await seedManifest(ctx, "ws-chats");
      const { thread } = await seedLinkedChat(ctx, "ws-chats");

      const listed = await listFileChats(ctx, { path: "notes/agenda.md" });
      expect(listed).toMatchObject({
        ok: true,
        fileObjectId: expect.any(String),
        threads: [{ id: thread.id, title: "Agenda review" }],
      });

      // An untracked (never captured) file reports null, not an error.
      await writeFile(join(ctx.root, "loose.md"), "untracked\n");
      expect(await listFileChats(ctx, { path: "loose.md" })).toMatchObject({
        ok: true,
        fileObjectId: null,
        threads: [],
      });

      const read = await readChat(ctx, { threadId: thread.id });
      expect(read).toMatchObject({
        ok: true,
        thread: { id: thread.id, title: "Agenda review" },
        messages: [
          {
            authorKind: "human",
            authorDisplayName: "Ice de Vera",
            body: "Can you tighten the agenda?",
          },
        ],
        projection: {
          readOnly: true,
          text: expect.stringContaining("Linked file: notes/agenda.md"),
        },
      });

      // Signed out: the reply's display name is "You" (the SAME rule the
      // desktop's localUserDisplayName applies) — shared surfaces render it
      // as "You's agent".
      const reply = await replyToChat(ctx, {
        threadId: thread.id,
        body: "Done — trimmed it to three items.",
      });
      expect(reply).toMatchObject({
        ok: true,
        message: {
          authorKind: "agent",
          authorDisplayName: "You",
          body: "Done — trimmed it to three items.",
        },
      });

      // The reply is durably in the engine store with agent authorship (what
      // the desktop rail reads).
      const chats = createLinkedChatStore(ctx.root);
      const messages = await chats.listMessages({
        workspaceId: "ws-chats",
        threadId: thread.id,
      });
      expect(messages.map((message) => message.author)).toEqual([
        { kind: "human", displayName: "Ice de Vera" },
        { kind: "agent", displayName: "You" },
      ]);
      await chats.close();
    });
  });

  it("uses the dohc Cloud email for the agent's on-behalf-of name when present", async () => {
    await withWorkspace(async (ctx) => {
      vi.stubEnv("DOHC_MCP_CLOUD_EMAIL", "ice@example.com");
      await seedEngineFlag(ctx);
      await seedManifest(ctx, "ws-chats");
      const { thread } = await seedLinkedChat(ctx, "ws-chats");
      const reply = await replyToChat(ctx, { threadId: thread.id, body: "On it." });
      expect(reply).toMatchObject({
        ok: true,
        message: { authorKind: "agent", authorDisplayName: "ice@example.com" },
      });
    });
  });

  it("reports an unknown thread as a refusal, not a crash", async () => {
    await withWorkspace(async (ctx) => {
      await seedEngineFlag(ctx);
      await seedManifest(ctx, "ws-chats");
      await seedLinkedChat(ctx, "ws-chats");
      expect(await readChat(ctx, { threadId: "thread-missing" })).toMatchObject({
        ok: false,
        reason: expect.stringContaining("thread-missing"),
      });
      expect(
        await replyToChat(ctx, { threadId: "thread-missing", body: "hello" }),
      ).toMatchObject({ ok: false });
    });
  });
});

describe("channel tools (PR 12/13 slice)", () => {
  it("refuse when the workspace engine flag is absent or off", async () => {
    await withWorkspace(async (ctx) => {
      const expected = { ok: false, reason: expect.stringContaining("not enabled") };
      expect(await listChannels(ctx)).toMatchObject(expected);
      expect(
        await startChannelChat(ctx, { channel: "general", body: "hello" }),
      ).toMatchObject(expected);

      await seedEngineFlag(ctx, false);
      expect(await listChannels(ctx)).toMatchObject(expected);
      expect(
        await startChannelChat(ctx, { channel: "general", body: "hello" }),
      ).toMatchObject(expected);
    });
  });

  it("lists channels (auto-creating general) and starts a chat as the agent", async () => {
    await withWorkspace(async (ctx) => {
      await seedEngineFlag(ctx);
      await seedManifest(ctx, "ws-channels");

      // First chat use: general appears without any prior setup.
      const listed = await listChannels(ctx);
      expect(listed).toMatchObject({
        ok: true,
        channels: [
          { name: "general", slug: "general", kind: "channel", threadCount: 0 },
        ],
      });

      // Channel accepted as a #slug; no title required — the chat displays
      // its first-message snippet.
      const started = await startChannelChat(ctx, {
        channel: "#general",
        body: "Heads up: the import finished.\nDetails inside.",
      });
      expect(started).toMatchObject({
        ok: true,
        channel: { slug: "general" },
        thread: { title: "Heads up: the import finished." },
        message: {
          authorKind: "agent",
          authorDisplayName: "You",
          body: "Heads up: the import finished.\nDetails inside.",
        },
      });
      if (!started.ok) throw new Error("unreachable");

      // The reply tool works against channel threads too, same authorship.
      const reply = await replyToChat(ctx, {
        threadId: started.thread.id,
        body: "Logs are attached.",
      });
      expect(reply).toMatchObject({
        ok: true,
        message: { authorKind: "agent", threadId: started.thread.id },
      });

      // And the thread (with both agent messages) reads back.
      const read = await readChat(ctx, { threadId: started.thread.id });
      expect(read).toMatchObject({
        ok: true,
        messages: [
          { body: "Heads up: the import finished.\nDetails inside." },
          { body: "Logs are attached." },
        ],
      });

      // The channel listing now carries the thread with its snippet title.
      const relisted = await listChannels(ctx);
      expect(relisted).toMatchObject({
        ok: true,
        channels: [
          {
            slug: "general",
            threadCount: 1,
            threads: [
              { title: "Heads up: the import finished.", messageCount: 2 },
            ],
          },
        ],
      });
    });
  });

  it("resolves a channel by its display NAME when it differs from the slug", async () => {
    await withWorkspace(async (ctx) => {
      await seedEngineFlag(ctx);
      await seedManifest(ctx, "ws-channels");
      // "Client ACME" slugifies to "client-acme": the display name and the
      // slug are different strings, unlike the general/#general case that
      // masks a missing name match.
      const chats = createLinkedChatStore(ctx.root);
      const created = await chats.createChannel({
        workspaceId: "ws-channels",
        name: "Client ACME",
      });
      await chats.close();
      expect(created.slug).toBe("client-acme");

      const byName = await startChannelChat(ctx, {
        channel: "Client ACME",
        body: "Kickoff notes for the ACME engagement.",
      });
      expect(byName).toMatchObject({
        ok: true,
        channel: { id: created.id, name: "Client ACME", slug: "client-acme" },
        thread: { title: "Kickoff notes for the ACME engagement." },
      });

      // The documented id and #slug forms keep working beside the name.
      expect(
        await startChannelChat(ctx, { channel: created.id, body: "By id." }),
      ).toMatchObject({ ok: true, channel: { id: created.id } });
      expect(
        await startChannelChat(ctx, { channel: "#client-acme", body: "By slug." }),
      ).toMatchObject({ ok: true, channel: { id: created.id } });
    });
  });

  it("reports an unknown channel as a refusal, not a crash", async () => {
    await withWorkspace(async (ctx) => {
      await seedEngineFlag(ctx);
      await seedManifest(ctx, "ws-channels");
      expect(
        await startChannelChat(ctx, { channel: "no-such-channel", body: "hello" }),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining("channel not found"),
      });
    });
  });
});

describe("isSqliteBusyError", () => {
  it("classifies busy/locked errors, including nested causes", () => {
    expect(isSqliteBusyError(new Error("database is locked"))).toBe(true);
    expect(isSqliteBusyError(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
    expect(
      isSqliteBusyError(new Error("outer", { cause: new Error("database table is locked") })),
    ).toBe(true);
    expect(isSqliteBusyError(new Error("thread not found"))).toBe(false);
    expect(isSqliteBusyError("database is locked")).toBe(false);
  });
});

describe("chat tool registration", () => {
  it("exposes the chat tools with their schemas over the MCP protocol", async () => {
    await withWorkspace(async (ctx) => {
      const server = createDohcMcpServer(ctx);
      const client = new Client({ name: "test-client", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      try {
        const tools = await client.listTools();
        const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
        expect(byName.has("dohc_list_file_chats")).toBe(true);
        expect(byName.has("dohc_read_chat")).toBe(true);
        expect(byName.has("dohc_reply_to_chat")).toBe(true);
        expect(byName.get("dohc_list_file_chats")?.inputSchema).toMatchObject({
          type: "object",
          required: ["path"],
        });
        expect(byName.get("dohc_read_chat")?.inputSchema).toMatchObject({
          type: "object",
          required: ["threadId"],
        });
        expect(byName.get("dohc_reply_to_chat")?.inputSchema).toMatchObject({
          type: "object",
          required: ["threadId", "body"],
        });
        expect(byName.has("dohc_list_channels")).toBe(true);
        expect(byName.get("dohc_start_channel_chat")?.inputSchema).toMatchObject({
          type: "object",
          required: ["channel", "body"],
        });
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});
