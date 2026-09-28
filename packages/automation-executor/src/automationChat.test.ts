import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { LinkedChatStore } from "@dohc/workspace-contracts/engine";
import { chatDirectoryOf, readChatDirectory, type ChatDirectoryChannel } from "./automationChat";
import type { RosterGrant } from "./automationReach";

const dm = (id: string, wireId = id, runningThreadId: string | null = `thread-${id}`): ChatDirectoryChannel => ({
  id, name: id, slug: id, kind: "dm", type: "chat", wireId, runningThreadId,
});
const inDm = (wireId: string, userId: string | null, email: string): RosterGrant => ({
  grantId: `grant-${email}`, recipientUserId: userId, recipientEmail: email, files: null, channel: { wireId, canPost: true },
});

describe("where automations write", () => {
  it("finds a Group by its slug first, then by a name only one Group has, and names a missing or doubled one", () => {
    const group = (id: string, name: string, slug = name.toLowerCase()): ChatDirectoryChannel =>
      ({ id, name, slug, kind: "channel", type: "both", wireId: id, runningThreadId: null });
    const directory = chatDirectoryOf(
      [
        group("trip", "Trip"), group("a", "Plans", "plans"), group("b", "Plans", "plans-2"),
        // One Group's name is another's slug: the slug names the Group.
        group("named", "ops", "ops-team"), group("slugged", "Ops", "ops"),
        { ...group("board", "Board"), readOnly: true, ended: true },
        { ...dm("dm"), name: "Dm" },
      ],
      { kind: "owner", ownerUserId: null, grants: [] },
    );
    expect(directory.group("Trip")).toEqual({ channelId: "trip", wireId: "trip", name: "Trip", lane: "posts", readOnly: false, ended: false });
    expect(directory.group("trip")).toMatchObject({ channelId: "trip" });
    expect(directory.group("Plans")).toEqual({ problem: "More than one Group is called Plans. Name one by its slug instead: plans or plans-2." });
    expect(directory.group("plans-2")).toMatchObject({ channelId: "b" });
    expect(directory.group("ops")).toMatchObject({ channelId: "slugged" });
    expect(directory.group("ops-team")).toMatchObject({ channelId: "named" });
    expect(directory.group("Board")).toMatchObject({ readOnly: true, ended: true });
    expect(directory.group("Dm")).toEqual({ problem: "dohc cannot find the Group Dm." });
  });

  it("writes only to a direct message the owner started with exactly that person", () => {
    const directory = chatDirectoryOf([
      dm("dm-ana"),
      // Ana and Bob together, and Cara with a pending invite beside her.
      dm("dm-pair"), dm("dm-cara"),
      // Started by someone else, and not yet written to.
      dm("dm-joined", "wire-elsewhere"), dm("dm-empty", "dm-empty", null),
    ], {
      kind: "owner", ownerUserId: "user-owner", grants: [
        inDm("dm-ana", "user-ana", "ana@dohc.test"),
        inDm("dm-pair", "user-ana", "ana@dohc.test"), inDm("dm-pair", "user-bob", "bob@dohc.test"),
        inDm("dm-cara", "user-cara", "cara@dohc.test"), inDm("dm-cara", null, "dan@dohc.test"),
        inDm("wire-elsewhere", "user-eve", "eve@dohc.test"), inDm("dm-empty", "user-fay", "fay@dohc.test"),
      ],
    });
    expect(directory.directMessage("user-ana")).toEqual({
      channelId: "dm-ana", wireId: "dm-ana", threadId: "thread-dm-ana", name: "your direct message with ana@dohc.test",
    });
    for (const [userId, email] of [["user-bob", "bob"], ["user-cara", "cara"], ["user-eve", "eve"], ["user-fay", "fay"]]) {
      expect(directory.directMessage(userId!)).toEqual({
        problem: `There is no direct message with ${email}@dohc.test yet. Start one first: automations never start one.`,
      });
    }
  });

  it("names this computer's person by its own id for them only on a roster that proves nobody else had a part", () => {
    const proved = chatDirectoryOf([], { kind: "owner", ownerUserId: null, localPersonId: "install-here", grants: [] });
    expect(proved.person("install-here")).toBe("you");
    expect(proved.noticeRecipient("install-here")).toEqual({ name: "you" });
    expect(proved.noticeRecipient("install-elsewhere")).toHaveProperty("problem");
    expect(proved.directMessage("install-here")).toEqual({
      problem: "There is no direct message with you yet. Start one first: automations never start one.",
    });
    const unproved = chatDirectoryOf([], { kind: "owner", ownerUserId: null, grants: [] });
    expect(unproved.person("install-here")).toBe("that person");
    expect(unproved.noticeRecipient("install-here")).toHaveProperty("problem");
  });
});

describe("reading where automations write", () => {
  it("reads only the Groups and the people's direct messages the automations name", async () => {
    const channel = (id: string, kind: "channel" | "dm", name = id) => ({
      id, workspaceId: "ws", name, slug: name.toLowerCase(), kind, type: "posts" as const, purpose: "",
      createdAtMs: 1, updatedAtMs: 1, threadCount: 1, unreadCount: 0,
    });
    const store = {
      listChannels: vi.fn<LinkedChatStore["listChannels"]>(async () => [
        channel("trip", "channel", "Trip"), channel("other", "channel", "Other"),
        channel("dm-ana", "dm"), channel("dm-bob", "dm"),
      ]),
      getChannelWireId: vi.fn<LinkedChatStore["getChannelWireId"]>(async ({ channelId }) => channelId),
      listChannelThreads: vi.fn<LinkedChatStore["listChannelThreads"]>(async ({ channelId }) => [{
        thread: { id: `thread-${channelId}`, workspaceId: "ws", title: "", createdAtMs: 1, updatedAtMs: 1 },
        messageCount: 1, unreadCount: 0,
      } as unknown as Awaited<ReturnType<LinkedChatStore["listChannelThreads"]>>[number]]),
    };
    const directory = await readChatDirectory(store, "ws", {
      kind: "owner", ownerUserId: "user-owner",
      grants: [inDm("dm-ana", "user-ana", "ana@dohc.test"), inDm("dm-bob", "user-bob", "bob@dohc.test")],
    }, { groups: new Set(["Trip"]), people: new Set(["user-ana"]) });

    expect(store.getChannelWireId.mock.calls.map(([input]) => input.channelId)).toEqual(["trip"]);
    expect(store.listChannelThreads.mock.calls.map(([input]) => input.channelId)).toEqual(["dm-ana"]);
    expect(directory.group("Trip")).toMatchObject({ channelId: "trip" });
    expect(directory.directMessage("user-ana")).toMatchObject({ threadId: "thread-dm-ana" });
  });
});
