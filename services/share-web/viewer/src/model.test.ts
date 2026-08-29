import { describe, expect, it } from "vitest";
import {
  filesFromAccumulator,
  filesFromLog,
  foldLogOps,
  mergeDiscussionMessages,
  mergeDiscussionWindowMessages,
  parseDiscussionAppendResult,
  parseDiscussionActivity,
  parseDiscussionPage,
  type RelayOp,
  type SharedFile,
} from "./model";

const PATH = "notes.txt";
const ORIGINAL_SHA = "0".repeat(64);
const FAST_FORWARD_SHA = "1".repeat(64);
const DIVERGENT_SHA = "2".repeat(64);
const LATER_FAST_FORWARD_SHA = "3".repeat(64);
const PROJECTED_PREIMAGE_SHA = "4".repeat(64);
const ARRIVED_SHA = "5".repeat(64);

function snapshotOp(file: SharedFile): RelayOp {
  return {
    relaySeq: 1,
    opKind: "version.create",
    payload: { forkSnapshots: [file] },
    recordedAtMs: 1,
  };
}

function writeOp(
  relaySeq: number,
  beforeBlobSha256: string,
  afterBlobSha256: string,
): RelayOp {
  return {
    relaySeq,
    opKind: "moment.append",
    payload: {
      operation: "write",
      path: PATH,
      payloadBeforePath: PATH,
      payloadBeforeBlobSha256: beforeBlobSha256,
      payloadAfterPath: PATH,
      payloadAfterBlobSha256: afterBlobSha256,
      payloadAfterContentKind: "text",
    },
    recordedAtMs: relaySeq,
  };
}

function deleteOp(relaySeq: number, beforeBlobSha256: string): RelayOp {
  return {
    relaySeq,
    opKind: "moment.append",
    payload: {
      operation: "delete",
      path: PATH,
      payloadBeforePath: PATH,
      payloadBeforeBlobSha256: beforeBlobSha256,
      payloadAfterPath: PATH,
      payloadAfterBlobSha256: beforeBlobSha256,
      payloadAfterContentKind: "text",
    },
    recordedAtMs: relaySeq,
  };
}

