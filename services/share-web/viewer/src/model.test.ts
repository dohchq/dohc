import { describe, expect, it } from "vitest";
import {
  filesFromAccumulator,
  filesFromLog,
  foldLogOps,
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
