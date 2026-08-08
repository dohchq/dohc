import { rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ShareUnavailableError,
  SharedChannelReadOnlyError,
} from "@dohc/workspace-contracts/relay";
import { CHATS_METHOD, ChatsLoopbackEngine, type Request } from "@dohc/workspace-engine-client";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import {
  assertSharedChannelWritable,
  createKeyedSerializer,
  createPassCoverageReporter,
  endJoinedChannel,
  joinedSharedChannelForTarget,
  mergeJoinedChannel,
  relayFetchWithTimeout,
  scopeJoinedChannels,
  syncJoinedSharedChannels,
} from "./sharedChannels";
import {
  ListChatChannelSharesResult,
  ListJoinedSharedChannelsResult,
  MAX_CHAT_CHANNEL_SHARE_ROWS,
} from "../ipc/bridgeContract";
import type { JoinedSharedChannel } from "./registryStore";
import { createLiveLinkedChatStore } from "./liveLinkedChatStore";
import { createTestScratch } from "./testTemp";

// MU-C4: the desktop's best-effort refresh pass over joined shared channels.
// The engine client is injected; these tests pin the pass's CONTAINMENT
// contract — one bad share never blocks the others, revocation reports ended,
// a read-only downgrade keeps reads flowing.

const RELAY = { baseUrl: "http://relay.test", token: "token" };

async function makeChats(workspaceId: string): Promise<{
  store: ReturnType<typeof createLiveLinkedChatStore>;
  root: string;
  seed: (request: Omit<Request, "id" | "workspace">) => Promise<void>;
}> {
  const root = await createTestScratch("dohc-shared-channel-");
  const loopback = new ChatsLoopbackEngine();
  const client = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request) {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: workspaceId } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
  const store = createLiveLinkedChatStore({ workspaceId, rootPath: root }, sessions);
  let nextRequestId = 1;
  return {
    store,
    root,
    seed: async (request) => {
      await loopback.sendRequest({ ...request, id: nextRequestId++, workspace: workspaceId });
    },
  };
}

function joined(overrides: Partial<JoinedSharedChannel> = {}): JoinedSharedChannel {
  const shareId = overrides.shareId ?? "share-1";
  return {
    shareId,
    // One row is one channel, so the wire id follows the share id unless a test
    // deliberately models two grants for the same channel.
    channelWireId: `wire-${shareId.replace(/^share-/u, "")}`,
    access: "read-write",
    granterEmail: "owner@example.com",
    relayUrl: "http://relay.test",
    ...overrides,
    recipientUserId: overrides.recipientUserId ?? "member-1",
  };
}

// The desktop hands the pass two views of the registry, and every test uses the
// same split: the FULL ordered rows fix the rotation's positions, and the work
// set is what is left after ended rows drop out (main.ts:runSharedChannelSyncPass).
// Passing one array for both is what let a cursor pin certify inputs production
// never sends.
function passOver(rows: readonly JoinedSharedChannel[]): {
  channels: JoinedSharedChannel[];
  registryOrder: readonly JoinedSharedChannel[];
} {
  return {
    channels: rows.filter((row) => row.ended !== true),
    registryOrder: rows,
  };
}

function pullResult(applied = 0) {
  return { fetched: applied, applied, skipped: 0, nextCursor: applied };
}