describe("filesFromLog", () => {
  it("ignores a later divergent append instead of letting relay arrival order win", () => {
    const original: SharedFile = {
      path: PATH,
      blobSha256: ORIGINAL_SHA,
      contentKind: "text",
    };

    expect(filesFromLog([
      snapshotOp(original),
      writeOp(2, ORIGINAL_SHA, FAST_FORWARD_SHA),
      writeOp(3, ORIGINAL_SHA, DIVERGENT_SHA),
    ])).toEqual([{
      path: PATH,
      blobSha256: FAST_FORWARD_SHA,
      contentKind: "text",
    }]);
  });

  it("continues the surviving branch and ignores a divergent delete", () => {
    const original: SharedFile = {
      path: PATH,
      blobSha256: ORIGINAL_SHA,
      contentKind: "text",
    };

    expect(filesFromLog([
      snapshotOp(original),
      writeOp(2, ORIGINAL_SHA, FAST_FORWARD_SHA),
      writeOp(3, ORIGINAL_SHA, DIVERGENT_SHA),
      writeOp(4, FAST_FORWARD_SHA, LATER_FAST_FORWARD_SHA),
      deleteOp(5, ORIGINAL_SHA),
    ])).toEqual([{
      path: PATH,
      blobSha256: LATER_FAST_FORWARD_SHA,
      contentKind: "text",
    }]);
  });

  it("treats null-before writes as creates only when the path is absent", () => {
    const create: RelayOp = {
      relaySeq: 1,
      opKind: "moment.append",
      payload: {
        operation: "write",
        path: PATH,
        payloadBeforePath: null,
        payloadBeforeBlobSha256: null,
        payloadAfterPath: PATH,
        payloadAfterBlobSha256: FAST_FORWARD_SHA,
        payloadAfterContentKind: "text",
      },
      recordedAtMs: 1,
    };
    const overwriteWithoutLineage: RelayOp = {
      ...create,
      relaySeq: 2,
      payload: {
        ...create.payload as Record<string, unknown>,
        payloadAfterBlobSha256: DIVERGENT_SHA,
      },
      recordedAtMs: 2,
    };
    const files = new Map<string, SharedFile>();

    foldLogOps(files, [create]);
    foldLogOps(files, [overwriteWithoutLineage]);

    expect(filesFromAccumulator(files)).toEqual([{
      path: PATH,
      blobSha256: FAST_FORWARD_SHA,
      contentKind: "text",
    }]);
  });

  it("preserves a newer path occupant across a later fork snapshot chunk", () => {
    const files = new Map<string, SharedFile>();
    const create: RelayOp = {
      relaySeq: 2,
      opKind: "moment.append",
      payload: {
        operation: "write",
        path: PATH,
        payloadBeforePath: null,
        payloadBeforeBlobSha256: null,
        payloadAfterPath: PATH,
        payloadAfterBlobSha256: FAST_FORWARD_SHA,
        payloadAfterContentKind: "text",
      },
      recordedAtMs: 2,
    };
    const pendingSnapshot: SharedFile = {
      path: PATH,
      blobSha256: ORIGINAL_SHA,
      contentKind: "text",
    };

    foldLogOps(files, [snapshotOp({
      path: "first.txt",
      blobSha256: DIVERGENT_SHA,
      contentKind: "text",
    })]);
    foldLogOps(files, [create]);
    foldLogOps(files, [{ ...snapshotOp(pendingSnapshot), relaySeq: 3 }]);

    expect(filesFromAccumulator(files)).toEqual([
      {
        path: "first.txt",
        blobSha256: DIVERGENT_SHA,
        contentKind: "text",
      },
      {
        path: PATH,
        blobSha256: FAST_FORWARD_SHA,
        contentKind: "text",
      },
    ]);
  });

  it("applies the next write after a projected inward move left its target absent", () => {
    const arrivedPath = "docs/arrived.md";
    const files = new Map<string, SharedFile>();
    const writeAfterHiddenMove: RelayOp = {
      relaySeq: 2,
      opKind: "moment.append",
      payload: {
        operation: "write",
        payloadBeforePath: arrivedPath,
        payloadBeforeBlobSha256: PROJECTED_PREIMAGE_SHA,
        payloadAfterPath: arrivedPath,
        payloadAfterBlobSha256: ARRIVED_SHA,
        payloadAfterContentKind: "text",
      },
      recordedAtMs: 2,
    };

    foldLogOps(files, [writeAfterHiddenMove]);

    expect(filesFromAccumulator(files)).toEqual([{
      path: arrivedPath,
      blobSha256: ARRIVED_SHA,
      contentKind: "text",
    }]);
  });

  it("treats a rename from an unseen path as an arrival", () => {
    const arrivedPath = "docs/arrived.md";
    const files = new Map<string, SharedFile>();
    const renameIn: RelayOp = {
      relaySeq: 1,
      opKind: "moment.append",
      payload: {
        operation: "rename",
        payloadBeforePath: "private/hidden.md",
        payloadBeforeBlobSha256: PROJECTED_PREIMAGE_SHA,
        payloadAfterPath: arrivedPath,
        payloadAfterBlobSha256: ARRIVED_SHA,
        payloadAfterContentKind: "text",
      },
      recordedAtMs: 1,
    };

    foldLogOps(files, [renameIn]);

    expect(filesFromAccumulator(files)).toEqual([{
      path: arrivedPath,
      blobSha256: ARRIVED_SHA,
      contentKind: "text",
    }]);
  });
});

