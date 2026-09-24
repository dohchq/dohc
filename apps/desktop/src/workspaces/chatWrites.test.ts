import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatReaction } from "@dohc/workspace-contracts/engine";
import { createChatWrites, type ChatWriter, type ChatWriteStore } from "./chatWrites";
import type { CloudCredentials } from "./cloudCredentialStore";
import type { JoinedSharedChannel, RegistryEntry } from "./registryStore";
import { deferred, type Deferred } from "../testing/deferred";

const PERSON: ChatWriter = { via: "renderer" };
const AGENT: ChatWriter = { via: "cli", actor: "agent" };
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
  const row: Pick<RegistryEntry, "remote" | "shareView" | "sharedChannels"> = {
    remote: { serverUrl: "https://cloud.test", ownerUserId: "user-1" },
  };
  const reactions: ChatReaction[] = [];
  const message = (input: Parameters<ChatWriteStore["sendMessage"]>[0]): ChatMessage => ({
    ...input, id: "message", createdAtMs: 2,
    attachments: (input.attachments ?? []).map((attachment, index) => ({
      ...attachment, attachmentId: `attachment-${index}`, threadId: input.threadId,
      messageId: "message", targetKind: "file", createdAtMs: 2,
    })),
  });
  const store = {
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
      events.push("write");
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
  const warmCredentials = vi.fn(async () => {
    await reach("warm");
  });
  const effects = {
    projectChatBookmarks: vi.fn(),
    queueCloudSync: vi.fn(),
    syncSharedChannelsForChatTarget: vi.fn(async () => undefined),
    scanChatDispatch: vi.fn(async () => undefined),
  };
  const writes = createChatWrites({
    findWorkspace: () => row,
    warmCredentials,
    currentCredentials: () => credentials,
    currentCredentialGeneration: () => generation,
    localUserDisplayName: () => "Sam",
    agentDisplayName: async () => "Nova",
    localReactorFallbackId: () => "local-id",
    ...effects,
  });
  const place = { workspaceId: "workspace", store };
  const attachments = vi.fn(async () => {
    await reach("attachments");
    return [{ objectId: "object", pathHint: "notes.md" }];
  });
  return {
    events, row, reactions, store, warmCredentials, effects, writes, place, attachments,
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
      decide: () => writes.resolveDecision(place, { threadId: "thread", messageId: "question", resolvedByMessageId: "message" }),
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
  it("writes a person's message under the verified identity and runs every message effect", async () => {
    const test = fixture();
    const sent = await test.writes.sendMessage(test.place, {
      writer: PERSON, threadId: "thread", parentMessageId: "parent", body: "Hello", resolveAttachments: test.attachments,
    });
    expect(test.store.sendMessage).toHaveBeenCalledWith({
      workspaceId: "workspace", threadId: "thread", parentMessageId: "parent", body: "Hello",
      author: { kind: "human", displayName: "Sam" }, authorUserId: "user-1",
      attachments: [{ objectId: "object", pathHint: "notes.md" }],
    });
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
    expect(test.store.startChannelThread).toHaveBeenCalledWith({
      workspaceId: "workspace", channelId: "channel", lane: "chat", title: "Plan", body: "Pick one",
      author: { kind: "agent", displayName: "Nova" }, authorOwnerDisplayName: "Sam",
      authorUserId: "user-1", origin: "cli", needsDecision: true, options: ["A", "B"],
    });
    expect(test.effects.projectChatBookmarks).toHaveBeenCalledWith("workspace");
    expect(test.effects.scanChatDispatch).toHaveBeenCalledWith("workspace");
    expect(test.effects.syncSharedChannelsForChatTarget).toHaveBeenCalledWith("workspace", { channelId: "channel" });
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
    it.each(["send", "start", "react", "decide"] as const)(`refuses %s in a ${grant} joined channel before any row`, async (kind) => {
      const test = fixture();
      test.row.sharedChannels = [grant === "read-only" ? { ...joined, access: "read-only" } : { ...joined, ended: true }];
      await expect(test.writeEach[kind]()).rejects.toThrow("You can only read this.");
      expect(test.attachments).not.toHaveBeenCalled();
      expectNothingWritten(test);
    });
  }

  it.each(["send", "start", "react", "decide", "file"] as const)("refuses %s in a received share before any store read", async (kind) => {
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

  it.each(["send", "start", "react", "decide"] as const)("requires the joined account to %s in a joined channel", async (kind) => {
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
      ["decide", ["wire", "warm"]],
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

    it.each(["send", "decide", "toggle"] as const)("refuses %s when the same account's session is replaced during target resolution", async (kind) => {
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

  it("refuses a decision when the session changed since the reply that resolves it", async () => {
    const test = fixture();
    const decide = (authorUserId?: string) => test.writes.resolveDecision(test.place, {
      threadId: "thread", messageId: "question", resolvedByMessageId: "message",
      reply: authorUserId ? { authorUserId } : {},
    });
    await expect(decide("user-0")).rejects.toThrow("Your server session changed. Try again.");
    await expect(decide()).rejects.toThrow("Your server session changed. Try again.");
    expectNothingWritten(test);
    await expect(decide("user-1")).resolves.toMatchObject({ state: "resolved" });
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

  it.each(["react", "decide"] as const)("syncs a %s without projecting bookmarks or scanning dispatch", async (kind) => {
    const test = fixture();
    await test.writeEach[kind]();
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