describe("syncJoinedSharedChannels", () => {
  it("covers only the first passRows live rows and reports the remainder", async () => {
    const pull = vi.fn(async (_input: { shareId: string }) => pullResult(0));
    const channels = Array.from({ length: 5 }, (_, index) =>
      joined({ shareId: `share-${index + 1}`, access: "read-only" }),
    );

    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver(channels),
      passRows: 2,
      pull,
      push: vi.fn(async () => ({ pushed: 0 })),
    });

    expect(pull.mock.calls.map(([input]) => input.shareId)).toEqual(["share-1", "share-2"]);
    expect(result.uncovered).toBe(3);
    expect(result.resumeAfterChannelWireId).toBe("wire-2");
  });

  it("resumes after the previous cursor and wraps to the front", async () => {
    const pull = vi.fn(async (_input: { shareId: string }) => pullResult(0));
    const channels = Array.from({ length: 5 }, (_, index) =>
      joined({ shareId: `share-${index + 1}`, access: "read-only" }),
    );
    const runPass = async (resumeAfterChannelWireId?: string) => {
      pull.mockClear();
      const result = await syncJoinedSharedChannels({
        rootDir: "/tmp/ws",
        workspaceId: "ws-1",
        relay: RELAY,
        ...passOver(channels),
        passRows: 2,
        resumeAfterChannelWireId,
        pull,
        push: vi.fn(async () => ({ pushed: 0 })),
      });
      return {
        pulled: pull.mock.calls.map(([input]) => input.shareId),
        cursor: result.resumeAfterChannelWireId ?? undefined,
      };
    };

    const first = await runPass();
    expect(first).toEqual({ pulled: ["share-1", "share-2"], cursor: "wire-2" });
    const second = await runPass(first.cursor);
    expect(second).toEqual({ pulled: ["share-3", "share-4"], cursor: "wire-4" });
    const third = await runPass(second.cursor);
    expect(third).toEqual({ pulled: ["share-5", "share-1"], cursor: "wire-1" });
  });

  // A share revoked exactly on the window boundary must not cost the rotation a
  // lap: the cursor row is gone from the live rows, and resolving it there would
  // send this pass back to the front and re-cover the prefix it just did.
  it("steps past a cursor row that ended between passes instead of restarting", async () => {
    const pull = vi.fn(async (_input: { shareId: string }) => pullResult(0));
    const rows = Array.from({ length: 32 }, (_, index) =>
      joined({ shareId: `share-${index + 1}`, access: "read-only" }),
    );
    const first = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver(rows),
      passRows: 16,
      pull,
      push: vi.fn(async () => ({ pushed: 0 })),
    });
    expect(first.resumeAfterChannelWireId).toBe("wire-16");

    // The granter revokes share-16 between the two passes.
    const afterRevoke = rows.map((row) =>
      row.shareId === "share-16" ? { ...row, ended: true } : row,
    );
    pull.mockClear();
    const second = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver(afterRevoke),
      passRows: 16,
      resumeAfterChannelWireId: first.resumeAfterChannelWireId ?? undefined,
      pull,
      push: vi.fn(async () => ({ pushed: 0 })),
    });
    expect(pull.mock.calls.map(([input]) => input.shareId)).toEqual(
      Array.from({ length: 16 }, (_, index) => `share-${index + 17}`),
    );
    expect(second.resumeAfterChannelWireId).toBe("wire-32");
    // 31 live rows, 16 covered.
    expect(second.uncovered).toBe(15);
  });

  // Worse than a plain revoke: the channel is revoked AND re-granted before the
  // next pass, so mergeJoinedChannel replaces its row and the OLD share id is
  // gone from the registry entirely. The rotation survives it because its cursor
  // names the CHANNEL, and the merge keeps that channel in its place.
  it("steps past a cursor channel revoked and re-granted between passes", async () => {
    const pull = vi.fn(async (_input: { shareId: string }) => pullResult(0));
    const rows = Array.from({ length: 32 }, (_, index) =>
      joined({ shareId: `share-${index + 1}`, access: "read-only" }),
    );
    const first = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver(rows),
      passRows: 16,
      pull,
      push: vi.fn(async () => ({ pushed: 0 })),
    });
    expect(first.resumeAfterChannelWireId).toBe("wire-16");

    // wire-16's grant is revoked and re-granted under a new share id, through
    // the registry's own merge — the same call the join flow makes.
    const afterRegrant = mergeJoinedChannel(
      rows,
      joined({ shareId: "share-16-regranted", channelWireId: "wire-16", access: "read-only" }),
    );
    expect(afterRegrant.map((row) => row.shareId)).not.toContain("share-16");

    pull.mockClear();
    const second = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver(afterRegrant),
      passRows: 16,
      resumeAfterChannelWireId: first.resumeAfterChannelWireId ?? undefined,
      pull,
      push: vi.fn(async () => ({ pushed: 0 })),
    });
    expect(pull.mock.calls.map(([input]) => input.shareId)).toEqual(
      Array.from({ length: 16 }, (_, index) => `share-${index + 17}`),
    );
    expect(second.resumeAfterChannelWireId).toBe("wire-32");
    expect(second.uncovered).toBe(16);
  });

  // The write that triggered a pass must not have to wait for the rotation:
  // closing Chats stops the poll, so a send can be the last pass for minutes.
  it("always covers the share that triggered the pass, even outside the window", async () => {
    const calls: string[] = [];
    const push = vi.fn(async (input: { shareId: string }) => {
      calls.push(`push:${input.shareId}`);
      return { pushed: 1 };
    });
    const pull = vi.fn(async (input: { shareId: string }) => {
      calls.push(`pull:${input.shareId}`);
      return pullResult(0);
    });
    const channels = Array.from({ length: 20 }, (_, index) =>
      joined({ shareId: `share-${index + 1}` }),
    );
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver(channels),
      passRows: 16,
      // Rotation alone would cover share-5 .. share-20 — never share-1.
      resumeAfterChannelWireId: "wire-4",
      priorityShareId: "share-1",
      pull,
      push,
    });
    // The written share pushes in THIS pass, first, and it does NOT eat a
    // rotation slot: the rotation still gets its full 16 rows.
    expect(calls.slice(0, 2)).toEqual(["push:share-1", "pull:share-1"]);
    expect(calls).toHaveLength(34);
    expect(pull.mock.calls.map(([input]) => input.shareId)).toEqual([
      "share-1",
      ...Array.from({ length: 16 }, (_, index) => `share-${index + 5}`),
    ]);
    // The cursor follows the rotation, not the out-of-order priority row.
    expect(result.resumeAfterChannelWireId).toBe("wire-20");
    expect(result.uncovered).toBe(3);
  });

  // The coverage promise must not depend on write traffic. A share written on
  // every pass would, if it spent a rotation slot each time, push the tail of
  // the registry past ceil(live / passRows) forever.
  it("keeps the rotation whole under a share written on every pass", async () => {
    const pull = vi.fn(async (_input: { shareId: string }) => pullResult(0));
    const rows = Array.from({ length: 32 }, (_, index) =>
      joined({ shareId: `share-${index + 1}`, access: "read-only" }),
    );
    const covered: string[] = [];
    let cursor: string | undefined;
    for (let pass = 0; pass < 2; pass += 1) {
      pull.mockClear();
      const result = await syncJoinedSharedChannels({
        rootDir: "/tmp/ws",
        workspaceId: "ws-1",
        relay: RELAY,
        ...passOver(rows),
        passRows: 16,
        ...(cursor ? { resumeAfterChannelWireId: cursor } : {}),
        // The same share is written before every pass.
        priorityShareId: "share-32",
        pull,
        push: vi.fn(async () => ({ pushed: 0 })),
      });
      cursor = result.resumeAfterChannelWireId ?? undefined;
      covered.push(...pull.mock.calls.map(([input]) => input.shareId));
    }
    // Two rotations of 16 reach every row, priority or no priority.
    expect(new Set(covered).size).toBe(32);
  });

  it("never covers the triggering share twice when rotation already reaches it", async () => {
    const pull = vi.fn(async (_input: { shareId: string }) => pullResult(0));
    const channels = Array.from({ length: 5 }, (_, index) =>
      joined({ shareId: `share-${index + 1}`, access: "read-only" }),
    );
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver(channels),
      passRows: 3,
      // The cursor wraps the rotation to share-1, so its range (share-1 ..
      // share-3) CONTAINS the priority row — the case where a naive fill would
      // spend two of the three slots on share-2.
      resumeAfterChannelWireId: "wire-5",
      priorityShareId: "share-2",
      pull,
      push: vi.fn(async () => ({ pushed: 0 })),
    });
    expect(pull.mock.calls.map(([input]) => input.shareId)).toEqual([
      "share-2",
      "share-1",
      "share-3",
      "share-4",
    ]);
    expect(result.uncovered).toBe(1);
    expect(result.resumeAfterChannelWireId).toBe("wire-4");
  });

  it("ignores a priority share this workspace holds no live row for", async () => {
    const pull = vi.fn(async (_input: { shareId: string }) => pullResult(0));
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver([
        joined({ shareId: "share-1", access: "read-only" }),
        joined({ shareId: "share-2", access: "read-only" }),
        joined({ shareId: "share-gone", ended: true }),
      ]),
      passRows: 1,
      priorityShareId: "share-gone",
      pull,
      push: vi.fn(async () => ({ pushed: 0 })),
    });
    expect(pull.mock.calls.map(([input]) => input.shareId)).toEqual(["share-1"]);
    expect(result.resumeAfterChannelWireId).toBe("wire-1");
  });

  it("reports no uncovered rows when the pass covers every live row", async () => {
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver([joined(), joined({ shareId: "share-2" })]),
      passRows: 2,
      pull: vi.fn(async () => pullResult(0)),
      push: vi.fn(async () => ({ pushed: 0 })),
    });

    expect(result.uncovered).toBe(0);
    expect(result.resumeAfterChannelWireId).toBe("wire-2");
  });

  it("restarts at the first live row when the cursor row is no longer live", async () => {
    const pull = vi.fn(async (_input: { shareId: string }) => pullResult(0));
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver([
        joined({ shareId: "share-ended", ended: true }),
        joined({ shareId: "share-1", access: "read-only" }),
        joined({ shareId: "share-2", access: "read-only" }),
        joined({ shareId: "share-3", access: "read-only" }),
      ]),
      passRows: 2,
      resumeAfterChannelWireId: "wire-ended",
      pull,
      push: vi.fn(async () => ({ pushed: 0 })),
    });

    expect(pull.mock.calls.map(([input]) => input.shareId)).toEqual(["share-1", "share-2"]);
    expect(result.resumeAfterChannelWireId).toBe("wire-2");
  });

  it("does not let ended rows consume the window or count as uncovered", async () => {
    const pull = vi.fn(async (_input: { shareId: string }) => pullResult(0));
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver([
        joined({ shareId: "share-ended-1", ended: true }),
        joined({ shareId: "share-1", access: "read-only" }),
        joined({ shareId: "share-ended-2", ended: true }),
        joined({ shareId: "share-2", access: "read-only" }),
        joined({ shareId: "share-3", access: "read-only" }),
      ]),
      passRows: 2,
      pull,
      push: vi.fn(async () => ({ pushed: 0 })),
    });

    expect(pull.mock.calls.map(([input]) => input.shareId)).toEqual(["share-1", "share-2"]);
    expect(result.uncovered).toBe(1);
    expect(result.resumeAfterChannelWireId).toBe("wire-2");
  });

  it("counts a transient failure as covered relay work", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pull = vi.fn(async (_input: { shareId: string }) => {
      throw new Error("ECONNREFUSED");
    });
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver([
        joined({ shareId: "share-flaky", access: "read-only" }),
        joined({ shareId: "share-next", access: "read-only" }),
      ]),
      passRows: 1,
      pull,
      push: vi.fn(async () => ({ pushed: 0 })),
    });

    expect(pull.mock.calls.map(([input]) => input.shareId)).toEqual(["share-flaky"]);
    expect(result.uncovered).toBe(1);
    expect(result.resumeAfterChannelWireId).toBe("wire-flaky");
    errorSpy.mockRestore();
  });

  it("pushes then pulls read-write channels and only pulls read-only ones", async () => {
    const calls: string[] = [];
    const push = vi.fn(async (input: { shareId: string }) => {
      calls.push(`push:${input.shareId}`);
      return { pushed: 1 };
    });
    const pull = vi.fn(async (input: { shareId: string }) => {
      calls.push(`pull:${input.shareId}`);
      return pullResult(1);
    });
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver([joined(), joined({ shareId: "share-ro", access: "read-only" })]),
      passRows: 2,
      pull,
      push,
    });
    // Push precedes pull per share (local sends land before echoes replay),
    // and the read-only share never attempts an append.
    expect(calls).toEqual(["push:share-1", "pull:share-1", "pull:share-ro"]);
    expect(result).toEqual({
      endedShareIds: [],
      readOnlyShareIds: [],
      changed: true,
      uncovered: 0,
      resumeAfterChannelWireId: "wire-ro",
    });
  });

  it("reports a revoked share as ended and keeps syncing the others", async () => {
    const push = vi.fn(async () => ({ pushed: 0 }));
    const pull = vi.fn(async (input: { shareId: string }) => {
      if (input.shareId === "share-revoked") throw new ShareUnavailableError();
      return pullResult(2);
    });
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver([joined({ shareId: "share-revoked" }), joined({ shareId: "share-live" })]),
      passRows: 2,
      pull,
      push,
    });
    expect(result.endedShareIds).toEqual(["share-revoked"]);
    expect(result.changed).toBe(true);
    expect(result.uncovered).toBe(0);
    expect(result.resumeAfterChannelWireId).toBe("wire-live");
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it("treats a read-only refusal on push as a downgrade, not a failure — the pull still runs", async () => {
    const push = vi.fn(async () => {
      throw new SharedChannelReadOnlyError();
    });
    const pull = vi.fn(async () => pullResult(0));
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver([joined()]),
      passRows: 1,
      pull,
      push,
    });
    expect(result.readOnlyShareIds).toEqual(["share-1"]);
    expect(result.endedShareIds).toEqual([]);
    expect(result.uncovered).toBe(0);
    expect(result.resumeAfterChannelWireId).toBe("wire-1");
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it("logs transient failures and never throws (a flaky share can't block the pass)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const push = vi.fn(async (input: { shareId: string }) => {
      if (input.shareId === "share-flaky") throw new Error("ECONNREFUSED");
      return { pushed: 0 };
    });
    const pull = vi.fn(async () => pullResult(0));
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver([joined({ shareId: "share-flaky" }), joined({ shareId: "share-ok" })]),
      passRows: 2,
      pull,
      push,
    });
    expect(result).toEqual({
      endedShareIds: [],
      readOnlyShareIds: [],
      changed: false,
      uncovered: 0,
      resumeAfterChannelWireId: "wire-ok",
    });
    // Only the healthy share pulled; the flaky one logged and moved on.
    expect(pull).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("skips shares already marked ended", async () => {
    const push = vi.fn(async () => ({ pushed: 0 }));
    const pull = vi.fn(async () => pullResult(0));
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      ...passOver([joined({ ended: true })]),
      passRows: 1,
      pull,
      push,
    });
    expect(push).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.uncovered).toBe(0);
    expect(result.resumeAfterChannelWireId).toBeNull();
  });
});

