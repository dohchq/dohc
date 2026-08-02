import { describe, expect, it } from "vitest";
import {
  engineMomentDetailForIpc,
  versionConflictForIpc,
  type EngineMomentAuthorNamer,
} from "./engineHistoryIpc";
import {
  CompareWorkspaceVersionsResult,
  EngineMomentDetailRecord,
  ENGINE_TEXT_MAX_CHARS,
  ListWorkspaceVersionConflictsResult,
  WorkspaceVersionConflict,
} from "./bridgeContract";
import { compareVersionFiles } from "@dohc/workspace-core/versionCompare";
import type {
  TextFileSnapshot,
  VersionedTextMoment,
} from "@dohc/workspace-contracts/engine";
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

// The bridge schema is the LAST gate a hydrated body passes: main runs
// `ReadEngineMomentResult.parse` on exactly what `engineMomentDetailForIpc`
// produced (main.ts readEngineMoment handler), so these two calls are the
// real pairing, not a stand-in.
describe("moment bodies the engine accepted cross the bridge", () => {
  it("carries a body larger than the old 2 MB bound", () => {
    // One character past the retired 2,000,000 bound, and well inside the
    // engine's 10 MiB text contract: this body is ordinary stored content.
    const body = "x".repeat(2_000_001);
    const record = engineMomentDetailForIpc(
      detailWith({ before: textSide("v1\n"), after: textSide(body) }),
      namer,
    );
    expect(EngineMomentDetailRecord.parse(record).afterText).toBe(body);
  });

  it("carries a body at the engine's own text contract", () => {
    // Stated absolutely, not as ENGINE_TEXT_MAX_CHARS: the bound the bridge
    // owes is the engine's MAX_TEXT_BYTES
    // (`crates/dohc-engine-domain/src/store.rs`), so lowering the bridge
    // constant must fail this, never move it.
    const engineMaxTextBytes = 10 * 1024 * 1024;
    expect(ENGINE_TEXT_MAX_CHARS).toBe(engineMaxTextBytes);
    const body = "x".repeat(engineMaxTextBytes);
    const record = engineMomentDetailForIpc(
      detailWith({ before: null, after: textSide(body) }),
      namer,
    );
    expect(EngineMomentDetailRecord.parse(record).afterText).toBe(body);
  });

  it("names the constraint, limit, unit, and observed size when a body is over", () => {
    // Over the engine's own contract, so no stored body reaches here — but a
    // reader who hits it gets the limit, not a bare Zod string complaint.
    const record = engineMomentDetailForIpc(
      detailWith({ before: null, after: textSide("x".repeat(ENGINE_TEXT_MAX_CHARS + 1)) }),
      namer,
    );
    const parsed = EngineMomentDetailRecord.safeParse(record);
    expect(parsed.success).toBe(false);
    const message = parsed.success ? "" : parsed.error.issues[0]!.message;
    expect(message).toContain(String(ENGINE_TEXT_MAX_CHARS + 1));
    expect(message).toContain(String(ENGINE_TEXT_MAX_CHARS));
    expect(message).toContain("characters");
    expect(message).toContain("moment body");
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

  it("renders both texts when only the base was binary", () => {
    // WS-G1 opens a conflict for any path a binary head touches, including one
    // whose bytes are only in the fork base. Both live sides are text and the
    // user can read and combine them.
    const conflict = versionConflictForIpc({
      ...base,
      path: "notes.md",
      current: { exists: true, text: "main side" },
      incoming: { exists: true, text: "feature side" },
      base: { exists: true, contentKind: "binary", sha256: BINARY_SHA, byteLength: 5 },
    });
    expect(conflict.contentKind).toBe("text");
    expect(conflict.currentText).toBe("main side");
    expect(conflict.incomingText).toBe("feature side");
    expect(WorkspaceVersionConflict.parse(conflict)).toEqual(conflict);
  });
});

// Same LAST-gate pairing as the moment bodies above: main runs
// `ListWorkspaceVersionConflictsResult.parse` on exactly what
// `versionConflictForIpc` produced (main.ts listWorkspaceVersionConflicts
// handler), and conflict sides are the engine's stored bodies passed verbatim.
describe("version texts the engine accepted cross the bridge", () => {
  // compareVersionFiles reads snapshot listings and nothing else, so one path
  // per version is the whole input the compare rows come from.
  function storeWithTextFile(textByVersionId: Record<string, string>) {
    return {
      listTextFiles: async ({
        versionId,
      }: {
        versionId: string;
      }): Promise<TextFileSnapshot[]> => [
        {
          objectId: "object_1",
          versionId,
          path: "notes.md",
          text: textByVersionId[versionId] ?? "",
          updatedAtMs: 100,
          latestMomentId: `moment_${versionId}`,
          metadata: { origin: "local-file" },
        },
      ],
    };
  }

  const base = {
    id: "conflict_big",
    path: "notes.md",
    sourceVersionId: "version_feature",
    targetVersionId: "main",
  };

  it("lists a conflict whose side is larger than the old 2 MB bound", () => {
    // The unrecoverable case from the issue: resolving needs a conflictId that
    // only this listing supplies, so a rejected listing left the user stuck.
    //
    // 3 MiB on purpose. The daemon serializes all three sides in band and
    // refuses the page above 8 MiB minus envelope headroom
    // (`lib.rs:244-248,7482-7491`), so a row this size does reach main, and
    // this schema was the only gate rejecting it. #537 covers the band above
    // that cap, where the daemon still refuses and no hydration path exists.
    const side = "x".repeat(3 * 1024 * 1024);
    const conflict = versionConflictForIpc({
      ...base,
      current: { exists: true, text: side },
      incoming: { exists: true, text: "feature side" },
      base: { exists: false },
    });
    const listed = ListWorkspaceVersionConflictsResult.parse({ conflicts: [conflict] });
    expect(listed.conflicts[0]!.currentText).toBe(side);
    expect(listed.conflicts[0]!.conflictId).toBe("conflict_big");
  });

  it("compares a file whose sides are larger than the old 2 MB bound", async () => {
    // main.ts compareWorkspaceVersions parses exactly what compareVersionFiles
    // returned, so this is the compare channel's real pairing.
    const currentText = "x".repeat(3 * 1024 * 1024);
    const incomingText = `${currentText}tail`;
    const files = await compareVersionFiles(
      storeWithTextFile({ main: currentText, version_feature: incomingText }),
      {
        workspaceId: "ws-engine",
        sourceVersionId: "version_feature",
        targetVersionId: "main",
      },
    );
    const compared = CompareWorkspaceVersionsResult.parse({ files });
    expect(compared.files[0]!.currentText).toBe(currentText);
    expect(compared.files[0]!.incomingText).toBe(incomingText);
  });

  it("admits a conflict side at the engine's own text contract", () => {
    // Stated absolutely, not as ENGINE_TEXT_MAX_CHARS: the bound the bridge
    // owes is the engine's MAX_TEXT_BYTES
    // (`crates/dohc-engine-domain/src/store.rs`), so lowering the bridge
    // constant must fail this, never move it.
    //
    // A SCHEMA claim only. A side this large does not reach main today: the
    // wire caps one string at 8 MiB and the conflict page refuses above its
    // row cap (#537). The bridge still owes the storage contract, so that it
    // needs no edit when the hydration path lands.
    const engineMaxTextBytes = 10 * 1024 * 1024;
    expect(ENGINE_TEXT_MAX_CHARS).toBe(engineMaxTextBytes);
    const side = "x".repeat(engineMaxTextBytes);
    const conflict = versionConflictForIpc({
      ...base,
      current: { exists: true, text: side },
      incoming: { exists: false },
      base: { exists: false },
    });
    expect(WorkspaceVersionConflict.parse(conflict).currentText).toBe(side);
  });

  it("names the constraint, limit, unit, and observed size when a side is over", () => {
    // Over the engine's own contract, so no stored side reaches here — but a
    // reader who hits it gets the limit, not a bare Zod string complaint.
    const conflict = versionConflictForIpc({
      ...base,
      current: { exists: true, text: "x".repeat(ENGINE_TEXT_MAX_CHARS + 1) },
      incoming: { exists: false },
      base: { exists: false },
    });
    const parsed = WorkspaceVersionConflict.safeParse(conflict);
    expect(parsed.success).toBe(false);
    const message = parsed.success ? "" : parsed.error.issues[0]!.message;
    expect(message).toContain(String(ENGINE_TEXT_MAX_CHARS + 1));
    expect(message).toContain(String(ENGINE_TEXT_MAX_CHARS));
    expect(message).toContain("characters");
    expect(message).toContain("version text");
  });
});
