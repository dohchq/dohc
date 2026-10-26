import { describe, expect, it, vi } from "vitest";
import { createActorIssuer, deriveMomentActor, parseActorKey } from "@dohc/workspace-contracts/actor-identity";
import type { ChatMessage, ChatReaction } from "@dohc/workspace-contracts/engine";
import { createChatWrites, type ChatWriter, type PersonWriter, type ChatWriteStore } from "./chatWrites";
import { AutomationChatSessionWait } from "@dohc/automation-executor/automation-chat";
import type { CloudCredentials } from "./cloudCredentialStore";
import type { JoinedSharedChannel, RegistryEntry } from "./registryStore";
import { deferred, type Deferred } from "../testing/deferred";

const PERSON: PersonWriter = { via: "renderer" };
const AGENT: PersonWriter = { via: "cli", actor: "agent" };
const signedIn = (userId: string): CloudCredentials => ({
  serverUrl: "https://cloud.test", relayUrl: "https://relay.test", userId,
  email: `${userId}@test.invalid`, token: `token-${userId}`,
});
const joined: JoinedSharedChannel = {
  shareId: "share", channelWireId: "wire", access: "read-write", granterEmail: null,
  relayUrl: "https://relay.test", recipientUserId: "user-1",
};

// The async steps a write can await before its row. A test can hold one.
type Pause = "channel" | "wire" | "warm" | "attachments" | "reactions";

function fixture() {
  const events: string[] = [];
  const holds = new Map<Pause, { entered: Deferred; held: Deferred }>();
  async function reach(point: Pause) {
    events.push(point);
    const hold = holds.get(point);
    if (!hold) return;
    holds.delete(point);
    hold.entered.resolve();
    await hold.held.promise;
  }
  const row: Pick<RegistryEntry, "remote" | "pausedRemote" | "shareView" | "sharedChannels"> = {
    remote: { serverUrl: "https://cloud.test", ownerUserId: "user-1" },
  };
  const reactions: ChatReaction[] = [];
  const message = ({ automation: _automation, authorActorKey, ...input }: Parameters<ChatWriteStore["sendMessage"]>[0]): ChatMessage => ({
    ...input, ...(authorActorKey !== null ? { authorActorKey } : {}), id: "message", createdAtMs: 2,
    attachments: (input.attachments ?? []).map((attachment, index) => ({
      ...attachment, attachmentId: `attachment-${index}`, threadId: input.threadId,
      messageId: "message", targetKind: "file", createdAtMs: 2,
    })),
  });
  const store = {
    getMessage: vi.fn<ChatWriteStore["getMessage"]>(async () => { throw Error("missing message"); }),
    listChannelThreads: vi.fn<ChatWriteStore["listChannelThreads"]>(async () => []),
    findThreadChannelId: vi.fn(async () => {
      await reach("channel");
      return "channel";
    }),
    getChannelWireId: vi.fn(async (): Promise<string | null> => {
      await reach("wire");
      return "wire";
    }),
    createThread: vi.fn<ChatWriteStore["createThread"]>(async (input) => ({
      id: "file-thread", workspaceId: input.workspaceId, title: input.title, createdAtMs: 1,
      updatedAtMs: 1, linkedFile: { ...input.linkedFile, linkedAtMs: 1 },
    })),
    sendMessage: vi.fn<ChatWriteStore["sendMessage"]>(async (input) => {
      events.push("write");
      return message(input);
    }),
    startChannelThread: vi.fn<ChatWriteStore["startChannelThread"]>(async (input) => {
      events.push("write");
      return {
        thread: { id: "thread", workspaceId: input.workspaceId, title: "", createdAtMs: 1, updatedAtMs: 1 },
        message: message({ ...input, threadId: "thread" }),
      };
    }),
    resolveChatDecision: vi.fn<ChatWriteStore["resolveChatDecision"]>(async (input) => {
      events.push("resolve");
      return { ...input, state: "resolved", atMs: 3 };
    }),
    listReactions: vi.fn<ChatWriteStore["listReactions"]>(async () => {
      await reach("reactions");
      return [...reactions];
    }),
    setReaction: vi.fn<ChatWriteStore["setReaction"]>(async (input) => {
      events.push(`react:${input.author.authorId}:${input.state}`);
      const reaction = { ...input, reactionId: `${input.author.authorId}:${input.emoji}`, atMs: 4 };
      const index = reactions.findIndex((entry) => entry.reactionId === reaction.reactionId);
      if (index >= 0) reactions.splice(index, 1);
      if (input.state === "added") reactions.push(reaction);
      return reaction;
    }),
  };
  let credentials: CloudCredentials | null = signedIn("user-1");
  // The credential cache bumps its generation whenever it replaces a session.
  let generation = 1;
  let displayName = "Sam";
  const warmCredentials = vi.fn(async () => {
    await reach("warm");
  });
  const effects = {
    projectChatBookmarks: vi.fn(),
    queueCloudSync: vi.fn(),
    syncSharedChannelsForChatTarget: vi.fn(async () => undefined),
    scanChatDispatch: vi.fn(async () => undefined),
    notifyRenderer: vi.fn(),
  };
  const writes = createChatWrites({
    findWorkspace: () => row,
    warmCredentials,
    currentCredentials: () => credentials,
    currentCredentialGeneration: () => generation,
    localUserDisplayName: () => displayName,
    agentDisplayName: async () => "Nova",
    localInstallationId: () => "local-id",
    // Marks where an answer holds dispatch scans off.
    async betweenDispatchScans(_workspaceId, write) {
      events.push("hold");
      try {
        return await write();
      } finally {
        events.push("release");
      }
    },
    ...effects,
  });
  const place = { workspaceId: "workspace", store };
  const attachments = vi.fn(async () => {
    await reach("attachments");
    return [{ objectId: "object", pathHint: "notes.md" }];
  });
  return {
    events, row, reactions, store, warmCredentials, effects, writes, place, attachments,
    setDisplayName: (name: string) => { displayName = name; },
    setCredentials: (value: CloudCredentials | null) => {
      credentials = value;
      generation += 1;
    },
    holdAt(point: Pause) {
      const hold = { entered: deferred(), held: deferred() };
      holds.set(point, hold);
      return hold;
    },
    // One call per write kind, each through the module's public interface.
    writeEach: {
      send: () => writes.sendMessage(place, { writer: PERSON, threadId: "thread", body: "Hi", resolveAttachments: attachments }),
      start: () => writes.startThread(place, { writer: AGENT, channelId: "channel", body: "Hi", resolveAttachments: attachments }),
      react: () => writes.setReaction(place, { writer: PERSON, threadId: "thread", messageId: "message", emoji: "👍", state: "added" }),
      toggle: () => writes.setReaction(place, { writer: PERSON, threadId: "thread", messageId: "message", emoji: "👍", state: "toggle" }),
      answer: () => writes.answer(place, {
        writer: PERSON, threadId: "thread", body: "Monday", resolveAttachments: attachments,
        resolves: { messageId: "question", chosenOption: "Monday" },
      }),
    },
  };
}

