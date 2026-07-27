import { DohcCliError } from "@dohc/cli";
import type {
  CliRequestWithoutToken,
  CliResultByVerb,
  CliVerb,
} from "@dohc/cli/protocol";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DOHC_TRANSPORT_UNAVAILABLE_REASON,
  listChannels,
  listChanges,
  listFileChats,
  readChange,
  readChat,
  replyToChat,
  startChannelChat,
  type ToolContext,
} from "./tools";

const moment = {
  id: "moment_1",
  recordedAtMs: 10,
  source: "workspace-engine" as const,
  operation: "write" as const,
  path: "notes/agenda.md",
  versionId: "main",
  summary: "Update agenda",
  fileCount: 1 as const,
};

const thread = {
  id: "thread_1",
  title: "Agenda review",
  createdAtMs: 10,
  updatedAtMs: 20,
  linkedPathHint: "notes/agenda.md",
};

const message = {
  id: "message_1",
  threadId: thread.id,
  authorKind: "agent" as const,
  authorDisplayName: "Ice's agent",
  body: "On it.",
  createdAtMs: 20,
};

const results = {
  moments: {
    changes: [{ ...moment, files: [{ path: moment.path, operation: moment.operation }] }],
    count: 1,
    totalAvailable: 1,
    hasMore: false,
    cursorMs: 10,
  },
  moment: {
    ok: true,
    change: {
      ...moment,
      files: [{ path: moment.path, operation: moment.operation }],
      before: null,
      after: { path: moment.path, text: "# Agenda\n" },
    },
  },
  fileChats: {
    ok: true,
    path: moment.path,
    fileObjectId: "object_1",
    threads: [thread],
  },
  chat: {
    ok: true,
    thread,
    messages: [message],
    projection: {
      path: ".dohc/chats/thread_1.md",
      readOnly: true,
      text: "# Agenda review\n",
    },
  },
  channelsFull: {
    ok: true,
    channels: [
      {
        id: "channel_1",
        name: "General",
        slug: "general",
        kind: "channel" as const,
        threadCount: 1,
        threads: [{
          id: thread.id,
          title: thread.title,
          messageCount: 1,
          updatedAtMs: thread.updatedAtMs,
        }],
      },
    ],
  },
  startChannelChat: {
    ok: true,
    channel: { id: "channel_1", name: "General", slug: "general" },
    thread,
    message,
  },
  replyToChat: {
    ok: true,
    message,
  },
} satisfies {
  [Verb in Extract<
    CliVerb,
    | "moments"
    | "moment"
    | "fileChats"
    | "chat"
    | "channelsFull"
    | "startChannelChat"
    | "replyToChat"
  >]: CliResultByVerb[Verb];
};

async function withWorkspace<T>(fn: (ctx: ToolContext) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "dohc-mcp-cli-proxy-test-"));
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

describe("desktop CLI proxy", () => {
  it("maps all seven engine-backed tools to their CLI verbs with the MCP workspace and agent actor", async () => {
    await withWorkspace(async (base) => {
      const requests: CliRequestWithoutToken[] = [];
      const ctx: ToolContext = {
        ...base,
        request: vi.fn(async (request: CliRequestWithoutToken) => {
          requests.push(request);
          return results[request.verb as keyof typeof results];
        }),
      };

      await expect(listChanges(ctx, { sinceMs: 5, limit: 20, includeFiles: true }))
        .resolves.toEqual(results.moments);
      await expect(readChange(ctx, { id: moment.id })).resolves.toEqual(results.moment);
      await expect(listFileChats(ctx, { path: moment.path })).resolves.toEqual(results.fileChats);
      await expect(readChat(ctx, { threadId: thread.id })).resolves.toEqual(results.chat);
      await expect(listChannels(ctx)).resolves.toEqual(results.channelsFull);
      await expect(
        startChannelChat(ctx, { channel: "general", title: "Agenda review", body: "On it." }),
      ).resolves.toEqual(results.startChannelChat);
      await expect(
        replyToChat(ctx, { threadId: thread.id, body: "On it." }),
      ).resolves.toEqual(results.replyToChat);

      expect(requests.map((request) => request.verb)).toEqual([
        "moments",
        "moment",
        "fileChats",
        "chat",
        "channelsFull",
        "startChannelChat",
        "replyToChat",
      ]);
      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            verb: "moments",
            args: {
              cwd: base.root,
              actor: "agent",
              sinceMs: 5,
              limit: 20,
              includeFiles: true,
            },
          }),
          expect.objectContaining({
            verb: "startChannelChat",
            args: {
              cwd: base.root,
              actor: "agent",
              channel: "general",
              title: "Agenda review",
              body: "On it.",
            },
          }),
          expect.objectContaining({
            verb: "replyToChat",
            args: {
              cwd: base.root,
              actor: "agent",
              threadId: thread.id,
              body: "On it.",
            },
          }),
        ]),
      );
      for (const request of requests) {
        expect(request.protocolVersion).toBe(1);
        expect(request.args).toMatchObject({ cwd: base.root, actor: "agent" });
      }
    });
  });

  it("preserves structured desktop failures instead of replacing them", async () => {
    await withWorkspace(async (base) => {
      const ctx: ToolContext = {
        ...base,
        request: async () => ({ ok: false, reason: "channel is read-only" }),
      };

      await expect(
        startChannelChat(ctx, { channel: "general", body: "Must not post" }),
      ).resolves.toEqual({ ok: false, reason: "channel is read-only" });
    });
  });

  it("returns an honest failure when an injected transport returns an invalid result", async () => {
    await withWorkspace(async (base) => {
      const ctx: ToolContext = {
        ...base,
        request: async () => ({ unexpected: true }),
      };

      await expect(readChat(ctx, { threadId: thread.id })).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining("Invalid discriminator value"),
      });
    });
  });

  it("does not read MCP-side cloud identity files before proxying a chat write", async () => {
    await withWorkspace(async (base) => {
      await writeFile(join(base.home, "dohc-cloud.json"), "{ deliberately invalid");
      await writeFile(join(base.home, "dohc-settings.json"), "{ deliberately invalid");
      const request = vi.fn(async () => results.replyToChat);
      const ctx: ToolContext = { ...base, request };

      await expect(
        replyToChat(ctx, { threadId: thread.id, body: "Identity belongs to main." }),
      ).resolves.toEqual(results.replyToChat);
      expect(request).toHaveBeenCalledOnce();
    });
  });
});

describe("desktop unavailable failures", () => {
  it("write tool with desktop down returns ok:false and does not touch the filesystem", async () => {
    await withWorkspace(async (base) => {
      const ctx: ToolContext = {
        ...base,
        request: async () => {
          throw new DohcCliError("desktop app not running");
        },
      };

      await expect(
        replyToChat(ctx, { threadId: thread.id, body: "Must not be stored" }),
      ).resolves.toEqual({
        ok: false,
        reason: DOHC_TRANSPORT_UNAVAILABLE_REASON,
      });
      await expect(readdir(base.root)).resolves.toEqual([]);
      await expect(readdir(base.home)).resolves.toEqual([]);
      await expect(access(join(base.root, ".dohc"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("listChanges with desktop down returns ok:false rather than an empty list", async () => {
    await withWorkspace(async (base) => {
      const ctx: ToolContext = {
        ...base,
        request: async () => {
          throw new DohcCliError("desktop app not running");
        },
      };

      const result = await listChanges(ctx);

      expect(result).toEqual({
        ok: false,
        reason: DOHC_TRANSPORT_UNAVAILABLE_REASON,
      });
      expect(result).not.toHaveProperty("changes");
    });
  });
});
