import { describe, expect, it } from "vitest";
import type { JsonValue } from "../ydoc/generated/serde_json/JsonValue";
import {
  CHATS_METHOD,
  ChatsProtocolShapeError,
  decodeChatAttachment,
  decodeChatDecision,
  decodeChatMessage,
  decodeChatReaction,
  decodeChatThread,
  decodeChatsResult,
  type ChatsMethod,
  type ChatsMethodParamsMap,
  type ChatsMethodResultMap,
} from "./chatsWireContract";
import { ChatsLoopbackEngine } from "./chatsLoopbackEngine";

const WORKSPACE = "chat-loopback";

async function call<M extends ChatsMethod>(
  engine: ChatsLoopbackEngine,
  id: number,
  method: M,
  params: ChatsMethodParamsMap[M],
  idempotencyKey?: string,
): Promise<ChatsMethodResultMap[M]> {
  const response = await engine.sendRequest({
    id,
    method,
    workspace: WORKSPACE,
    params: params as JsonValue,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
  return decodeChatsResult(method, response.result);
}

describe("B2 chats wire contract and loopback", () => {
  it("round-trips every B2 daemon arm and the extended start/send arms", async () => {
    const engine = new ChatsLoopbackEngine();
    const seen = new Set<ChatsMethod>();
    let id = 0;
    const roundTrip = async <M extends ChatsMethod>(
      method: M,
      params: ChatsMethodParamsMap[M],
      idempotencyKey?: string,
    ): Promise<ChatsMethodResultMap[M]> => {
      seen.add(method);
      return call(engine, ++id, method, params, idempotencyKey);
    };

    engine.seedChannel({
      workspace: WORKSPACE,
      channelId: "agent-channel",
      name: "Agent work",
      kind: "agent",
    });
    expect(
      await roundTrip(CHATS_METHOD.channelGetWireId, { channelId: "agent-channel" }),
    ).toEqual({ wireId: "agent-channel" });

    const started = await roundTrip(
      CHATS_METHOD.threadStart,
      {
        channelId: "agent-channel",
        threadId: "channel-thread",
        messageId: "opening-message",
        title: "Channel thread",
        authorKind: "human",
        authorDisplayName: "Ada",
        authorUserId: "ada",
        body: "Please help @agent",
        nowMs: 10,
      },
      "start-channel-thread",
    );
    expect(started.thread.id).toBe("channel-thread");

    const fileThread = await roundTrip(
      CHATS_METHOD.threadCreate,
      {
        threadId: "file-thread",
        title: "File thread",
        linkedFile: { objectId: "object-1", pathHint: "notes/original.md" },
        nowMs: 20,
      },
      "create-file-thread",
    );
    expect(fileThread.linkedFile?.objectId).toBe("object-1");

    const sent = await roundTrip(
      CHATS_METHOD.messageSend,
      {
        threadId: "file-thread",
        messageId: "file-message",
        authorKind: "human",
        authorDisplayName: "Ada",
        body: "Review this @agent",
        needsDecision: true,
        attachments: [{
          objectId: "object-1",
          pathHint: "notes/original.md",
          headingText: "Scope",
          headingAnchor: "scope",
          headingOccurrence: 0,
        }],
        nowMs: 30,
      },
      "send-file-message",
    );
    expect(sent.attachments).toHaveLength(1);

    expect(
      (await roundTrip(CHATS_METHOD.threadsListForFile, {
        objectId: "object-1",
      })).threads.map((thread) => thread.id),
    ).toEqual(["file-thread"]);
    expect(
      (await roundTrip(CHATS_METHOD.threadsListForChannel, {
        channelId: "agent-channel",
      })).threads[0]?.openingMessage?.id,
    ).toBe("opening-message");
    expect(
      await roundTrip(CHATS_METHOD.threadFindChannelId, {
        threadId: "channel-thread",
      }),
    ).toBe("agent-channel");

    const projection = await roundTrip(CHATS_METHOD.threadGetProjection, {
      threadId: "file-thread",
      linkedFileAccess: { kind: "allowed", path: "notes/current.md" },
    });
    expect(projection).toMatchObject({
      readOnly: true,
      threadId: "file-thread",
    });
    expect(projection.text).toContain("Linked file: notes/current.md");

    expect(
      (await roundTrip(CHATS_METHOD.attachmentsListForThread, {
        threadId: "file-thread",
      })).attachments,
    ).toHaveLength(1);
    expect(
      (await roundTrip(CHATS_METHOD.attachmentsListFileMentions, {
        objectId: "object-1",
      })).mentions[0]?.message.attachments,
    ).toHaveLength(1);
    expect(
      (await roundTrip(CHATS_METHOD.mentionsListForHandle, {
        handle: "agent",
      })).mentions.map((mention) => mention.messageId),
    ).toEqual(["opening-message", "file-message"]);

    const resolved = await roundTrip(
      CHATS_METHOD.decisionResolve,
      {
        threadId: "file-thread",
        messageId: "file-message",
        resolvedByMessageId: "resolver-message",
        nowMs: 31,
      },
      "resolve-decision",
    );
    expect(resolved.state).toBe("resolved");
    expect(
      (await roundTrip(CHATS_METHOD.decisionsListForThread, {
        threadId: "file-thread",
      })).decisions[0]?.resolvedByMessageId,
    ).toBe("resolver-message");

    const reaction = await roundTrip(
      CHATS_METHOD.reactionSet,
      {
        threadId: "file-thread",
        messageId: "file-message",
        emoji: "👍",
        author: { authorId: "ada", kind: "human", displayName: "Ada" },
        state: "added",
        nowMs: 32,
      },
      "add-reaction",
    );
    expect(
      (await roundTrip(CHATS_METHOD.reactionsList, {
        threadId: "file-thread",
      })).reactions[0]?.reactionId,
    ).toBe(reaction.reactionId);

    expect(
      (await roundTrip(CHATS_METHOD.agentReadListUnreadThreads, {})).threads.length,
    ).toBeGreaterThan(0);
    expect(
      (await roundTrip(CHATS_METHOD.agentReadMarkThreadRead, {
        threadId: "file-thread",
        upTo: { createdAtMs: 999, messageId: "zzzz" },
      })).lastReadMessageId,
    ).toBe("file-message");

    expect(
      await roundTrip(CHATS_METHOD.followsEnsureDefaults, { ownerUserId: "viewer" }),
    ).toBeNull();
    engine.seedFollow(WORKSPACE, "viewer", "thread", "file-thread");
    const feed = await roundTrip(CHATS_METHOD.feedListPersonal, {
      ownerUserId: "viewer",
    });
    const fileFeedItem = feed.items.find((item) => item.message.id === "file-message");
    expect(fileFeedItem?.message.attachments).toHaveLength(1);
    expect(fileFeedItem?.thread.linkedFile).toEqual({
      objectId: "object-1",
      pathHint: "notes/original.md",
      linkedAtMs: 20,
    });
    // MUTATION: legacy slim Feed copies erase attachments and linked-file metadata.

    for (const bookmarkId of ["find", "archive", "pending", "failed", "stale"]) {
      engine.seedBookmark({
        bookmarkId: `bookmark-${bookmarkId}`,
        workspaceId: WORKSPACE,
        ownerUserId: "viewer",
        targetKind: "thread",
        targetId: "file-thread",
        threadId: "file-thread",
        mode: "live",
        destinationPath: `bookmarks/${bookmarkId}.md`,
        state: "active",
        createdAtMs: 40,
      });
    }
    expect(
      (await roundTrip(CHATS_METHOD.bookmarkFind, {
        ownerUserId: "viewer",
        bookmarkId: "bookmark-find",
      }))?.bookmarkId,
    ).toBe("bookmark-find");
    expect(
      (await roundTrip(CHATS_METHOD.bookmarkListPending, {
        ownerUserId: "viewer",
      })).bookmarks.length,
    ).toBe(5);
    expect(
      (await roundTrip(CHATS_METHOD.bookmarkArchive, {
        ownerUserId: "viewer",
        bookmarkId: "bookmark-archive",
      })).state,
    ).toBe("archived");
    expect(
      (await roundTrip(
        CHATS_METHOD.bookmarkMarkPending,
        { ownerUserId: "viewer", bookmarkId: "bookmark-pending" },
        "bookmark-pending",
      )).generation,
    ).toBe(2);
    expect(
      (await roundTrip(CHATS_METHOD.bookmarkMarkFailed, {
        ownerUserId: "viewer",
        bookmarkId: "bookmark-failed",
        generation: 1,
        failureReason: "render failed",
      })).applied,
    ).toBe(true);
    expect(
      (await roundTrip(CHATS_METHOD.bookmarkMarkStale, {
        ownerUserId: "viewer",
        bookmarkId: "bookmark-stale",
        generation: 1,
      })).applied,
    ).toBe(true);

    const inserted = await roundTrip(CHATS_METHOD.dispatchRecordEligibleTriggers, {
      verifiedUserId: "ada",
    });
    expect(inserted).toBe(2);
    expect(
      (await roundTrip(CHATS_METHOD.dispatchListPending, {})).dispatches,
    ).toHaveLength(2);

    const claim = await roundTrip(CHATS_METHOD.dispatchClaimNextPending, {
      runId: "run-live",
      command: "agent",
      logPath: "runs/run-live.log",
      nowMs: 50,
    });
    expect(claim?.run.runId).toBe("run-live");
    expect(
      (await roundTrip(CHATS_METHOD.dispatchOpenRuns, {})).claims[0]?.run.runId,
    ).toBe("run-live");
    expect(
      await roundTrip(CHATS_METHOD.dispatchRecordRunMessage, {
        messageId: "agent-output",
        runId: "run-live",
      }),
    ).toBe(true);
    expect(
      (await roundTrip(CHATS_METHOD.dispatchListRunMessages, {
        runId: "run-live",
      })).messageIds,
    ).toEqual(["agent-output"]);
    expect(
      await roundTrip(CHATS_METHOD.dispatchRunIdForMessage, {
        messageId: "agent-output",
      }),
    ).toBe("run-live");
    expect(
      (await roundTrip(CHATS_METHOD.dispatchRunRecordsForThread, {
        threadId: "channel-thread",
        limit: 200,
      })).runs["agent-output"]?.runId,
    ).toBe("run-live");
    expect(
      (await roundTrip(CHATS_METHOD.dispatchGetRunRecord, {
        runId: "run-live",
      }))?.runId,
    ).toBe("run-live");
    expect(
      await roundTrip(CHATS_METHOD.dispatchRecentCount, {
        threadId: "channel-thread",
        sinceMs: -1.5,
      }),
    ).toBe(1);

    const paused = await roundTrip(CHATS_METHOD.dispatchSetThreadPaused, {
      threadId: "file-thread",
      paused: true,
      reason: "manual",
    });
    expect(paused.reason).toBe("manual");
    expect(
      await roundTrip(CHATS_METHOD.dispatchIsThreadPaused, { threadId: "file-thread" }),
    ).toBe(true);
    expect(
      (await roundTrip(CHATS_METHOD.dispatchGetThreadPauseState, {
        threadId: "file-thread",
      }))?.reason,
    ).toBe("manual");

    engine.seedDispatch({
      workspaceId: WORKSPACE,
      triggerMessageId: "recover-trigger",
      threadId: "file-thread",
      state: "failed",
      runId: "recover-run",
      failureReason: "app-quit",
      attemptCount: 1,
      createdAtMs: 60,
    });
    engine.seedRun({
      workspaceId: WORKSPACE,
      runId: "recover-run",
      threadId: "file-thread",
      triggerMessageId: "recover-trigger",
      command: "agent",
      startedAtMs: 60,
      endedAtMs: 61,
      exitCode: 143,
      failureReason: "app-quit",
    });
    expect(
      (await roundTrip(CHATS_METHOD.dispatchListAppQuitRecoveries, {}))
        .recoveries[0]?.run.runId,
    ).toBe("recover-run");
    expect(
      (await roundTrip(CHATS_METHOD.dispatchMarkFailureNotePosted, {
        runId: "recover-run",
      })).failureNotePosted,
    ).toBe(true);

    engine.seedDispatch({
      workspaceId: WORKSPACE,
      triggerMessageId: "requeue-trigger",
      threadId: "file-thread",
      state: "failed",
      runId: "requeue-run",
      failureReason: "app-quit",
      attemptCount: 1,
      createdAtMs: 70,
    });
    engine.seedRun({
      workspaceId: WORKSPACE,
      runId: "requeue-run",
      threadId: "file-thread",
      triggerMessageId: "requeue-trigger",
      command: "agent",
      startedAtMs: 70,
      endedAtMs: 71,
      exitCode: 143,
      failureReason: "app-quit",
    });
    expect(
      await roundTrip(CHATS_METHOD.dispatchRequeueFailedTrigger, {
        triggerMessageId: "requeue-trigger",
        runId: "requeue-run",
      }),
    ).toBe(true);
    expect(
      await roundTrip(CHATS_METHOD.dispatchFailPendingForThread, {
        threadId: "file-thread",
        reason: "stop",
      }),
    ).toBeGreaterThan(0);

    expect([...seen].sort()).toEqual(Object.values(CHATS_METHOD).sort());
  });

  it("preserves prototype-named message ids in a null-prototype run map", () => {
    const run: JsonValue = {
      workspaceId: WORKSPACE,
      runId: "run-prototype-key",
      threadId: "thread",
      triggerMessageId: "trigger",
      command: "agent",
      startedAtMs: 1,
      failureNotePosted: false,
    };
    const wireRuns: { [key: string]: JsonValue | undefined } = {};
    for (const messageId of ["__proto__", "constructor"]) {
      Object.defineProperty(wireRuns, messageId, {
        value: run,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }

    const decoded = decodeChatsResult(CHATS_METHOD.dispatchRunRecordsForThread, {
      runs: wireRuns,
      nextCursor: null,
    });

    // MUTATION: replacing Object.create(null) with {} drops __proto__ into the
    // prototype setter instead of preserving the caller-supplied message id.
    expect(Object.getPrototypeOf(decoded.runs)).toBeNull();
    expect(Object.keys(decoded.runs)).toEqual(["__proto__", "constructor"]);
    expect(Object.prototype.hasOwnProperty.call(decoded.runs, "__proto__")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(decoded.runs, "constructor")).toBe(true);
    expect(decoded.runs["__proto__"]?.runId).toBe("run-prototype-key");
    expect(decoded.runs["constructor"]?.runId).toBe("run-prototype-key");
  });

  it("enforces LWW bumps, cursor binding, ledger dedup, and mention-derived scanning", async () => {
    const engine = new ChatsLoopbackEngine();
    engine.seedChannel({
      workspace: WORKSPACE,
      channelId: "channel",
      name: "General",
    });
    await call(
      engine,
      1,
      CHATS_METHOD.threadStart,
      {
        channelId: "channel",
        threadId: "thread",
        messageId: "message",
        authorKind: "human",
        authorDisplayName: "Ada",
        body: "hello @agent",
        nowMs: 10,
      },
      "start",
    );

    const first = await call(
      engine,
      2,
      CHATS_METHOD.reactionSet,
      {
        threadId: "thread",
        messageId: "message",
        emoji: "👍",
        author: { authorId: "ada", kind: "human", displayName: "Ada" },
        state: "added",
        nowMs: 20,
      },
      "reaction-1",
    );
    const second = await call(
      engine,
      3,
      CHATS_METHOD.reactionSet,
      {
        threadId: "thread",
        messageId: "message",
        emoji: "👍",
        author: { authorId: "ada", kind: "human", displayName: "Ada" },
        state: "removed",
        nowMs: 20,
      },
      "reaction-2",
    );
    // MUTATION: drop the per-cell bump -> both writes receive atMs=20.
    expect(second.atMs).toBe(first.atMs + 1);
    expect(
      (await call(engine, 4, CHATS_METHOD.reactionsList, { threadId: "thread" }))
        .reactions,
    ).toEqual([]);

    const inserted = await call(
      engine,
      5,
      CHATS_METHOD.dispatchRecordEligibleTriggers,
      {},
    );
    const retry = await call(
      engine,
      6,
      CHATS_METHOD.dispatchRecordEligibleTriggers,
      {},
    );
    // MUTATION: omit send-time mention indexing or ledger insert-ignore -> these differ.
    expect([inserted, retry]).toEqual([1, 0]);

    await call(
      engine,
      7,
      CHATS_METHOD.threadCreate,
      {
        threadId: "file-a",
        title: "A",
        linkedFile: { objectId: "same-object" },
        nowMs: 30,
      },
      "file-a",
    );
    await call(
      engine,
      8,
      CHATS_METHOD.threadCreate,
      {
        threadId: "file-b",
        title: "B",
        linkedFile: { objectId: "same-object" },
        nowMs: 31,
      },
      "file-b",
    );
    const pageOne = await call(engine, 9, CHATS_METHOD.threadsListForFile, {
      objectId: "same-object",
      pageLimit: 1,
    });
    const pageTwo = await call(engine, 10, CHATS_METHOD.threadsListForFile, {
      objectId: "same-object",
      pageLimit: 1,
      cursor: pageOne.nextCursor ?? undefined,
    });
    expect([
      pageOne.threads[0]?.id,
      pageTwo.threads[0]?.id,
      pageTwo.nextCursor,
    ]).toEqual(["file-a", "file-b", null]);
    await expect(
      call(engine, 11, CHATS_METHOD.dispatchListPending, {
        cursor: pageOne.nextCursor ?? undefined,
      }),
    ).rejects.toThrow("invalid-cursor");

    const replay = await call(
      engine,
      12,
      CHATS_METHOD.threadCreate,
      {
        threadId: "file-b",
        title: "B",
        linkedFile: { objectId: "same-object" },
        nowMs: 31,
      },
      "file-b",
    );
    expect(replay.id).toBe("file-b");
    await expect(
      call(
        engine,
        13,
        CHATS_METHOD.threadCreate,
        {
          threadId: "file-b",
          title: "changed",
          linkedFile: { objectId: "same-object" },
          nowMs: 31,
        },
        "file-b",
      ),
    ).rejects.toThrow("idempotency-key-reuse-mismatch");
  });

  it("deduplicates a normalized chat write retry with a different nowMs", async () => {
    const engine = new ChatsLoopbackEngine();
    const first = await call(
      engine,
      1,
      CHATS_METHOD.threadCreate,
      {
        threadId: " file-thread ",
        title: " File thread ",
        linkedFile: {
          objectId: " object ",
          pathHint: "notes\\file.md",
        },
        nowMs: 10,
      },
      "normalized-file-thread",
    );
    const replay = await call(
      engine,
      2,
      CHATS_METHOD.threadCreate,
      {
        nowMs: 999,
        linkedFile: {
          pathHint: "notes/file.md",
          objectId: "object",
        },
        title: "File thread",
        threadId: "file-thread",
      },
      "normalized-file-thread",
    );

    // MUTATION: fingerprinting raw params (including nowMs or insertion order)
    // turns this semantic retry into idempotency-key-reuse-mismatch.
    expect(replay).toEqual(first);
    expect(replay.createdAtMs).toBe(10);
  });

  it("keeps dispatch claims single-flight until the open run ends", async () => {
    const running = new ChatsLoopbackEngine();
    running.seedDispatch({
      workspaceId: WORKSPACE,
      triggerMessageId: "first-trigger",
      threadId: "first-thread",
      state: "pending",
      createdAtMs: 10,
    });
    running.seedDispatch({
      workspaceId: WORKSPACE,
      triggerMessageId: "next-trigger",
      threadId: "next-thread",
      state: "pending",
      createdAtMs: 20,
    });
    expect(
      (await call(running, 1, CHATS_METHOD.dispatchClaimNextPending, {
        runId: "open-run",
        nowMs: 30,
      }))?.dispatch.triggerMessageId,
    ).toBe("first-trigger");
    // MUTATION: omit the workspace-wide running-dispatch guard -> the next trigger is double-claimed.
    expect(
      await call(running, 2, CHATS_METHOD.dispatchClaimNextPending, {
        runId: "blocked-run",
        nowMs: 31,
      }),
    ).toBeNull();

    const ended = new ChatsLoopbackEngine();
    ended.seedDispatch({
      workspaceId: WORKSPACE,
      triggerMessageId: "first-trigger",
      threadId: "first-thread",
      state: "done",
      runId: "open-run",
      attemptCount: 1,
      createdAtMs: 10,
      updatedAtMs: 32,
    });
    ended.seedRun({
      workspaceId: WORKSPACE,
      runId: "open-run",
      threadId: "first-thread",
      triggerMessageId: "first-trigger",
      command: "",
      startedAtMs: 30,
      endedAtMs: 32,
      exitCode: 0,
    });
    ended.seedDispatch({
      workspaceId: WORKSPACE,
      triggerMessageId: "next-trigger",
      threadId: "next-thread",
      state: "pending",
      createdAtMs: 20,
    });
    expect(
      (await call(ended, 3, CHATS_METHOD.dispatchClaimNextPending, {
        runId: "next-run",
        nowMs: 33,
      }))?.dispatch.triggerMessageId,
    ).toBe("next-trigger");
  });

  it("returns the durable claim when the same running run id retries", async () => {
    const engine = new ChatsLoopbackEngine();
    engine.seedDispatch({
      workspaceId: WORKSPACE,
      triggerMessageId: "trigger",
      threadId: "thread",
      state: "pending",
      createdAtMs: 10,
    });
    const first = await call(engine, 1, CHATS_METHOD.dispatchClaimNextPending, {
      runId: "retry-run",
      command: "agent",
      nowMs: 20,
    });
    const retry = await call(engine, 2, CHATS_METHOD.dispatchClaimNextPending, {
      runId: "retry-run",
      command: "ignored-on-retry",
      nowMs: 21,
    });
    // MUTATION: rejecting every known run id loses the daemon's response-loss retry contract.
    expect(retry).toEqual(first);
  });

  it("refuses ended and foreign run-id reuse as invalid input", async () => {
    const engine = new ChatsLoopbackEngine();
    engine.seedRun({
      workspaceId: WORKSPACE,
      runId: "ended-run",
      threadId: "ended-thread",
      triggerMessageId: "ended-trigger",
      command: "",
      startedAtMs: 10,
      endedAtMs: 20,
    });
    engine.seedRun({
      workspaceId: "other-workspace",
      runId: "foreign-run",
      threadId: "foreign-thread",
      triggerMessageId: "foreign-trigger",
      command: "",
      startedAtMs: 10,
    });
    for (const runId of ["ended-run", "foreign-run"]) {
      // MUTATION: treating known ended/foreign ids as state corruption diverges
      // from the daemon's explicit caller-facing invalid-input refusal.
      await expect(
        call(engine, 1, CHATS_METHOD.dispatchClaimNextPending, { runId, nowMs: 30 }),
      ).rejects.toThrow("invalid-input");
    }
  });

  it("refuses over-cap projections without returning partial markdown", async () => {
    const engine = new ChatsLoopbackEngine();
    engine.seedChannel({
      workspace: WORKSPACE,
      channelId: "channel",
      name: "General",
    });
    await call(
      engine,
      1,
      CHATS_METHOD.threadStart,
      {
        channelId: "channel",
        threadId: "large-thread",
        messageId: "large-message",
        authorKind: "human",
        authorDisplayName: "Ada",
        body: "x".repeat(50 * 1024),
        nowMs: 10,
      },
      "large-thread",
    );
    // MUTATION: slice/truncate the projection to 48 KiB -> this resolves.
    await expect(
      call(engine, 2, CHATS_METHOD.threadGetProjection, {
        threadId: "large-thread",
      }),
    ).rejects.toThrow("projection-exceeds-inband-limit");
  });

  it("refuses duplicate names, occupied targets, and unknown params", async () => {
    const engine = new ChatsLoopbackEngine();
    engine.seedChannel({
      workspace: WORKSPACE,
      channelId: "one",
      name: "General",
    });
    expect(() =>
      engine.seedChannel({
        workspace: WORKSPACE,
        channelId: "two",
        name: "general",
      }),
    ).toThrow("channel-exists");

    await call(
      engine,
      1,
      CHATS_METHOD.threadCreate,
      {
        threadId: "thread",
        title: "Thread",
        linkedFile: { objectId: "object" },
      },
      "thread",
    );
    await expect(
      call(
        engine,
        2,
        CHATS_METHOD.threadCreate,
        {
          threadId: "thread",
          title: "Thread",
          linkedFile: { objectId: "object" },
        },
        "different-key",
      ),
    ).rejects.toThrow("target-exists");

    await expect(
      engine.sendRequest({
        id: 3,
        method: CHATS_METHOD.dispatchListPending,
        workspace: WORKSPACE,
        params: { surprise: true },
      }),
    ).rejects.toThrow("invalid-parameters");
    // MUTATION: accept unknown params -> daemon/loopback contract parity breaks.
  });

  it("uses invalid-parameters for an oversized page limit", async () => {
    const engine = new ChatsLoopbackEngine();
    // MUTATION: restore the cursor error identity for pageLimit > 500 -> this mismatches the daemon.
    await expect(
      call(engine, 1, CHATS_METHOD.dispatchListPending, { pageLimit: 501 }),
    ).rejects.toThrow("invalid-parameters");
  });

  it("uses invalid-parameters for listPending logical limit above 200", async () => {
    const engine = new ChatsLoopbackEngine();
    // MUTATION: retain invalid-bookmark-target for limit > 200 -> daemon/loopback errors diverge.
    await expect(
      call(engine, 1, CHATS_METHOD.bookmarkListPending, {
        ownerUserId: "viewer",
        limit: 201,
      }),
    ).rejects.toThrow("invalid-parameters");
  });

  it("uses invalid-follow-target for a personal feed limit above 100", async () => {
    const engine = new ChatsLoopbackEngine();
    // MUTATION: restore the loopback's cursor error for limit > 100 -> its
    // error identity diverges from the daemon domain contract.
    await expect(
      call(engine, 1, CHATS_METHOD.feedListPersonal, {
        ownerUserId: "viewer",
        limit: 101,
      }),
    ).rejects.toThrow("invalid-follow-target");
  });

  it("kind-gates feed author follows by user id in oracle matchedBy order", async () => {
    const engine = new ChatsLoopbackEngine();
    engine.seedChannel({
      workspace: WORKSPACE,
      channelId: "channel",
      wireId: "channel-wire",
      name: "General",
    });
    await call(
      engine,
      1,
      CHATS_METHOD.threadStart,
      {
        channelId: "channel",
        threadId: "human-thread",
        messageId: "human-opening",
        authorKind: "human",
        authorDisplayName: "Ada Display",
        authorUserId: "ada",
        body: "Human",
        nowMs: 10,
      },
      "human-start",
    );
    await call(
      engine,
      2,
      CHATS_METHOD.threadStart,
      {
        channelId: "channel",
        threadId: "agent-thread",
        messageId: "agent-opening",
        authorKind: "agent",
        authorDisplayName: "Agent Display",
        authorUserId: "agent-user",
        body: "Agent",
        nowMs: 11,
      },
      "agent-start",
    );

    engine.seedFollow(WORKSPACE, "person-viewer", "person", "ada");
    engine.seedFollow(WORKSPACE, "person-viewer", "person", "agent-user");
    const personFeed = await call(engine, 3, CHATS_METHOD.feedListPersonal, {
      ownerUserId: "person-viewer",
    });
    // MUTATION: let a person follow match every author kind -> agent-opening leaks here.
    expect(personFeed.items.map((item) => item.message.id)).toEqual(["human-opening"]);

    engine.seedFollow(WORKSPACE, "agent-viewer", "agent", "agent-user");
    const agentFeed = await call(engine, 4, CHATS_METHOD.feedListPersonal, {
      ownerUserId: "agent-viewer",
    });
    // MUTATION: match agent follows by displayName -> this id-addressed follow misses.
    expect(agentFeed.items.map((item) => item.message.id)).toEqual(["agent-opening"]);
    expect(agentFeed.items[0]?.matchedBy).toEqual(["agent"]);

    for (const [kind, target] of [
      ["person", "ada"],
      ["thread", "human-thread"],
      ["channel", "channel-wire"],
    ] as const) {
      engine.seedFollow(WORKSPACE, "order-viewer", kind, target);
    }
    const orderedFeed = await call(engine, 5, CHATS_METHOD.feedListPersonal, {
      ownerUserId: "order-viewer",
    });
    const humanItem = orderedFeed.items.find((item) => item.message.id === "human-opening");
    // MUTATION: push thread/channel matches before the author match -> order differs from the oracle.
    expect(humanItem?.matchedBy).toEqual(["person", "thread", "channel"]);
  });

  it("matches default channel follows by wire id", async () => {
    const engine = new ChatsLoopbackEngine();
    engine.seedChannel({
      workspace: WORKSPACE,
      channelId: "local-channel-id",
      wireId: "shared-wire-id",
      name: "Shared",
    });
    await call(
      engine,
      1,
      CHATS_METHOD.threadStart,
      {
        channelId: "local-channel-id",
        threadId: "thread",
        messageId: "opening",
        authorKind: "human",
        authorDisplayName: "Ada",
        body: "Opening",
        nowMs: 10,
      },
      "start",
    );
    await call(engine, 2, CHATS_METHOD.followsEnsureDefaults, {
      ownerUserId: "viewer",
    });
    const feed = await call(engine, 3, CHATS_METHOD.feedListPersonal, {
      ownerUserId: "viewer",
    });
    // MUTATION: compare the follow target with thread.channelId -> the opening disappears.
    expect(feed.items.map((item) => item.message.id)).toEqual(["opening"]);
    expect(feed.items[0]?.matchedBy).toEqual(["channel"]);
  });

  it("uses the human sequence cursor for channel summaries", async () => {
    const engine = new ChatsLoopbackEngine();
    engine.seedChannel({
      workspace: WORKSPACE,
      channelId: "channel",
      name: "General",
    });
    await call(
      engine,
      1,
      CHATS_METHOD.threadStart,
      {
        channelId: "channel",
        threadId: "thread",
        messageId: "opening",
        authorKind: "human",
        authorDisplayName: "Ada",
        body: "Opening",
        nowMs: 10,
      },
      "start",
    );
    await call(
      engine,
      2,
      CHATS_METHOD.messageSend,
      {
        threadId: "thread",
        messageId: "second",
        authorKind: "human",
        authorDisplayName: "Ada",
        body: "Second",
        nowMs: 20,
      },
      "send",
    );
    await call(engine, 3, CHATS_METHOD.agentReadMarkThreadRead, {
      threadId: "thread",
      upTo: { createdAtMs: 999, messageId: "after" },
    });
    engine.seedThreadRead(WORKSPACE, "thread", 1);

    const page = await call(engine, 4, CHATS_METHOD.threadsListForChannel, {
      channelId: "channel",
    });
    // MUTATION: derive this summary from agentReads -> the fully-read agent
    // cursor reports 2/0 instead of the human cursor's 1/1.
    expect(page.threads[0]).toMatchObject({
      lastReadSequence: 1,
      unreadCount: 1,
    });
  });

  it("coalesces every pending trigger in the claimed thread", async () => {
    const engine = new ChatsLoopbackEngine();
    for (const [triggerMessageId, createdAtMs] of [
      ["first", 10],
      ["second", 11],
    ] as const) {
      engine.seedDispatch({
        workspaceId: WORKSPACE,
        triggerMessageId,
        threadId: "thread",
        state: "pending",
        createdAtMs,
      });
    }
    const claim = await call(engine, 1, CHATS_METHOD.dispatchClaimNextPending, {
      runId: "run-one",
      nowMs: 20,
    });
    const secondClaim = await call(engine, 2, CHATS_METHOD.dispatchClaimNextPending, {
      runId: "run-two",
      nowMs: 21,
    });
    // MUTATION: leave same-thread siblings pending -> secondClaim claims "second".
    expect(claim?.dispatch.triggerMessageId).toBe("first");
    expect(secondClaim).toBeNull();
  });

  it("rejects missing and cross-thread reply parents", async () => {
    const engine = new ChatsLoopbackEngine();
    engine.seedChannel({
      workspace: WORKSPACE,
      channelId: "channel",
      name: "General",
    });
    for (const [threadId, messageId] of [
      ["thread-a", "opening-a"],
      ["thread-b", "opening-b"],
    ] as const) {
      await call(
        engine,
        threadId === "thread-a" ? 1 : 2,
        CHATS_METHOD.threadStart,
        {
          channelId: "channel",
          threadId,
          messageId,
          authorKind: "human",
          authorDisplayName: "Ada",
          body: "Opening",
          nowMs: threadId === "thread-a" ? 10 : 11,
        },
        `start-${threadId}`,
      );
    }
    const reply = (id: number, messageId: string, parentMessageId: string) =>
      call(engine, id, CHATS_METHOD.messageSend, {
        threadId: "thread-a",
        messageId,
        authorKind: "human",
        authorDisplayName: "Ada",
        parentMessageId,
        body: "Reply",
        nowMs: 20 + id,
      });
    // MUTATION: store parentMessageId unchecked -> either request resolves.
    await expect(reply(3, "missing-reply", "missing")).rejects.toThrow("message-not-found");
    await expect(reply(4, "cross-reply", "opening-b")).rejects.toThrow("message-not-found");
  });
});

describe("chats result decoder rejection", () => {
  it("accepts daemon-emitted negative imported timestamps", () => {
    // MUTATION: restore any decoder's default nonnegative guard -> its decode throws.
    expect(
      decodeChatReaction({
        reactionId: "reaction",
        threadId: "thread",
        messageId: "message",
        emoji: "👍",
        author: { authorId: "ada", kind: "human", displayName: "" },
        state: "added",
        atMs: -10,
      }).atMs,
    ).toBe(-10);
    expect(
      decodeChatDecision({
        threadId: "thread",
        messageId: "message",
        state: "open",
        atMs: -9,
      }).atMs,
    ).toBe(-9);
    expect(
      decodeChatThread({
        id: "thread",
        workspaceId: "workspace",
        title: "Imported",
        createdAtMs: -30,
        updatedAtMs: -30,
        linkedFile: { objectId: "object", linkedAtMs: -31 },
      }).linkedFile?.linkedAtMs,
    ).toBe(-31);
    expect(
      decodeChatAttachment({
        attachmentId: "attachment",
        threadId: "thread",
        messageId: "message",
        targetKind: "file",
        createdAtMs: -28,
      }).createdAtMs,
    ).toBe(-28);

    const negativeMessage: JsonValue = {
      id: "negative-message",
      workspaceId: "workspace",
      threadId: "thread",
      author: { kind: "human", displayName: "" },
      body: "Imported",
      createdAtMs: -40,
      attachments: [],
    };
    // This is the shared message-row decoder used by messages.list-shaped rows.
    expect(decodeChatMessage(negativeMessage).createdAtMs).toBe(-40);

    const feed = decodeChatsResult(CHATS_METHOD.feedListPersonal, {
      items: [{
        message: negativeMessage,
        thread: {
          id: "thread",
          workspaceId: "workspace",
          title: "Imported",
          createdAtMs: -41,
          updatedAtMs: -40,
          channelId: "channel",
        },
        reactions: [],
        matchedBy: ["person"],
        channel: {
          id: "channel",
          workspaceId: "workspace",
          name: "Imported",
          slug: "imported",
          kind: "channel",
          createdAtMs: -42,
          updatedAtMs: -41,
        },
      }],
      nextCursor: null,
      headCursor: null,
      readState: {
        workspaceId: "workspace",
        ownerUserId: "viewer",
        lastSeenCreatedAtMs: -40,
        lastSeenMessageId: "negative-message",
        updatedAtMs: -39,
      },
    });
    expect(feed.items[0]?.message.createdAtMs).toBe(-40);
    expect(feed.items[0]?.channel?.createdAtMs).toBe(-42);
    expect(feed.readState?.lastSeenCreatedAtMs).toBe(-40);
    expect(feed.readState?.updatedAtMs).toBe(-39);
    const agentRead = decodeChatsResult(CHATS_METHOD.agentReadMarkThreadRead, {
      workspaceId: "workspace",
      threadId: "thread",
      lastReadCreatedAtMs: -40,
      lastReadMessageId: "negative-message",
      revision: 1,
      updatedAtMs: 10,
    });
    expect(agentRead.lastReadCreatedAtMs).toBe(-40);

    const summaries = decodeChatsResult(CHATS_METHOD.threadsListForChannel, {
      threads: [{
        thread: {
          id: "thread",
          workspaceId: "workspace",
          title: "Imported",
          createdAtMs: -41,
          updatedAtMs: -40,
          channelId: "channel",
        },
        messageCount: 1,
        lastReadSequence: 0,
        unreadCount: 1,
        openDecisionCount: 0,
        openingMessage: {
          id: "negative-message",
          author: { kind: "human", displayName: "" },
          createdAtMs: -40,
          bodySnippet: "Imported",
          reactions: [],
        },
      }],
      nextCursor: null,
    });
    expect(summaries.threads[0]?.openingMessage?.createdAtMs).toBe(-40);

    const mentions = decodeChatsResult(CHATS_METHOD.mentionsListForHandle, {
      mentions: [{
        threadId: "thread",
        messageId: "negative-message",
        handle: "agent",
        authorKind: "human",
        createdAtMs: -40,
      }],
      nextCursor: null,
    });
    expect(mentions.mentions[0]?.createdAtMs).toBe(-40);

    const fileMentions = decodeChatsResult(CHATS_METHOD.attachmentsListFileMentions, {
      mentions: [{
        attachment: {
          attachmentId: "attachment",
          threadId: "thread",
          messageId: "negative-message",
          targetKind: "file",
          objectId: "object",
          createdAtMs: -39,
        },
        message: negativeMessage,
        thread: {
          id: "thread",
          workspaceId: "workspace",
          title: "Imported",
          createdAtMs: -41,
          updatedAtMs: -40,
          channelId: "channel",
        },
        channel: {
          workspaceId: "workspace",
          channelId: "channel",
          name: "Imported",
          slug: "imported",
          kind: "channel",
          createdAtMs: -42,
          updatedAtMs: -41,
        },
      }],
      nextCursor: null,
    });
    expect(fileMentions.mentions[0]?.channel?.updatedAtMs).toBe(-41);
  });

  it("reports a wrong-typed nested field path", () => {
    expect(() =>
      decodeChatMessage({
        id: "m",
        workspaceId: "w",
        threadId: "t",
        author: { kind: "human", displayName: "Ada" },
        body: "body",
        createdAtMs: "wrong",
        attachments: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ChatsProtocolShapeError>>({
        name: "ChatsProtocolShapeError",
        message: expect.stringContaining("chat message.createdAtMs"),
      }),
    );
  });

  it("rejects unknown result fields and invalid discriminants", () => {
    expect(() =>
      decodeChatsResult(CHATS_METHOD.threadGetProjection, {
        path: ".dohc/chats/a.md",
        readOnly: true,
        threadId: "t",
        text: "x",
        surprise: true,
      }),
    ).toThrow(ChatsProtocolShapeError);
    expect(() =>
      decodeChatsResult(CHATS_METHOD.reactionSet, {
        reactionId: "r",
        threadId: "t",
        messageId: "m",
        emoji: "👍",
        author: { authorId: "a", kind: "robot", displayName: "A" },
        state: "added",
        atMs: 1,
      }),
    ).toThrow(ChatsProtocolShapeError);
  });
});