describe("public discussion projection", () => {
  const named = {
    messageId: "message-named",
    createdAtMs: 1_000,
    deleted: false as const,
    body: "Named body",
    author: { kind: "named" as const, displayName: "Named Person" },
  };
  const link = {
    messageId: "message-link",
    createdAtMs: 2_000,
    deleted: false as const,
    body: "Link body",
    author: {
      kind: "link" as const,
      displayName: "Link Person",
      unverified: true as const,
    },
  };
  const tombstone = {
    messageId: "message-deleted",
    createdAtMs: 3_000,
    deleted: true as const,
  };

  it("parses only the exact public page and append unions", () => {
    expect(parseDiscussionPage({
      ok: true,
      activityRevision: 7,
      messages: [named, link, tombstone],
      nextCursor: "cursor_1",
      profileName: null,
    })).toEqual({
      messages: [named, link, tombstone],
      nextCursor: "cursor_1",
      activityRevision: 7,
      profileName: null,
    });
    expect(parseDiscussionAppendResult({ ok: true, message: link })).toEqual(link);
  });

  it("validates newest-first pages and returns their loaded window chronologically", () => {
    expect(parseDiscussionPage({
      ok: true,
      activityRevision: 7,
      messages: [tombstone, link, named],
      nextCursor: "cursor_older",
      profileName: null,
    }, "newest-first")).toEqual({
      messages: [named, link, tombstone],
      nextCursor: "cursor_older",
      activityRevision: 7,
      profileName: null,
    });
    expect(parseDiscussionPage({
      ok: true,
      activityRevision: 7,
      messages: [named, link],
      nextCursor: null,
      profileName: null,
    }, "newest-first")).toBeNull();
  });

  it("parses only the committed name without accepting profile identifiers", () => {
    expect(parseDiscussionPage({
      ok: true,
      activityRevision: 7,
      messages: [],
      nextCursor: null,
      profileName: "Stable Name",
    })).toEqual({
      messages: [],
      nextCursor: null,
      activityRevision: 7,
      profileName: "Stable Name",
    });
    expect(parseDiscussionPage({
      ok: true,
      activityRevision: 7,
      messages: [],
      nextCursor: null,
      profileName: null,
    })).toEqual({
      messages: [],
      nextCursor: null,
      activityRevision: 7,
      profileName: null,
    });
    for (const internal of [
      { principalId: "principal-sentinel" },
      { profileTokenHash: "profile-sentinel" },
    ]) {
      expect(parseDiscussionPage({
        ok: true,
        activityRevision: 7,
        messages: [],
        nextCursor: null,
        profileName: "Stable Name",
        ...internal,
      })).toBeNull();
    }
  });

  it("accepts only a live link-authored append result", () => {
    expect(parseDiscussionAppendResult({ ok: true, message: link })).toEqual(link);
    expect(parseDiscussionAppendResult({ ok: true, message: named })).toBeNull();
    expect(parseDiscussionAppendResult({ ok: true, message: tombstone })).toBeNull();
  });

  it.each([
    ["a missing profile name", {
      ok: true,
      activityRevision: 7,
      messages: [],
      nextCursor: null,
    }],
    ["an empty profile name", {
      ok: true,
      activityRevision: 7,
      messages: [],
      nextCursor: null,
      profileName: "",
    }],
    ["an internal page field", {
      ok: true,
      activityRevision: 7,
      messages: [],
      nextCursor: null,
      profileName: null,
      shareId: "secret",
    }],
    ["an internal message field", {
      ok: true,
      activityRevision: 7,
      messages: [{ ...named, linkPrincipalId: "secret" }],
      nextCursor: null,
      profileName: null,
    }],
    ["a tombstone body", {
      ok: true,
      activityRevision: 7,
      messages: [{ ...tombstone, body: "deleted body" }],
      nextCursor: null,
      profileName: null,
    }],
    ["a tombstone author", {
      ok: true,
      activityRevision: 7,
      messages: [{ ...tombstone, author: named.author }],
      nextCursor: null,
      profileName: null,
    }],
    ["a live row without an exact author", {
      ok: true,
      activityRevision: 7,
      messages: [{ ...link, author: { ...link.author, unverified: false } }],
      nextCursor: null,
      profileName: null,
    }],
    ["an out-of-order page", {
      ok: true,
      activityRevision: 7,
      messages: [link, named],
      nextCursor: null,
      profileName: null,
    }],
    ["a malformed cursor", {
      ok: true,
      activityRevision: 7,
      messages: [],
      nextCursor: "cursor/value",
      profileName: null,
    }],
  ])("refuses %s", (_case, value) => {
    expect(parseDiscussionPage(value)).toBeNull();
  });

  it("merges exact repeats once and replaces a live row with its tombstone in place", () => {
    const deletedLink = {
      messageId: link.messageId,
      createdAtMs: link.createdAtMs,
      deleted: true as const,
    };
    expect(mergeDiscussionMessages([named, link], [link, tombstone])).toEqual([
      named,
      link,
      tombstone,
    ]);
    expect(mergeDiscussionMessages([named, link, tombstone], [deletedLink])).toEqual([
      named,
      deletedLink,
      tombstone,
    ]);
  });

  it("keeps an exact tombstone when its prior live representation arrives later", () => {
    const deletedLink = {
      messageId: link.messageId,
      createdAtMs: link.createdAtMs,
      deleted: true as const,
    };

    expect(mergeDiscussionMessages([deletedLink], [link])).toEqual([deletedLink]);
    expect(mergeDiscussionMessages([deletedLink], [{
      ...link,
      createdAtMs: link.createdAtMs + 1,
    }])).toBeNull();
  });

  it("refuses an unseen row with an earlier creation time", () => {
    const tail = {
      ...link,
      messageId: "message-a",
    };
    const earlierTime = {
      ...named,
      messageId: "message-older-time",
      createdAtMs: tail.createdAtMs - 1,
    };

    expect(mergeDiscussionMessages([tail], [earlierTime])).toBeNull();
  });

  it("uses relay keyset order for message ids with the same creation time", () => {
    const first = {
      ...named,
      messageId: "message-Z",
      createdAtMs: 4_000,
    };
    const second = {
      ...link,
      messageId: "message-a",
      createdAtMs: first.createdAtMs,
    };

    expect(parseDiscussionPage({
      ok: true,
      activityRevision: 7,
      messages: [first, second],
      nextCursor: null,
      profileName: null,
    })).toEqual({
      messages: [first, second],
      nextCursor: null,
      activityRevision: 7,
      profileName: null,
    });
    expect(mergeDiscussionMessages([first], [second])).toEqual([first, second]);
  });

  it("inserts an unseen same-millisecond message into canonical keyset order", () => {
    const earlierId = {
      ...named,
      messageId: "message-a",
      createdAtMs: 4_000,
    };
    const laterId = {
      ...link,
      messageId: "message-b",
      createdAtMs: earlierId.createdAtMs,
    };

    expect(mergeDiscussionMessages([laterId], [earlierId, laterId])).toEqual([
      earlierId,
      laterId,
    ]);
    expect(mergeDiscussionMessages([laterId], [
      earlierId,
      { ...laterId, body: "conflicting body" },
    ])).toBeNull();
  });

  it("ignores unseen activity before a loaded window without hiding conflicts", () => {
    const olderUnseen = {
      ...named,
      messageId: "message-before-window",
      createdAtMs: link.createdAtMs - 1,
    };
    const newerUnseen = {
      ...named,
      messageId: "message-after-window",
      createdAtMs: link.createdAtMs + 1,
    };

    expect(mergeDiscussionWindowMessages([link], [olderUnseen, newerUnseen]))
      .toEqual([link, newerUnseen]);
    expect(mergeDiscussionWindowMessages([link], [{ ...link, body: "conflict" }]))
      .toBeNull();
  });

  it("refuses every conflicting message-id reuse", () => {
    expect(mergeDiscussionMessages([link], [{ ...link, body: "forged" }])).toBeNull();
    expect(mergeDiscussionMessages([tombstone], [{ ...tombstone, createdAtMs: 4_000 }]))
      .toBeNull();
  });

  it("parses only an exact, ordered public discussion activity delta", () => {
    expect(parseDiscussionActivity({
      ok: true,
      latestRevision: 9,
      cursorRevision: 8,
      hasMore: true,
      messages: [named, link],
      composerState: "blocked",
    })).toEqual({
      latestRevision: 9,
      cursorRevision: 8,
      hasMore: true,
      messages: [named, link],
      composerState: "blocked",
    });

    for (const value of [
      {
        ok: true,
        latestRevision: 9,
        cursorRevision: 8,
        hasMore: true,
        messages: [named, link],
        composerState: "available",
        grantId: "internal",
      },
      {
        ok: true,
        latestRevision: 8,
        cursorRevision: 9,
        hasMore: true,
        messages: [],
        composerState: "available",
      },
      {
        ok: true,
        latestRevision: 9,
        cursorRevision: 8,
        hasMore: "yes",
        messages: [],
        composerState: "available",
      },
      {
        ok: true,
        latestRevision: 9,
        cursorRevision: 9,
        hasMore: false,
        messages: [link, named],
        composerState: "available",
      },
      {
        ok: true,
        latestRevision: 9,
        cursorRevision: 9,
        hasMore: false,
        messages: [],
        composerState: "disabled",
      },
    ]) {
      expect(parseDiscussionActivity(value)).toBeNull();
    }
  });
});
