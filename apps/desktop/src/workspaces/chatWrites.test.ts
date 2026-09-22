import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatReaction } from "@dohc/workspace-contracts/engine";
import { createChatWrites, type ChatWriter, type ChatWriteStore } from "./chatWrites";
import type { ResolvedChatRelayIdentity } from "./chatRelayIdentity";
import type { CloudCredentials } from "./cloudCredentialStore";
import type { JoinedSharedChannel, RegistryEntry } from "./registryStore";
import { deferred } from "../testing/deferred";

const PERSON: ChatWriter = { via: "renderer" };
const AGENT: ChatWriter = { via: "cli", actor: "agent" };
const credentials: CloudCredentials = {
  serverUrl: "https://cloud.test", relayUrl: "https://relay.test", userId: "user-1",
  email: "sam@test.invalid", token: "token",
};
const joined: JoinedSharedChannel = {
  shareId: "share", channelWireId: "wire", access: "read-write", granterEmail: null,
  relayUrl: "https://relay.test", recipientUserId: "user-1",
};

function fixture() {
  const events: string[] = [];
  const row: Pick<RegistryEntry, "shareView" | "sharedChannels"> = {};
  const reactions: ChatReaction[] = [];
  const message = (input: Parameters<ChatWriteStore["sendMessage"]>[0]): ChatMessage => ({
    ...input, id: "message", createdAtMs: 2,
    attachments: (input.attachments ?? []).map((attachment, index) => ({
      ...attachment, attachmentId: `attachment-${index}`, threadId: input.threadId,
      messageId: "message", targetKind: "file", createdAtMs: 2,
    })),
  });
  const store = {
    findThreadChannelId: vi.fn(async () => "channel"),
    getChannelWireId: vi.fn(async () => "wire"),
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
    resolveChatDecision: vi.fn<ChatWriteStore["resolveChatDecision"]>(async (input) => ({
      ...input, state: "resolved", atMs: 3,
    })),
    listReactions: vi.fn<ChatWriteStore["listReactions"]>(async () => [...reactions]),
    setReaction: vi.fn<ChatWriteStore["setReaction"]>(async (input) => {
      events.push(`react:${input.author.authorId}:${input.state}`);
      const reaction = { ...input, reactionId: `${input.author.authorId}:${input.emoji}`, atMs: 4 };
      const index = reactions.findIndex((entry) => entry.reactionId === reaction.reactionId);
      if (index >= 0) reactions.splice(index, 1);
      if (input.state === "added") reactions.push(reaction);
      return reaction;
    }),
  };
  const identity: { authorUserId?: string; joinedChannel: JoinedSharedChannel | null } = {
    authorUserId: "user-1", joinedChannel: null,
  };
  const chatRelayIdentityFor = vi.fn(async (): Promise<ResolvedChatRelayIdentity> => {
    events.push("identity");
    return { ...identity };
  });
  let current: CloudCredentials | null = credentials;
  const effects = {
    projectChatBookmarks: vi.fn(),
    queueCloudSync: vi.fn(),
    syncSharedChannelsForChatTarget: vi.fn(async () => undefined),
    scanChatDispatch: vi.fn(async () => undefined),
  };
  const writes = createChatWrites({
    findWorkspace: () => row,
    chatRelayIdentityFor,
    currentCredentials: () => current,
    localUserDisplayName: () => "Sam",
    agentDisplayName: async () => "Nova",
    localReactorFallbackId: () => "local-id",
    ...effects,
  });
  const place = { workspaceId: "workspace", store };
  const attachments = vi.fn(async () => {
    events.push("attachments");
    return [{ objectId: "object", pathHint: "notes.md" }];
  });
  return {
    events, row, reactions, store, identity, chatRelayIdentityFor, effects, writes, place, attachments,
    setCredentials: (value: CloudCredentials | null) => { current = value; },
    // One call per write kind, each through the module's public interface.
    writeEach: {
      send: () => writes.sendMessage(place, { writer: PERSON, threadId: "thread", body: "Hi", resolveAttachments: attachments }),
      start: () => writes.startThread(place, { writer: AGENT, channelId: "channel", body: "Hi", resolveAttachments: attachments }),
      react: () => writes.setReaction(place, { writer: PERSON, threadId: "thread", messageId: "message", emoji: "👍", state: "added" }),
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
  it("writes a person's message under one verified identity and runs every message effect", async () => {
    const test = fixture();
    const sent = await test.writes.sendMessage(test.place, {
      writer: PERSON, threadId: "thread", parentMessageId: "parent", body: "Hello", resolveAttachments: test.attachments,
    });
    // Identity before attachments, then both checks again before the row lands.
    expect(test.events).toEqual(["identity", "attachments", "identity", "write"]);
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
    delete test.identity.authorUserId;
    test.setCredentials(null);
    await test.writeEach.send();
    expect(test.store.sendMessage.mock.calls[0]![0]).not.toHaveProperty("authorUserId");
  });

  for (const grant of ["read-only", "ended"] as const) {
    it.each(["send", "start", "react"] as const)(`refuses %s in a ${grant} joined channel before identity or any row`, async (kind) => {
      const test = fixture();
      test.row.sharedChannels = [grant === "read-only" ? { ...joined, access: "read-only" } : { ...joined, ended: true }];
      await expect(test.writeEach[kind]()).rejects.toThrow("This shared channel is read-only for you.");
      expect(test.chatRelayIdentityFor).not.toHaveBeenCalled();
      expect(test.attachments).not.toHaveBeenCalled();
      expectNothingWritten(test);
    });

    it(`refuses a decision in a ${grant} joined channel before any row`, async () => {
      const test = fixture();
      test.row.sharedChannels = [grant === "read-only" ? { ...joined, access: "read-only" } : { ...joined, ended: true }];
      await expect(test.writeEach.decide()).rejects.toThrow("This shared channel is read-only for you.");
      expectNothingWritten(test);
    });
  }

  // The grant check must be the last await before the row: a lookup that
  // started under read-write cannot carry that grant into the write.
  describe("a channel downgraded while identity resolves", () => {
    function downgradeDuringLookup(test: ReturnType<typeof fixture>, lookup: number) {
      let calls = 0;
      test.chatRelayIdentityFor.mockImplementation(async () => {
        calls += 1;
        if (calls === lookup) test.row.sharedChannels = [{ ...joined, access: "read-only" }];
        return { joinedChannel: null, authorUserId: "user-1" };
      });
    }

    it("refuses a decision without a reply", async () => {
      const test = fixture();
      downgradeDuringLookup(test, 1);
      await expect(test.writeEach.decide()).rejects.toThrow("This shared channel is read-only for you.");
      expectNothingWritten(test);
    });

    it("refuses a decision that follows its reply", async () => {
      const test = fixture();
      downgradeDuringLookup(test, 1);
      await expect(test.writes.resolveDecision(test.place, {
        threadId: "thread", messageId: "question", resolvedByMessageId: "message",
        reply: { authorUserId: "user-1" },
      })).rejects.toThrow("This shared channel is read-only for you.");
      expectNothingWritten(test);
    });

    it("refuses a message whose final lookup runs after attachments", async () => {
      const test = fixture();
      downgradeDuringLookup(test, 2);
      await expect(test.writeEach.send()).rejects.toThrow("This shared channel is read-only for you.");
      expect(test.events).toEqual(["attachments"]);
      expectNothingWritten(test);
    });
  });

  it.each(["send", "start", "react", "decide", "file"] as const)("refuses %s in a received share before the store", async (kind) => {
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
    expectNothingWritten(test);
  });

  it.each(["send", "react"] as const)("refuses %s when the session changes before the row lands", async (kind) => {
    const test = fixture();
    test.chatRelayIdentityFor
      .mockResolvedValueOnce({ joinedChannel: null, authorUserId: "user-1" })
      .mockResolvedValueOnce({ joinedChannel: null, authorUserId: "user-2" });
    await expect(test.writeEach[kind]()).rejects.toThrow("Your server session changed. Try again.");
    expectNothingWritten(test);
  });

  it("checks the grant again after attachments resolve", async () => {
    const test = fixture();
    test.attachments.mockImplementationOnce(async () => {
      test.row.sharedChannels = [{ ...joined, access: "read-only" }];
      return [];
    });
    await expect(test.writeEach.send()).rejects.toThrow("This shared channel is read-only for you.");
    expect(test.attachments).toHaveBeenCalledOnce();
    expectNothingWritten(test);
  });

  it.each(["send", "start", "react", "decide"] as const)("requires the joined account to %s in a joined channel", async (kind) => {
    const test = fixture();
    test.identity.joinedChannel = joined;
    test.setCredentials(null);
    await expect(test.writeEach[kind]()).rejects.toThrow("Sign in to your server to send a message in this shared channel.");
    expect(test.attachments).not.toHaveBeenCalled();
    expectNothingWritten(test);
    test.setCredentials({ ...credentials, userId: "user-2" });
    await expect(test.writeEach[kind]()).rejects.toThrow("Sign in to the account that joined this shared channel.");
    expectNothingWritten(test);
  });

  it("reads the session only after the joined identity resolves", async () => {
    const test = fixture();
    const entered = deferred();
    const held = deferred();
    test.identity.joinedChannel = joined;
    test.setCredentials(null);
    test.chatRelayIdentityFor.mockImplementationOnce(async () => {
      entered.resolve();
      await held.promise;
      return { joinedChannel: joined, authorUserId: "user-1" };
    });
    const sent = test.writeEach.send();
    await entered.promise;
    test.setCredentials(credentials);
    held.resolve();
    await expect(sent).resolves.toMatchObject({ authorUserId: "user-1" });
  });

  it("toggles a signed-out reaction under the install's local id without a relay author", async () => {
    const test = fixture();
    delete test.identity.authorUserId;
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
    delete test.identity.authorUserId;
    await test.writeEach.react();
    test.identity.authorUserId = "user-1";
    test.events.length = 0;
    const removed = await test.writes.setReaction(test.place, {
      writer: PERSON, threadId: "thread", messageId: "message", emoji: "👍", state: "removed",
    });
    expect(removed.author.authorId).toBe("local-id");
    expect(test.events).toEqual(["identity", "identity", "react:local-id:removed"]);
    expect(test.reactions).toEqual([]);
  });

  it("removes both the alias and the signed-in reaction, checking the session between them", async () => {
    const test = fixture();
    delete test.identity.authorUserId;
    await test.writeEach.react();
    test.identity.authorUserId = "user-1";
    await test.writeEach.react();
    test.events.length = 0;
    await test.writes.setReaction(test.place, {
      writer: { via: "cli", actor: "human" }, threadId: "thread", messageId: "message", emoji: "👍", state: "toggle",
    });
    expect(test.events).toEqual([
      "identity", "identity", "react:local-id:removed", "identity", "react:user-1:removed",
    ]);
    expect(test.store.setReaction).toHaveBeenLastCalledWith(expect.objectContaining({ replicationAuthorId: "user-1" }));
    expect(test.reactions).toEqual([]);
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
    expect(test.chatRelayIdentityFor).not.toHaveBeenCalled();
    expect(test.effects.syncSharedChannelsForChatTarget).toHaveBeenCalledWith("workspace", { threadId: "file-thread" });
    expect(test.effects.queueCloudSync).toHaveBeenCalledWith("workspace");
  });
});