function expectNothingWritten(test: ReturnType<typeof fixture>) {
  for (const method of ["createThread", "sendMessage", "startChannelThread", "resolveChatDecision", "setReaction"] as const) {
    expect(test.store[method]).not.toHaveBeenCalled();
  }
  for (const effect of Object.values(test.effects)) expect(effect).not.toHaveBeenCalled();
}

describe("chat writes", () => {
  const automationWriter: ChatWriter = { via: "automation", automationId: "collection:Tasks#post", name: "Post", depth: 1 };
  const retained: ChatMessage = { id: "stable-message", workspaceId: "workspace", threadId: "thread", body: "Hello", createdAtMs: 1,
    author: { kind: "automation", displayName: "Post" }, authorOwnerDisplayName: "Sam", authorUserId: "user-1",
    automation: { automationId: "collection:Tasks#post" }, attachments: [] };

  it.each(["name", "account", "signed-out"])("finds an automation's existing message after its owner's %s changes", async change => {
    const test = fixture();
    if (change === "name") test.setDisplayName("Renamed");
    else test.setCredentials(change === "account" ? signedIn("user-2") : null);
    test.store.sendMessage.mockRejectedValue(new Error("payload mismatch"));
    test.store.getMessage.mockResolvedValue(retained);
    await expect(test.writes.sendMessage(test.place, { writer: automationWriter, threadId: "thread", body: "Hello", messageId: retained.id,
      idempotencyKey: "effect", resolveAttachments: async () => [] })).resolves.toEqual(retained);
    if (change === "name") expect(test.store.sendMessage.mock.calls[0]?.[0].authorOwnerDisplayName).toBe("Renamed");
    expect(test.store.sendMessage).toHaveBeenCalledTimes(change === "name" ? 1 : 0);
  });

  it("finds the existing automation post's thread after a name change", async () => {
    const test = fixture();
    test.setDisplayName("Renamed");
    test.store.startChannelThread.mockRejectedValue(new Error("payload mismatch"));
    test.store.getMessage.mockResolvedValue(retained);
    const thread = { id: "thread", workspaceId: "workspace", title: "", createdAtMs: 1, updatedAtMs: 1 };
    test.store.listChannelThreads.mockResolvedValue([{ thread } as Awaited<ReturnType<ChatWriteStore["listChannelThreads"]>>[number]]);
    await expect(test.writes.startThread(test.place, { writer: automationWriter, channelId: "channel", body: "Hello", messageId: retained.id,
      threadId: "thread", idempotencyKey: "effect", resolveAttachments: async () => [] })).resolves.toEqual({ thread, message: retained });
  });

  it.each(["missing", "author", "automation", "body", "target"])("refuses a failed automation send whose stored receipt has the wrong %s", async mismatch => {
    const test = fixture();
    test.store.sendMessage.mockRejectedValue(new Error("payload mismatch"));
    const sent = structuredClone(retained);
    if (mismatch === "author") sent.author.kind = "human";
    if (mismatch === "automation") sent.automation!.automationId = "other";
    if (mismatch === "body") sent.body = "other";
    if (mismatch === "target") sent.threadId = "other";
    if (mismatch !== "missing") test.store.getMessage.mockResolvedValue(sent);
    await expect(test.writes.sendMessage(test.place, { writer: automationWriter, threadId: "thread", body: "Hello", messageId: retained.id,
      idempotencyKey: "effect", resolveAttachments: async () => [] })).rejects.toThrow("payload mismatch");
    expect(test.effects.notifyRenderer).not.toHaveBeenCalled();
  });
  it.each([PERSON, AGENT])("refuses invalid message bodies before any write for %j", async writer => {
    for (const [body, reason] of [
      ["界".repeat(30_000), "The message is longer than 64 KiB. Shorten it."],
      [" \r\n\uFEFF", "The message is empty. Enter a message."],
    ] as const) {
      const test = fixture();
      await expect(test.writes.sendMessage(test.place, { writer, threadId: "thread", body, resolveAttachments: test.attachments }))
        .rejects.toThrow(reason);
      await expect(test.writes.startThread(test.place, { writer, channelId: "channel", body, resolveAttachments: test.attachments }))
        .rejects.toThrow(reason);
      expect(test.attachments).not.toHaveBeenCalled();
      expectNothingWritten(test);
    }
  });

  it("normalizes exactly 64 KiB as UTF-8 before sending and starting a thread", async () => {
    const test = fixture();
    const body = "界".repeat(21_844) + "\r\nx\r\ny\uFEFF ";
    const normalized = "界".repeat(21_844) + "\nx\ny";
    expect(new TextEncoder().encode(normalized)).toHaveLength(65_536);
    await test.writes.sendMessage(test.place, { writer: PERSON, threadId: "thread", body, resolveAttachments: test.attachments });
    await test.writes.startThread(test.place, { writer: AGENT, channelId: "channel", body, resolveAttachments: test.attachments });
    expect(test.store.sendMessage.mock.calls[0]?.[0].body).toBe(normalized);
    expect(test.store.startChannelThread.mock.calls[0]?.[0].body).toBe(normalized);
  });

  it("writes a person's message under the verified identity and runs every message effect", async () => {
    const test = fixture();
    const sent = await test.writes.sendMessage(test.place, {
      writer: PERSON, threadId: "thread", parentMessageId: "parent", body: "Hello", resolveAttachments: test.attachments,
    });
    expect(test.store.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace", threadId: "thread", parentMessageId: "parent", body: "Hello",
      author: { kind: "human", displayName: "Sam" }, authorUserId: "user-1",
      attachments: [{ objectId: "object", pathHint: "notes.md" }],
    }));
    expect(sent.id).toBe("message");
    expect(test.effects.projectChatBookmarks).toHaveBeenCalledWith("workspace");
    expect(test.effects.scanChatDispatch).toHaveBeenCalledWith("workspace");
    expect(test.effects.queueCloudSync).toHaveBeenCalledWith("workspace");
    expect(test.effects.syncSharedChannelsForChatTarget).toHaveBeenCalledWith("workspace", { threadId: "thread" });
  });

  it("writes an agent's thread under its own name, its owner, and the CLI origin", async () => {
    const test = fixture();
    await test.writes.startThread(test.place, {
      writer: AGENT, channelId: "channel", lane: "chat", title: "Plan", body: "Pick one",
      needsDecision: true, options: ["A", "B"], resolveAttachments: async () => [],
    });
    expect(test.store.startChannelThread).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace", channelId: "channel", lane: "chat", title: "Plan", body: "Pick one",
      author: { kind: "agent", displayName: "Nova" }, authorOwnerDisplayName: "Sam",
      authorUserId: "user-1", origin: "cli", needsDecision: true, options: ["A", "B"],
    }));
    expect(test.effects.projectChatBookmarks).toHaveBeenCalledWith("workspace");
    expect(test.effects.scanChatDispatch).toHaveBeenCalledWith("workspace");
    expect(test.effects.syncSharedChannelsForChatTarget).toHaveBeenCalledWith("workspace", { channelId: "channel" });
  });

  it("writes an automation's post under its own name, its person, its ids, and its chain depth", async () => {
    const test = fixture();
    const automation: ChatWriter = { via: "automation", automationId: "collection:Tasks#tell", name: "Tell the trip", depth: 2 };
    await test.writes.startThread(test.place, {
      writer: automation, channelId: "channel", lane: "posts", threadId: "thread-auto-1", body: "Done",
      messageId: "message-auto-1", idempotencyKey: "atc_1/h/0/post", resolveAttachments: async () => [],
    });
    expect(test.store.startChannelThread).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace", channelId: "channel", lane: "posts", threadId: "thread-auto-1", body: "Done",
      messageId: "message-auto-1", idempotencyKey: "atc_1/h/0/post",
      author: { kind: "automation", displayName: "Tell the trip" }, authorOwnerDisplayName: "Sam",
      automation: { automationId: "collection:Tasks#tell", chainDepth: 2 }, authorUserId: "user-1",
    }));
    // Nothing on screen asked for it, so the windows hear of it.
    expect(test.effects.notifyRenderer).toHaveBeenCalledWith("workspace");
  });

  it("stops an automation's message at its signal, just before the row", async () => {
    const test = fixture();
    const stop = new AbortController();
    const hold = test.holdAt("attachments");
    const writing = test.writes.startThread(test.place, {
      writer: { via: "automation", automationId: "collection:Tasks#tell", name: "Tell", depth: 1 },
      channelId: "channel", body: "Done", signal: stop.signal, resolveAttachments: test.attachments,
    });
    await hold.entered.promise;
    stop.abort();
    hold.held.resolve();
    await expect(writing).rejects.toMatchObject({ name: "AbortError" });
    expect(test.store.startChannelThread).not.toHaveBeenCalled();
  });

  it("makes an automation wait for a session before a joined Group's identity check refuses it", async () => {
    const test = fixture();
    test.row.sharedChannels = [joined];
    test.setCredentials(null);
    await expect(test.writes.sendMessage(test.place, {
      writer: { via: "automation", automationId: "collection:Tasks#tell", name: "Tell", depth: 1 },
      threadId: "thread", body: "Done", resolveAttachments: async () => [],
    })).rejects.toBeInstanceOf(AutomationChatSessionWait);
    expect(test.store.sendMessage).not.toHaveBeenCalled();
  });

  it("writes an automation's wake in My agent without waiting for a session", async () => {
    const test = fixture();
    test.setCredentials(null);
    await test.writes.sendMessage(test.place, {
      writer: { via: "automation", automationId: "collection:Tasks#ask", name: "Ask", depth: 1, local: true },
      threadId: "thread", body: "Plan", resolveAttachments: async () => [],
    });
    expect(test.store.sendMessage.mock.calls[0]![0]).not.toHaveProperty("authorUserId");
  });

  it("makes an automation wait for a session in a synced workspace instead of posting where nobody sees", async () => {
    const test = fixture();
    test.setCredentials(null);
    await expect(test.writes.sendMessage(test.place, {
      writer: { via: "automation", automationId: "collection:Tasks#tell", name: "Tell", depth: 1 },
      threadId: "thread", body: "Done", resolveAttachments: async () => [],
    })).rejects.toBeInstanceOf(AutomationChatSessionWait);
    expect(test.store.sendMessage).not.toHaveBeenCalled();
  });

  it("omits the relay author for a signed-out message outside a joined channel", async () => {
    const test = fixture();
    test.setCredentials(null);
    await test.writeEach.send();
    expect(test.store.sendMessage.mock.calls[0]![0]).not.toHaveProperty("authorUserId");
  });

  it("resolves the target's wire id once, and not at all without joined channels", async () => {
    const test = fixture();
    await test.writeEach.send();
    await test.writeEach.toggle();
    expect(test.store.findThreadChannelId).not.toHaveBeenCalled();
    expect(test.store.getChannelWireId).not.toHaveBeenCalled();
    test.row.sharedChannels = [joined];
    test.events.length = 0;
    await test.writeEach.send();
    expect(test.events).toEqual(["warm", "channel", "wire", "attachments", "write"]);
  });

  for (const grant of ["read-only", "ended"] as const) {
    it.each(["send", "start", "react", "answer"] as const)(`refuses %s in a ${grant} joined channel before any row`, async (kind) => {
      const test = fixture();
      test.row.sharedChannels = [grant === "read-only" ? { ...joined, access: "read-only" } : { ...joined, ended: true }];
      await expect(test.writeEach[kind]()).rejects.toThrow("You can only read this.");
      expect(test.attachments).not.toHaveBeenCalled();
      expectNothingWritten(test);
    });
  }

  it.each(["send", "start", "react", "answer", "file"] as const)("refuses %s in a received share before any store read", async (kind) => {
    const test = fixture();
    test.row.shareView = {
      shareId: "share", granterEmail: "owner@test.invalid", genericChatWritable: true,
      grantedSelector: { paths: ["notes"], versionId: null, access: "edit" },
    };
    const linkedFile = vi.fn(async () => ({ objectId: "object", pathHint: "notes.md" }));
    const write = kind === "file"
      ? test.writes.createFileThread(test.place, { title: "Notes", linkedFile })
      : test.writeEach[kind]();
    await expect(write).rejects.toThrow("Chats are read-only in this shared view.");
    expect(linkedFile).not.toHaveBeenCalled();
    expect(test.store.findThreadChannelId).not.toHaveBeenCalled();
    expect(test.warmCredentials).not.toHaveBeenCalled();
    expectNothingWritten(test);
  });

  it.each(["send", "start", "react", "answer"] as const)("requires the joined account to %s in a joined channel", async (kind) => {
    const test = fixture();
    test.row.sharedChannels = [joined];
    test.setCredentials(null);
    await expect(test.writeEach[kind]()).rejects.toThrow("Sign in to your server to send a message here.");
    expect(test.attachments).not.toHaveBeenCalled();
    expectNothingWritten(test);
    test.setCredentials(signedIn("user-2"));
    await expect(test.writeEach[kind]()).rejects.toThrow("Sign in to the account that joined this.");
    expectNothingWritten(test);
  });

  // Every await before a row is followed by a synchronous check of the grant
  // and the session together. These change each one during each await.
  describe("a change while a write awaits", () => {
    const changes = {
      "sign-out": {
        apply: (test: ReturnType<typeof fixture>) => test.setCredentials(null),
        refusal: "Sign in to your server to send a message here.",
      },
      "account switch": {
        apply: (test: ReturnType<typeof fixture>) => test.setCredentials(signedIn("user-2")),
        refusal: "Sign in to the account that joined this.",
      },
      "read-only downgrade": {
        apply: (test: ReturnType<typeof fixture>) => { test.row.sharedChannels = [{ ...joined, access: "read-only" }]; },
        refusal: "You can only read this.",
      },
    };
    const cases = [
      ["send", ["wire", "warm", "attachments"]],
      ["answer", ["wire", "warm", "attachments"]],
      ["toggle", ["wire", "warm", "reactions"]],
    ] as const;

    for (const [kind, points] of cases) {
      for (const point of points) {
        for (const [change, { apply, refusal }] of Object.entries(changes)) {
          it(`refuses ${kind} after a ${change} while it awaits ${point}`, async () => {
            const test = fixture();
            test.row.sharedChannels = [joined];
            const hold = test.holdAt(point);
            const outcome = test.writeEach[kind]().catch((error: unknown) => error);
            await hold.entered.promise;
            apply(test);
            hold.held.resolve();
            expect(await outcome).toMatchObject({ message: refusal });
            expectNothingWritten(test);
          });
        }
      }
    }

    it.each([
      ["a sign-out", null],
      ["an account switch", signedIn("user-2")],
    ] as const)("refuses a message after %s outside a joined channel", async (_change, next) => {
      const test = fixture();
      const hold = test.holdAt("attachments");
      const outcome = test.writeEach.send().catch((error: unknown) => error);
      await hold.entered.promise;
      test.setCredentials(next);
      hold.held.resolve();
      expect(await outcome).toMatchObject({ message: "Your server session changed. Try again." });
      expectNothingWritten(test);
    });

    // Admission skipped the wire id lookup because nothing was joined. A join
    // before the row makes the lookup necessary, and the write does it then.
    it("writes to a local thread when an unrelated channel is joined mid-write", async () => {
      const test = fixture();
      test.attachments.mockImplementationOnce(async () => {
        test.row.sharedChannels = [{ ...joined, channelWireId: "elsewhere", access: "read-only" }];
        return [];
      });
      await expect(test.writeEach.send()).resolves.toMatchObject({ authorUserId: "user-1" });
      expect(test.events).toEqual(["warm", "channel", "wire", "write"]);
    });

    it("enforces the grant when the target's own channel is joined mid-write", async () => {
      const test = fixture();
      test.attachments.mockImplementationOnce(async () => {
        test.row.sharedChannels = [{ ...joined, access: "read-only" }];
        return [];
      });
      await expect(test.writeEach.send()).rejects.toThrow("You can only read this.");
      expectNothingWritten(test);
    });

    // The final check must share a synchronous block with the store call. A
    // continuation chained on the attachment promise runs after the module's
    // own await of it, so it lands wherever the module next yields.
    it.each([
      ["send", "a sign-out", "Sign in to your server to send a message here."],
      ["send", "a read-only downgrade", "You can only read this."],
      ["start", "a sign-out", "Sign in to your server to send a message here."],
      ["start", "a read-only downgrade", "You can only read this."],
    ] as const)("refuses %s after %s chained on its attachments", async (kind, change, refusal) => {
      const test = fixture();
      test.row.sharedChannels = [joined];
      const ready = Promise.resolve([]);
      test.attachments.mockImplementationOnce(() => {
        void ready.then(() => undefined).then(() => {
          if (change === "a sign-out") test.setCredentials(null);
          else test.row.sharedChannels = [{ ...joined, access: "read-only" }];
        });
        return ready;
      });
      await expect(test.writeEach[kind]()).rejects.toThrow(refusal);
      expectNothingWritten(test);
    });

    it.each(["send", "answer", "toggle"] as const)("refuses %s when the same account's session is replaced during target resolution", async (kind) => {
      const test = fixture();
      test.row.sharedChannels = [joined];
      const hold = test.holdAt("wire");
      const outcome = test.writeEach[kind]().catch((error: unknown) => error);
      await hold.entered.promise;
      test.setCredentials(signedIn("user-1"));
      hold.held.resolve();
      expect(await outcome).toMatchObject({ message: "Your server session changed. Try again." });
      expectNothingWritten(test);
    });

    it("refuses a message when the same account's session is replaced during attachments", async () => {
      const test = fixture();
      const hold = test.holdAt("attachments");
      const outcome = test.writeEach.send().catch((error: unknown) => error);
      await hold.entered.promise;
      test.setCredentials(signedIn("user-1"));
      hold.held.resolve();
      expect(await outcome).toMatchObject({ message: "Your server session changed. Try again." });
      expectNothingWritten(test);
    });
  });

  it("writes a reply and its answer in one hold of dispatch scans, then wakes dispatch", async () => {
    const test = fixture();
    test.effects.scanChatDispatch.mockImplementation(async () => {
      test.events.push("scan");
    });
    const answered = await test.writeEach.answer();
    expect(test.events).toEqual(["warm", "attachments", "hold", "write", "resolve", "release", "scan"]);
    expect(test.store.resolveChatDecision).toHaveBeenCalledWith({
      workspaceId: "workspace", threadId: "thread", messageId: "question",
      resolvedByMessageId: "message", chosenOption: "Monday",
    });
    expect(answered).toMatchObject({ message: { id: "message" }, decision: { state: "resolved" } });
  });

  it("keeps the reply and leaves the question open when the session changes before the answer", async () => {
    const test = fixture();
    const send = test.store.sendMessage.getMockImplementation()!;
    test.store.sendMessage.mockImplementationOnce(async (input) => {
      const message = await send(input);
      test.setCredentials(signedIn("user-1"));
      return message;
    });
    const answered = await test.writeEach.answer();
    expect(answered).toMatchObject({ message: { id: "message" }, failure: { message: "Your server session changed. Try again." } });
    expect(test.store.resolveChatDecision).not.toHaveBeenCalled();
    expect(test.effects.scanChatDispatch).toHaveBeenCalledWith("workspace");
  });

  it("toggles a signed-out reaction under the install's local id without a relay author", async () => {
    const test = fixture();
    test.setCredentials(null);
    const toggle = () => test.writes.setReaction(test.place, {
      writer: { via: "cli", actor: "human" }, threadId: "thread", messageId: "message", emoji: "👍", state: "toggle",
    });
    expect(await toggle()).toMatchObject({ state: "added", author: { authorId: "local-id", kind: "human", displayName: "Sam" } });
    expect(await toggle()).toMatchObject({ state: "removed" });
    for (const [mutation] of test.store.setReaction.mock.calls) expect(mutation).not.toHaveProperty("replicationAuthorId");
    expect(test.reactions).toEqual([]);
  });

  it("removes a signed-out reaction's local alias once signed in", async () => {
    const test = fixture();
    test.setCredentials(null);
    await test.writeEach.react();
    test.setCredentials(signedIn("user-1"));
    const removed = await test.writes.setReaction(test.place, {
      writer: PERSON, threadId: "thread", messageId: "message", emoji: "👍", state: "removed",
    });
    expect(removed.author.authorId).toBe("local-id");
    expect(test.store.setReaction).toHaveBeenLastCalledWith(expect.not.objectContaining({ replicationAuthorId: expect.anything() }));
    expect(test.reactions).toEqual([]);
  });

  it("removes both the alias and the signed-in reaction", async () => {
    const test = fixture();
    test.setCredentials(null);
    await test.writeEach.react();
    test.setCredentials(signedIn("user-1"));
    await test.writeEach.react();
    test.events.length = 0;
    await test.writeEach.toggle();
    expect(test.events).toEqual(["warm", "reactions", "react:local-id:removed", "react:user-1:removed"]);
    expect(test.store.setReaction).toHaveBeenLastCalledWith(expect.objectContaining({ replicationAuthorId: "user-1" }));
    expect(test.reactions).toEqual([]);
  });

  it("checks the session again before the second row of an alias removal", async () => {
    const test = fixture();
    test.setCredentials(null);
    await test.writeEach.react();
    test.setCredentials(signedIn("user-1"));
    await test.writeEach.react();
    const first = test.store.setReaction.getMockImplementation()!;
    test.store.setReaction.mockImplementationOnce(async (input) => {
      const reaction = await first(input);
      test.setCredentials(signedIn("user-2"));
      return reaction;
    });
    await expect(test.writeEach.toggle()).rejects.toThrow("Your server session changed. Try again.");
    expect(test.reactions.map((reaction) => reaction.author.authorId)).toEqual(["user-1"]);
  });

  it("attributes an agent's reaction to the agent under the person's relay identity", async () => {
    const test = fixture();
    await test.writes.setReaction(test.place, {
      writer: AGENT, threadId: "thread", messageId: "message", emoji: "👍", state: "toggle",
    });
    expect(test.store.setReaction).toHaveBeenCalledWith({
      workspaceId: "workspace", threadId: "thread", messageId: "message", emoji: "👍", state: "added",
      author: { authorId: "user-1", kind: "agent", displayName: "Nova" }, replicationAuthorId: "user-1",
    });
  });

  it("syncs a reaction without projecting bookmarks or scanning dispatch", async () => {
    const test = fixture();
    await test.writeEach.react();
    expect(test.effects.queueCloudSync).toHaveBeenCalledWith("workspace");
    expect(test.effects.syncSharedChannelsForChatTarget).toHaveBeenCalledWith("workspace", { threadId: "thread" });
    expect(test.effects.projectChatBookmarks).not.toHaveBeenCalled();
    expect(test.effects.scanChatDispatch).not.toHaveBeenCalled();
  });

  it("links a file chat to the object the adapter resolved and syncs its new thread", async () => {
    const test = fixture();
    const thread = await test.writes.createFileThread(test.place, {
      title: "Notes", linkedFile: async () => ({ objectId: "object", pathHint: "notes.md" }),
    });
    expect(thread.id).toBe("file-thread");
    expect(test.store.createThread).toHaveBeenCalledWith({
      workspaceId: "workspace", title: "Notes", linkedFile: { objectId: "object", pathHint: "notes.md" },
    });
    expect(test.effects.syncSharedChannelsForChatTarget).toHaveBeenCalledWith("workspace", { threadId: "file-thread" });
    expect(test.effects.queueCloudSync).toHaveBeenCalledWith("workspace");
  });

  it("refuses a file chat when its workspace becomes a shared view while the file resolves", async () => {
    const test = fixture();
    await expect(test.writes.createFileThread(test.place, {
      title: "Notes",
      linkedFile: async () => {
        test.row.shareView = {
          shareId: "share", granterEmail: null, genericChatWritable: true,
          grantedSelector: { paths: ["notes"], versionId: null, access: "edit" },
        };
        return { objectId: "object", pathHint: "notes.md" };
      },
    })).rejects.toThrow("Chats are read-only in this shared view.");
    expectNothingWritten(test);
  });
});

