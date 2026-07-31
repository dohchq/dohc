import { describe, expect, it } from "vitest";
import {
  engineMomentDetailForIpc,
  versionConflictForIpc,
  type EngineMomentAuthorNamer,
} from "./engineHistoryIpc";
import { EngineMomentDetailRecord, WorkspaceVersionConflict } from "./bridgeContract";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import type { WorkspaceEngineMomentDetail } from "../workspaces/workspaceEngineCapture";

const namer: EngineMomentAuthorNamer = (author) =>
  author.onBehalfOf === "local" ? "You" : author.onBehalfOf;

const TEXT_SHA = "a".repeat(64);
const BINARY_SHA = "b".repeat(64);

function textSide(text: string) {
  return {
    path: "data.md",
    contentKind: "text" as const,
    sha256: TEXT_SHA,
    byteLength: Buffer.byteLength(text, "utf8"),
    text,
  };
}

function binarySide(byteLength = 4) {
  return {
    path: "data.md",
    contentKind: "binary" as const,
    sha256: BINARY_SHA,
    byteLength,
    // Binary payload sides never carry text — the store serves "".
    text: "",
  };
}

function detailWith(
  payload: VersionedTextMoment["payload"],
  operation: "write" | "rename" | "delete" = "write",
): WorkspaceEngineMomentDetail {
  return {
    protected: false,
    moment: {
      id: "moment_1",
      workspaceId: "ws-engine",
      versionId: "main",
      objectId: "object_1",
      path: "data.md",
      recordedAtMs: 100,
      operation,
      payload,
      metadata: { origin: "local-file" },
    },
  };
}

describe("engineMomentDetailForIpc per-side content kinds", () => {
  it("keeps the plain text moment shape (no binary side fields)", () => {
    const record = engineMomentDetailForIpc(
      detailWith({ before: textSide("v1\n"), after: textSide("v2\n") }),
      namer,
    );
    expect(record.beforeText).toBe("v1\n");
    expect(record.afterText).toBe("v2\n");
    expect(record.contentKind).toBeUndefined();
    expect(record.beforeBinary).toBeUndefined();
    expect(record.afterBinary).toBeUndefined();
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
  });

  it("presents a binary->text transition honestly per side", () => {
    // The binary preimage must NEVER surface as beforeText "" (a false
    // empty->text diff); it presents as bytes instead.
    const record = engineMomentDetailForIpc(
      detailWith({ before: binarySide(4), after: textSide("text again\n") }),
      namer,
    );
    expect(record.beforeText).toBeNull();
    expect(record.beforeBinary).toEqual({ byteLength: 4, sha256: BINARY_SHA });
    expect(record.afterText).toBe("text again\n");
    expect(record.afterBinary).toBeUndefined();
    // The record-level kind mirrors the timeline row: keyed on the after
    // side, so this moment is a text moment with a binary preimage.
    expect(record.contentKind).toBeUndefined();
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
  });

  it("presents a text->binary transition honestly per side", () => {
    const record = engineMomentDetailForIpc(
      detailWith({ before: textSide("text at first\n"), after: binarySide(4) }),
      namer,
    );
    expect(record.beforeText).toBe("text at first\n");
    expect(record.beforeBinary).toBeUndefined();
    expect(record.afterText).toBeNull();
    expect(record.afterBinary).toEqual({ byteLength: 4, sha256: BINARY_SHA });
    expect(record.contentKind).toBe("binary");
    expect(record.byteLength).toBe(4);
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
  });

  it("distinguishes a binary create (no before) from a transition", () => {
    const record = engineMomentDetailForIpc(
      detailWith({ before: null, after: binarySide(6) }),
      namer,
    );
    expect(record.beforeText).toBeNull();
    expect(record.beforeBinary).toBeUndefined();
    expect(record.afterBinary).toEqual({ byteLength: 6, sha256: BINARY_SHA });
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
  });

  it("serves a binary delete moment as bytes on both populated sides", () => {
    const record = engineMomentDetailForIpc(
      detailWith({ before: binarySide(4), after: binarySide(4) }, "delete"),
      namer,
    );
    expect(record.beforeText).toBeNull();
    expect(record.afterText).toBeNull();
    expect(record.beforeBinary).toEqual({ byteLength: 4, sha256: BINARY_SHA });
    expect(record.afterBinary).toEqual({ byteLength: 4, sha256: BINARY_SHA });
    expect(record.contentKind).toBe("binary");
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
  });
});

describe("versionConflictForIpc binary sides", () => {
  const base = {
    id: "conflict_1",
    path: "logo.png",
    sourceVersionId: "version_feature",
    targetVersionId: "main",
  };

  it("serializes hash-backed binary sides", () => {
    const conflict = versionConflictForIpc({
      ...base,
      current: { exists: true, contentKind: "binary", sha256: BINARY_SHA, byteLength: 5 },
      incoming: { exists: true, contentKind: "binary", sha256: TEXT_SHA, byteLength: 7 },
      base: { exists: false },
    });
    expect(conflict.contentKind).toBe("binary");
    expect(conflict.currentBinary).toEqual({ sha256: BINARY_SHA, byteLength: 5 });
    expect(conflict.incomingBinary).toEqual({ sha256: TEXT_SHA, byteLength: 7 });
    expect(conflict.baseBinary).toBeNull();
    expect(WorkspaceVersionConflict.parse(conflict)).toEqual(conflict);
  });

  it("serializes a hashless existing side as null and still passes the wire schema", () => {
    // sha256: "" would fail WorkspaceVersionConflict validation and turn a
    // mixed binary/text conflict into an IPC error — a side without a real
    // content hash presents as null instead.
    const conflict = versionConflictForIpc({
      ...base,
      current: { exists: true, contentKind: "binary", sha256: BINARY_SHA, byteLength: 5 },
      incoming: { exists: true, text: "textual side\n" },
      base: { exists: true, byteLength: 3 },
    });
    expect(conflict.contentKind).toBe("binary");
    expect(conflict.currentBinary).toEqual({ sha256: BINARY_SHA, byteLength: 5 });
    expect(conflict.incomingBinary).toBeNull();
    expect(conflict.baseBinary).toBeNull();
    expect(WorkspaceVersionConflict.parse(conflict)).toEqual(conflict);
  });
});