// A bounded pass that skipped rows must never read as a full refresh: the
// remainder is reported, and the notice names the limit that produced it.
describe("createPassCoverageReporter", () => {
  it("says nothing when the pass covered every live row", () => {
    const lines: string[] = [];
    const reportCoverage = createPassCoverageReporter((message) => lines.push(message));
    reportCoverage({ workspaceId: "ws-1", live: 4, uncovered: 0, passRows: 16 });
    expect(lines).toEqual([]);
  });

  it("names the constraint, the limit, the unit, and what the pass covered", () => {
    const lines: string[] = [];
    const reportCoverage = createPassCoverageReporter((message) => lines.push(message));
    reportCoverage({ workspaceId: "ws-1", live: 40, uncovered: 24, passRows: 16 });
    expect(lines).toEqual([
      "[desktop] shared channel sync covered 16 of 40 joined channels this pass " +
        "(limit SHARED_CHANNEL_SYNC_PASS_ROWS=16 rotation rows/pass, plus 1 row for a channel " +
        "a write named); 24 resume on the next pass.",
    ]);
  });

  // A write's channel is covered ON TOP of the rotation, so a pass can report 17
  // covered against a limit of 16. The line has to name both numbers or it reads
  // as a limit the pass just broke.
  it("names the additive row, so covering 17 against a limit of 16 still adds up", () => {
    const lines: string[] = [];
    const reportCoverage = createPassCoverageReporter((message) => lines.push(message));
    reportCoverage({ workspaceId: "ws-1", live: 40, uncovered: 23, passRows: 16 });
    expect(lines[0]).toContain("covered 17 of 40 joined channels");
    expect(lines[0]).toContain("16 rotation rows/pass");
    expect(lines[0]).toContain("plus 1 row for a channel a write named");
  });

  it("repeats only when the remainder changes (the DM poll runs every 5 s)", () => {
    const lines: string[] = [];
    const reportCoverage = createPassCoverageReporter((message) => lines.push(message));
    reportCoverage({ workspaceId: "ws-1", live: 40, uncovered: 24, passRows: 16 });
    reportCoverage({ workspaceId: "ws-1", live: 40, uncovered: 24, passRows: 16 });
    expect(lines).toHaveLength(1);
    reportCoverage({ workspaceId: "ws-1", live: 40, uncovered: 8, passRows: 16 });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("covered 32 of 40 joined channels");
  });

  it("reports again after a full pass, so a returning remainder is never silent", () => {
    const lines: string[] = [];
    const reportCoverage = createPassCoverageReporter((message) => lines.push(message));
    reportCoverage({ workspaceId: "ws-1", live: 40, uncovered: 24, passRows: 16 });
    reportCoverage({ workspaceId: "ws-1", live: 12, uncovered: 0, passRows: 16 });
    reportCoverage({ workspaceId: "ws-1", live: 40, uncovered: 24, passRows: 16 });
    expect(lines).toHaveLength(2);
  });

  it("keeps each workspace's remainder separate", () => {
    const lines: string[] = [];
    const reportCoverage = createPassCoverageReporter((message) => lines.push(message));
    reportCoverage({ workspaceId: "ws-1", live: 40, uncovered: 24, passRows: 16 });
    reportCoverage({ workspaceId: "ws-2", live: 40, uncovered: 24, passRows: 16 });
    expect(lines).toHaveLength(2);
  });
});