describe("ActorKey local admission", () => {
  it.each([undefined, "other-owner"])("snapshots the account without a matching relay author (%s)", async (owner) => {
    const test = fixture();
    test.row.remote = owner ? { serverUrl: "https://other.test", ownerUserId: owner } : undefined;
    const sent = await test.writeEach.send();
    expect(sent.authorUserId).toBeUndefined();
    expect(parseActorKey(sent.authorActorKey!)).toEqual({ kind: "account", issuer: "https://cloud.test", userId: "user-1" });
  });

  it("keeps signed-out rows separate after sign-in and account replacement", async () => {
    const test = fixture();
    test.setCredentials(null);
    const offline = await test.writeEach.send();
    test.setCredentials(signedIn("user-1"));
    const online = await test.writeEach.send();
    test.setCredentials(signedIn("user-2"));
    const switched = await test.writeEach.send();
    expect(parseActorKey(offline.authorActorKey!)).toEqual({ kind: "installation", installationId: "local-id" });
    expect(parseActorKey(online.authorActorKey!)).toEqual({ kind: "account", issuer: "https://cloud.test", userId: "user-1" });
    expect(parseActorKey(switched.authorActorKey!)).toEqual({ kind: "account", issuer: "https://cloud.test", userId: "user-2" });
  });

  it.each([undefined, " Opus "])("records the actual handshake claim (%s), matching History", async (agentName) => {
    const test = fixture();
    const sent = await test.writes.sendMessage(test.place, {
      writer: { via: "cli", actor: "agent", agentName }, threadId: "thread", body: "Hi", resolveAttachments: async () => [],
    });
    const history = deriveMomentActor({ kind: "agent", agentId: agentName ?? "dohc-mcp", onBehalfOf: "user-1" }, {
      source: "own-store", origin: "cli", workspaceId: "workspace",
      identity: { installationId: "local-id", account: { issuer: createActorIssuer("https://cloud.test"), userId: "user-1" } },
    }, "Agent");
    expect(parseActorKey(sent.authorActorKey!)).toEqual(history.key);
    expect(sent.author.displayName).toBe(agentName ?? "Nova");
  });

  it("stores CLI human origin and automation definition identity locally", async () => {
    const test = fixture();
    const human = await test.writes.sendMessage(test.place, {
      writer: { via: "cli", actor: "human" }, threadId: "thread", body: "Hi", resolveAttachments: async () => [],
    });
    expect(human.origin).toBe("cli");
    expect(parseActorKey(human.authorActorKey!)).toMatchObject({ kind: "account" });
    await test.writes.startThread(test.place, {
      writer: { via: "automation", automationId: "collection:Tasks#tell", name: "Tell", depth: 1 },
      channelId: "channel", body: "Done", resolveAttachments: async () => [],
    });
    expect(parseActorKey(test.store.startChannelThread.mock.calls[0]![0].authorActorKey!)).toEqual({
      kind: "automation", ownerKey: { kind: "account", issuer: "https://cloud.test", userId: "user-1" },
      workspaceId: "workspace", automationId: "collection:Tasks#tell",
    });
  });

  it("keeps a malformed signed-in issuer unknown without failing the write", async () => {
    const test = fixture();
    test.setCredentials({ ...signedIn("user-1"), serverUrl: "not a URL" });
    const sent = await test.writeEach.send();
    expect(sent.authorActorKey).toBeUndefined();
    expect(test.store.sendMessage.mock.calls[0]![0].authorActorKey).toBeNull();
    expect(sent.id).toBe("message");
  });

  it("refuses a session replaced while admission work awaits", async () => {
    const test = fixture();
    const hold = test.holdAt("attachments");
    const pending = test.writeEach.send();
    await hold.entered.promise;
    test.setCredentials(signedIn("user-2"));
    hold.held.resolve();
    await expect(pending).rejects.toThrow("session changed");
    expectNothingWritten(test);
  });
});

it("records paused chat writes under the retained relay author", async () => {
  const h = fixture(); h.row.pausedRemote = h.row.remote; delete h.row.remote;
  await h.writeEach.send(); await h.writeEach.react(); await h.writeEach.answer();
  expect(h.store.sendMessage.mock.calls[0]![0].authorUserId).toBe("user-1");
  expect(h.store.setReaction.mock.calls[0]![0].replicationAuthorId).toBe("user-1");
  h.setCredentials(null);
  await expect(h.writes.sendMessage(h.place, { writer: { via: "automation", automationId: "collection:Tasks#tell", name: "Tell", depth: 1 },
    threadId: "thread", body: "Wait", resolveAttachments: async () => [] })).rejects.toBeInstanceOf(AutomationChatSessionWait);
});
