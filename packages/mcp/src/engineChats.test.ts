import { DohcCliError } from "@dohc/cli/errors";
import {
  CLI_PROTOCOL_VERSION,
  type CliRequestWithoutToken,
  type CliResultByVerb,
  type CliVerb,
} from "@dohc/cli/protocol";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DOHC_TRANSPORT_UNAVAILABLE_REASON,
  listGroups,
  listChanges,
  listFileChats,
  readChange,
  readChat,
  replyToChat,
  startGroupChat,
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
  id: "thread-1",
  title: "Agenda review",
  createdAtMs: 10,
  updatedAtMs: 20,
  linkedPathHint: "notes/agenda.md",
};

const message = {
  id: "message-1",
  threadId: thread.id,
  authorKind: "agent" as const,
  authorDisplayName: "Nova",
  body: "On it.",
  createdAtMs: 20,
  attachments: [{ objectId: "object_1", pathHint: "notes/agenda.md" }],
  needsDecision: true,
  decisionState: "resolved" as const,
  options: ["Ship", "Hold"],
  chosenOption: "Ship",
  resolvedByMessageId: "message-2",
  parentMessageId: "message-0",
};

const PROVENANCE_WARNING =
  "Message posted, but agent-run provenance could not be recorded after 3 attempts; recovery will continue in the background.";

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
      path: ".dohc/chats/thread-1.md",
      readOnly: true,
      text: "# Agenda review\n",
    },
  },
  groupsFull: {
    ok: true,
    groups: [
      {
        id: "channel-1",
        name: "General",
        slug: "general",
        kind: "group" as const,
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
  // The desktop answers post/reply with the CLI's short display handles.
  post: {
    group: { id: "ch_1", name: "General", slug: "general", kind: "group" as const },
    threadId: "th_2",
    messageId: "msg_2",
    title: "Agenda review",
  },
  reply: {
    threadId: "th_1",
    messageId: "msg_3",
    parentMessageId: "msg_1",
    resolvedMessageId: "msg_1",
    warning: PROVENANCE_WARNING,
  },
} satisfies {
  [Verb in Extract<
    CliVerb,
    "moments" | "moment" | "fileChats" | "chat" | "groupsFull" | "post" | "reply"
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

function recordingContext(base: ToolContext): {
  ctx: ToolContext;
  requests: CliRequestWithoutToken[];
} {
  const requests: CliRequestWithoutToken[] = [];
  const ctx: ToolContext = {
    ...base,
    request: vi.fn(async (request: CliRequestWithoutToken) => {
      requests.push(request);
      return results[request.verb as keyof typeof results];
    }),
  };
  return { ctx, requests };
}

describe("desktop CLI proxy", () => {
  it("maps the engine-backed read tools to their CLI verbs with the MCP workspace and agent actor", async () => {
    await withWorkspace(async (base) => {
      const { ctx, requests } = recordingContext(base);

      await expect(listChanges(ctx, { sinceMs: 5, limit: 20, includeFiles: true }))
        .resolves.toEqual(results.moments);
      await expect(readChange(ctx, { id: moment.id })).resolves.toEqual(results.moment);
      await expect(listFileChats(ctx, { path: moment.path })).resolves.toEqual(results.fileChats);
      await expect(readChat(ctx, { threadId: thread.id })).resolves.toEqual(results.chat);
      await expect(listGroups(ctx)).resolves.toEqual(results.groupsFull);

      expect(requests.map((request) => request.verb)).toEqual([
        "moments",
        "moment",
        "fileChats",
        "chat",
        "groupsFull",
      ]);
      expect(requests[0]).toMatchObject({
        verb: "moments",
        args: {
          cwd: base.root,
          actor: "agent",
          sinceMs: 5,
          limit: 20,
          includeFiles: true,
        },
      });
      for (const request of requests) {
        expect(request.protocolVersion).toBe(CLI_PROTOCOL_VERSION);
        expect(request.args).toMatchObject({ cwd: base.root, actor: "agent" });
      }
    });
  });

  it("sends chat writes as the CLI post and reply verbs with every option the CLI accepts", async () => {
    await withWorkspace(async (base) => {
      const { ctx, requests } = recordingContext(base);

      await startGroupChat(ctx, { group: "general", title: "Agenda review", body: "On it." });
      await startGroupChat(ctx, {
        group: "#general",
        body: "Ship it?",
        attachments: ["notes/agenda.md"],
        needsDecision: true,
        options: ["Ship", "Hold"],
        runId: "run_1",
      });
      await replyToChat(ctx, { threadId: thread.id, body: "On it." });
      await replyToChat(ctx, {
        threadId: thread.id,
        to: message.id,
        resolve: message.id,
        choose: "Ship",
        attachments: ["notes/agenda.md"],
        needsDecision: true,
        options: ["Ship", "Hold"],
        runId: "run_1",
        body: "Shipping.",
      });

      // The bare call carries the CLI's own defaults: no attachments, no
      // decision, no run. Nothing is invented on the agent's behalf.
      expect(requests.map((request) => [request.verb, request.args])).toEqual([
        ["post", {
          cwd: base.root,
          actor: "agent",
          group: "general",
          title: "Agenda review",
          attachments: [],
          needsDecision: false,
          body: "On it.",
        }],
        ["post", {
          cwd: base.root,
          actor: "agent",
          runId: "run_1",
          group: "#general",
          attachments: ["notes/agenda.md"],
          needsDecision: true,
          options: ["Ship", "Hold"],
          body: "Ship it?",
        }],
        ["reply", {
          cwd: base.root,
          actor: "agent",
          thread: thread.id,
          attachments: [],
          needsDecision: false,
          body: "On it.",
        }],
        ["reply", {
          cwd: base.root,
          actor: "agent",
          runId: "run_1",
          thread: thread.id,
          to: message.id,
          resolve: message.id,
          choose: "Ship",
          attachments: ["notes/agenda.md"],
          needsDecision: true,
          options: ["Ship", "Hold"],
          body: "Shipping.",
        }],
      ]);
      for (const request of requests) {
        expect(request.protocolVersion).toBe(CLI_PROTOCOL_VERSION);
      }
    });
  });

  it("omits CLI display aliases from the posted group descriptor", async () => {
    await withWorkspace(async (base) => {
      const ctx: ToolContext = {
        ...base,
        request: async () => ({
          ...results.post,
          group: { id: "ch_agent", name: "my-agent", slug: "my-agent", kind: "agent" },
        }),
      };
      const result = await startGroupChat(ctx, { group: "my-agent", body: "On it." });
      expect(result).toMatchObject({
        ok: true,
        group: { id: "channel-agent", slug: "my-agent", kind: "agent" },
      });
      if (!result.ok) throw new Error(result.reason);
      expect(result.group).not.toHaveProperty("name");
    });
  });

  it("returns engine ids from chat writes so dohc_read_chat and dohc_list_groups accept them", async () => {
    await withWorkspace(async (base) => {
      const { ctx } = recordingContext(base);

      await expect(
        startGroupChat(ctx, { group: "general", body: "On it." }),
      ).resolves.toEqual({
        ok: true,
        group: { id: "channel-1", slug: "general", kind: "group" },
        threadId: "thread-2",
        messageId: "message-2",
        title: "Agenda review",
      });
      // A partial success (posted, provenance still pending) stays visible.
      await expect(
        replyToChat(ctx, { threadId: thread.id, body: "On it." }),
      ).resolves.toEqual({
        ok: true,
        threadId: "thread-1",
        messageId: "message-3",
        parentMessageId: "message-1",
        resolvedMessageId: "message-1",
        warning: PROVENANCE_WARNING,
      });
    });
  });

  it("reports a desktop refusal as a failed tool result carrying the desktop's reason", async () => {
    await withWorkspace(async (base) => {
      const ctx: ToolContext = {
        ...base,
        request: async (request) => {
          throw new DohcCliError(
            request.verb === "post"
              ? "dohc: no such group: nope"
              : "dohc: message is not an open decision: msg_1",
          );
        },
      };

      await expect(
        startGroupChat(ctx, { group: "nope", body: "Must not post" }),
      ).resolves.toEqual({ ok: false, reason: "dohc: no such group: nope" });
      await expect(
        replyToChat(ctx, { threadId: thread.id, resolve: message.id, body: "Must not post" }),
      ).resolves.toEqual({
        ok: false,
        reason: "dohc: message is not an open decision: msg_1",
      });
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
      // A malformed write response is never widened into a success.
      await expect(
        startGroupChat(ctx, { group: "general", body: "On it." }),
      ).resolves.toMatchObject({ ok: false, reason: expect.any(String) });
    });
  });

  it("does not read MCP-side cloud identity files before proxying a chat write", async () => {
    await withWorkspace(async (base) => {
      await writeFile(join(base.home, "dohc-cloud.json"), "{ deliberately invalid");
      await writeFile(join(base.home, "dohc-settings.json"), "{ deliberately invalid");
      const request = vi.fn(async () => results.reply);
      const ctx: ToolContext = { ...base, request };

      await expect(
        replyToChat(ctx, { threadId: thread.id, body: "Identity belongs to main." }),
      ).resolves.toMatchObject({ ok: true, messageId: "message-3" });
      expect(request).toHaveBeenCalledOnce();
    });
  });
});

describe("desktop unavailable failures", () => {
  it("write tools with desktop down return ok:false and do not touch the filesystem", async () => {
    await withWorkspace(async (base) => {
      const ctx: ToolContext = {
        ...base,
        request: async () => {
          throw new DohcCliError("desktop app not running");
        },
      };

      await expect(
        startGroupChat(ctx, { group: "general", body: "Must not be stored" }),
      ).resolves.toEqual({
        ok: false,
        reason: DOHC_TRANSPORT_UNAVAILABLE_REASON,
      });
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