describe("createKeyedSerializer", () => {
  it("serializes runs for the SAME key (a second call waits for the first) and keeps keys independent", async () => {
    const serialize = createKeyedSerializer();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serialize("ws-a", async () => {
      events.push("a1:start");
      await firstGate;
      events.push("a1:end");
    });
    const second = serialize("ws-a", async () => {
      events.push("a2:start");
      events.push("a2:end");
    });
    const other = serialize("ws-b", async () => {
      events.push("b1:start");
      events.push("b1:end");
    });

    // A DIFFERENT key is not blocked by ws-a's in-flight pass.
    await other;
    expect(events).toEqual(["a1:start", "b1:start", "b1:end"]);

    releaseFirst();
    await first;
    await second;
    // The second ws-a pass ran ONLY after the first finished — it queued (so
    // ops journaled after the first pass started still get their own pass),
    // never overlapped.
    expect(events).toEqual(["a1:start", "b1:start", "b1:end", "a1:end", "a2:start", "a2:end"]);
  });

  it("keeps serving a key after a run rejects (a failed pass never wedges the queue)", async () => {
    const serialize = createKeyedSerializer();
    await expect(
      serialize("ws-a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(serialize("ws-a", async () => "recovered")).resolves.toBe("recovered");
  });
});

describe("relayFetchWithTimeout", () => {
  it("aborts a hung relay fetch after the timeout instead of blocking the caller forever", async () => {
    const hungFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted")),
        );
      });
    const fetchWithTimeout = relayFetchWithTimeout(25, hungFetch);
    await expect(fetchWithTimeout("http://relay.test/sync/shares")).rejects.toThrow();
  });

  it("passes fast responses through untouched", async () => {
    const fastFetch: typeof fetch = async () => Response.json({ ok: true });
    const fetchWithTimeout = relayFetchWithTimeout(1000, fastFetch);
    const response = await fetchWithTimeout("http://relay.test/sync/shares");
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("mergeJoinedChannel", () => {
  it("replaces an existing row matching by shareId OR channelWireId — re-joining under a new share never duplicates the channel", async () => {
    const existing = [
      joined({ shareId: "share-old", channelWireId: "wire-1" }),
      joined({ shareId: "share-other", channelWireId: "wire-other" }),
    ];
    // Same channel, NEW share id (revoked + re-granted): the stale row for
    // the wire id is replaced, not duplicated — and IN PLACE. The sync rotation
    // reads its positions from this array, so appending the re-granted row
    // would move the channel to the end and strand every row the rotation had
    // not reached yet (#718).
    const rejoined = mergeJoinedChannel(
      existing,
      joined({ shareId: "share-new", channelWireId: "wire-1" }),
    );
    expect(rejoined.map((row) => row.shareId)).toEqual(["share-new", "share-other"]);

    // Same share id (plain idempotent re-join) also keeps its place.
    const rejoinedSameShare = mergeJoinedChannel(
      existing,
      joined({ shareId: "share-old", channelWireId: "wire-1", access: "read-only" }),
    );
    expect(rejoinedSameShare.map((row) => row.shareId)).toEqual(["share-old", "share-other"]);
    expect(rejoinedSameShare[0]!.access).toBe("read-only");
  });

  // The join gate is gone (#640). It existed to bound the joined-lane
  // response, the scoped read bounds that now, and refusing a join could only
  // ever make the user's own channel unreachable — the shape that produced
  // three permanent-refusal defects in one review cycle.
  it("never refuses a join, however many channels the account has already joined", () => {
    const lane = Array.from({ length: 20_000 }, (_, index) =>
      joined({ shareId: `share-${index}`, channelWireId: `wire-${index}` }),
    );
    const merged = mergeJoinedChannel(
      lane,
      joined({ shareId: "share-new", channelWireId: "wire-new" }),
    );
    expect(merged).toHaveLength(20_001);
    expect(merged[merged.length - 1]!.shareId).toBe("share-new");
  });

});

// #640: the joined lane is answered for the channels a caller is SHOWING.
// This is what replaced the join gate — the response no longer carries the
// registry's history, so nothing about the read needs a join to be refused,
// and tombstones can stay for as long as the write gate needs them.
describe("scopeJoinedChannels", () => {
  // A registry that has seen far more channels than any caller shows: half
  // live, half tombstones from channels this workspace has left.
  function historicLane(size: number): JoinedSharedChannel[] {
    return Array.from({ length: size }, (_, index) =>
      joined({
        shareId: `share-${index}`,
        channelWireId: `wire-${index}`,
        ended: index % 2 === 0,
      }),
    );
  }

  // THE MUTATION TEST for the scoping. Take the scope out of
  // scopeJoinedChannels — answer the whole array — and this fails on the
  // response size, at every history size below.
  it("answers one row per channel the caller names, however many the account has ever joined", () => {
    const shown = ["wire-3", "wire-7", "wire-9"];
    const sizes = [10, 1_000, 50_000];
    const answered = sizes.map((size) => scopeJoinedChannels(historicLane(size), shown));

    for (const answers of answered) {
      expect(answers).toHaveLength(shown.length);
      expect(answers.map((answer) => answer.channelWireId)).toEqual(shown);
    }
    // Identical at every history size: the response is a function of the view.
    expect(answered[1]).toEqual(answered[0]);
    expect(answered[2]).toEqual(answered[0]);
  });

  it("answers null for a channel it holds no grant for, and the row for one it does", () => {
    const rows = [
      joined({ shareId: "share-live", channelWireId: "wire-live" }),
      joined({ shareId: "share-ro", channelWireId: "wire-ro", access: "read-only" }),
      joined({ shareId: "share-left", channelWireId: "wire-left", ended: true }),
    ];
    const answers = scopeJoinedChannels(rows, [
      "wire-live",
      "wire-ro",
      "wire-left",
      "wire-local",
    ]);
    expect(answers).toEqual([
      {
        channelWireId: "wire-live",
        joined: {
          shareId: "share-live",
          channelWireId: "wire-live",
          access: "read-write",
          granterEmail: "owner@example.com",
          ended: false,
        },
      },
      {
        channelWireId: "wire-ro",
        joined: {
          shareId: "share-ro",
          channelWireId: "wire-ro",
          access: "read-only",
          granterEmail: "owner@example.com",
          ended: false,
        },
      },
      {
        channelWireId: "wire-left",
        joined: {
          shareId: "share-left",
          channelWireId: "wire-left",
          access: "read-write",
          granterEmail: "owner@example.com",
          ended: true,
        },
      },
      // A plain local channel: asked about, and this workspace holds no grant
      // for it. Different from a channel nobody asked about, which is absent
      // and reads as unknown.
      { channelWireId: "wire-local", joined: null },
    ]);
  });

  // The unit distinction the lanes are easy to get wrong on: the RELAY lanes
  // hold one row per grant, the joined lane one row per CHANNEL. A DM with
  // several recipients is one channel, so a caller showing it names one wire
  // id and gets one answer — however many people the grant fanned out to.
  it("answers once for a multi-recipient DM, not once per grant", () => {
    const recipients = 4097;
    const shownByTheSharingSurface = Array.from({ length: recipients }, () => "wire-dm");
    const answers = scopeJoinedChannels(
      [joined({ shareId: "share-dm", channelWireId: "wire-dm" })],
      shownByTheSharingSurface,
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]!.joined?.shareId).toBe("share-dm");
  });

  it("carries no row cap, because a refused joined lane locks every channel", () => {
    const shown = Array.from({ length: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 }, (_, index) =>
      `wire-${index}`,
    );
    const answers = scopeJoinedChannels(historicLane(shown.length), shown);
    expect(() =>
      ListChatChannelSharesResult.parse({
        joined: answers,
        sessionKey: "https://relay.example||user-1",
        relay: { state: "answered", granted: [], received: [] },
      }),
    ).not.toThrow();
    expect(() => ListJoinedSharedChannelsResult.parse({ joined: answers })).not.toThrow();
  });
});

// #640 acceptance: tombstones are kept for as long as the write gate needs
// them. Nothing reaps them and nothing compacts them, because nothing depends
// on their number any more.
describe("tombstones outlive every revoke-and-grant cycle", () => {
  const wireStore = {
    findThreadChannelId: async () => null,
    getChannelWireId: async () => "wire-1",
  };

  it("keeps one tombstone per channel through any number of cycles, and still refuses writes", async () => {
    let rows: JoinedSharedChannel[] = [];
    // One channel, revoked and re-granted a thousand times. A re-grant
    // REPLACES the row for that wire, so it leaves ONE tombstone.
    for (let cycle = 0; cycle < 1_000; cycle += 1) {
      rows = mergeJoinedChannel(
        rows,
        joined({ shareId: `share-${cycle}`, channelWireId: "wire-1" }),
      );
      rows = endJoinedChannel(rows, `share-${cycle}`);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ended).toBe(true);
    // And that tombstone is still the write gate.
    await expect(
      assertSharedChannelWritable({
        workspaceId: "ws-1",
        sharedChannels: rows,
        store: wireStore,
        target: { channelId: "channel-1" },
      }),
    ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);

    // DISTINCT channels each keep their own tombstone; nothing reaps them.
    for (let index = 0; index < 500; index += 1) {
      rows = mergeJoinedChannel(
        rows,
        joined({ shareId: `left-${index}`, channelWireId: `wire-left-${index}` }),
      );
      rows = endJoinedChannel(rows, `left-${index}`);
    }
    expect(rows).toHaveLength(501);
    expect(rows.every((row) => row.ended === true)).toBe(true);
    // And the lane a caller reads is still the size of its view.
    expect(scopeJoinedChannels(rows, ["wire-left-42"])).toHaveLength(1);
  });
});

// #617 codex round 3: there is deliberately NO release helper. A pull is
// multi-page and durable, so a failure proves nothing about what landed, and a
// row removed under landed data is a channel that reads as locally owned. The
// reservation stays; syncJoinedSharedChannels finishes it or ends it.
describe("a failed join keeps its reservation", () => {
  it("leaves the row in place so the write gate still covers the channel", () => {
    const reserved = mergeJoinedChannel(
      [joined({ shareId: "share-old", channelWireId: "wire-old" })],
      joined({ shareId: "share-new", channelWireId: "wire-new", access: "read-only" }),
    );
    // The row a failed pull leaves behind is still a row: read-only, so
    // assertSharedChannelWritable refuses writes into it.
    const row = reserved.find((entry) => entry.shareId === "share-new");
    expect(row?.access).toBe("read-only");
    expect(row?.ended).toBeUndefined();
    // And it is live, so the next sync pass pulls it again rather than
    // stranding it.
    expect(reserved.filter((entry) => entry.ended !== true)).toHaveLength(2);
  });

  // The case codex named: a rejoin whose merge displaced an ended tombstone.
  // Removing the new row would erase that tombstone too and leave the wire
  // ungated — strictly worse than never having touched it.
  it("never leaves a wire that had a tombstone with no row at all", () => {
    const tombstone = joined({
      shareId: "share-revoked",
      channelWireId: "wire-1",
      ended: true,
    });
    const rejoined = mergeJoinedChannel(
      [tombstone],
      joined({ shareId: "share-regranted", channelWireId: "wire-1" }),
    );
    expect(rejoined).toHaveLength(1);
    // Whatever happens to the pull, SOME row still answers for wire-1.
    expect(rejoined.filter((entry) => entry.channelWireId === "wire-1")).toHaveLength(1);
  });
});

describe("endJoinedChannel", () => {
  it("keeps an ended provenance tombstone instead of deleting the joined row", () => {
    const existing = [
      joined({ shareId: "share-leave", channelWireId: "wire-leave" }),
      joined({ shareId: "share-other", channelWireId: "wire-other" }),
    ];

    const ended = endJoinedChannel(existing, "share-leave");

    expect(ended).toEqual([
      joined({ shareId: "share-leave", channelWireId: "wire-leave", ended: true }),
      joined({ shareId: "share-other", channelWireId: "wire-other" }),
    ]);
  });
});

describe("assertSharedChannelWritable", () => {
  it("rejects writes into a READ-ONLY joined channel before any durable mutation, leaving other channels writable", async () => {
    const { store: chats, root, seed } = await makeChats("ws-1");
    try {
      await seed({
        method: CHATS_METHOD.channelCreate,
        params: { channelId: "team", name: "team", kind: "channel", nowMs: 1 },
      });
      const teamWire = await chats.getChannelWireId({ workspaceId: "ws-1", channelId: "team" });
      expect(teamWire).not.toBeNull();
      await seed({
        method: CHATS_METHOD.threadStart,
        idempotencyKey: "team-thread:team-message",
        params: {
          channelId: "team",
          threadId: "team-thread",
          messageId: "team-message",
          authorKind: "human",
          authorDisplayName: "Member",
          body: "seeded",
          nowMs: 2,
        },
      });
      await seed({
        method: CHATS_METHOD.channelCreate,
        params: { channelId: "personal", name: "personal", kind: "channel", nowMs: 3 },
      });
      await seed({
        method: CHATS_METHOD.threadStart,
        idempotencyKey: "personal-thread:personal-message",
        params: {
          channelId: "personal",
          threadId: "personal-thread",
          messageId: "personal-message",
          authorKind: "human",
          authorDisplayName: "Member",
          body: "mine",
          nowMs: 4,
        },
      });

      const readOnlyRows = [joined({ channelWireId: teamWire!, access: "read-only" })];
      // All three write shapes gate: send/reaction target a THREAD, the
      // composer targets a CHANNEL.
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { threadId: "team-thread" },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { channelId: "team" },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      // Nothing durable landed: the seeded message is still alone.
      const messages = await chats.listMessages({ workspaceId: "ws-1", threadId: "team-thread" });
      expect(messages).toHaveLength(1);

      // The SAME channel under a read-write grant stays writable…
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: [joined({ channelWireId: teamWire!, access: "read-write" })],
          store: chats,
          target: { threadId: "team-thread" },
        }),
      ).resolves.toBeUndefined();
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: [
            joined({
              shareId: "share-active",
              channelWireId: teamWire!,
              access: "read-write",
            }),
            joined({
              shareId: "share-ended",
              channelWireId: teamWire!,
              access: "read-write",
              ended: true,
            }),
          ],
          store: chats,
          target: { threadId: "team-thread" },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      // …a plain local channel is unaffected even while a read-only grant
      // exists elsewhere…
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { channelId: "personal" },
        }),
      ).resolves.toBeUndefined();
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { threadId: "personal-thread" },
        }),
      ).resolves.toBeUndefined();
      // …and an unknown thread is not this gate's problem (the store's own
      // write path fails it honestly).
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: readOnlyRows,
          store: chats,
          target: { threadId: "thread-missing" },
        }),
      ).resolves.toBeUndefined();

      // An ENDED grant rejects writes even when its recorded access is
      // read-write (revocation → "ended means read-only local copy"): the
      // renderer skipping ended composers is honesty, not authorization.
      const endedRows = [joined({ channelWireId: teamWire!, access: "read-write", ended: true })];
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: endedRows,
          store: chats,
          target: { threadId: "team-thread" },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      await expect(
        assertSharedChannelWritable({
          workspaceId: "ws-1",
          sharedChannels: endedRows,
          store: chats,
          target: { channelId: "team" },
        }),
      ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
      // Nothing durable landed for the ended channel either.
      const afterEnded = await chats.listMessages({
        workspaceId: "ws-1",
        threadId: "team-thread",
      });
      expect(afterEnded).toHaveLength(1);
    } finally {
      await chats.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("joinedSharedChannelForTarget", () => {
  it("resolves a joined channel by channel or thread and ignores local channels", async () => {
    const { store: chats, root, seed } = await makeChats("ws-1");
    try {
      await seed({
        method: CHATS_METHOD.channelCreate,
        params: { channelId: "shared", name: "shared", kind: "channel", nowMs: 1 },
      });
      const sharedWire = await chats.getChannelWireId({
        workspaceId: "ws-1",
        channelId: "shared",
      });
      expect(sharedWire).not.toBeNull();
      await seed({
        method: CHATS_METHOD.threadStart,
        idempotencyKey: "shared-thread:shared-message",
        params: {
          channelId: "shared",
          threadId: "shared-thread",
          messageId: "shared-message",
          authorKind: "human",
          authorDisplayName: "Member",
          body: "seeded",
          nowMs: 2,
        },
      });
      await seed({
        method: CHATS_METHOD.channelCreate,
        params: { channelId: "local", name: "local", kind: "channel", nowMs: 3 },
      });
      const rows = [joined({ channelWireId: sharedWire!, relayUrl: "https://relay.one" })];

      await expect(
        joinedSharedChannelForTarget({
          workspaceId: "ws-1",
          sharedChannels: rows,
          store: chats,
          target: { channelId: "shared" },
        }),
      ).resolves.toEqual(rows[0]);
      await expect(
        joinedSharedChannelForTarget({
          workspaceId: "ws-1",
          sharedChannels: rows,
          store: chats,
          target: { threadId: "shared-thread" },
        }),
      ).resolves.toEqual(rows[0]);
      await expect(
        joinedSharedChannelForTarget({
          workspaceId: "ws-1",
          sharedChannels: rows,
          store: chats,
          target: { channelId: "local" },
        }),
      ).resolves.toBeNull();
    } finally {
      await chats.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
