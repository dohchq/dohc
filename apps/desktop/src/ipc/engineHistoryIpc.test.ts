import { describe, expect, it, vi } from "vitest";
import {
  engineMomentDetailForIpc,
  listEngineMomentsForIpc,
  versionConflictForIpc,
  type EngineMomentAuthorNames,
} from "./engineHistoryIpc";
import {
  CompareWorkspaceVersionsResult,
  EngineMomentDetailRecord,
  ENGINE_TEXT_MAX_CHARS,
  ListWorkspaceVersionConflictsResult,
  WorkspaceVersionConflict,
} from "./bridgeContract";
import { compareVersionFilesPage } from "@dohc/workspace-core/versionCompare";
import type {
  TextFileSnapshot,
  VersionedTextMoment,
} from "@dohc/workspace-contracts/engine";
import type { WorkspaceEngineMomentDetail } from "../workspaces/workspaceEngineCapture";
import { DaemonRefusalError } from "@dohc/workspace-engine-client";

const names: EngineMomentAuthorNames = {
  agent: (author) => author.onBehalfOf === "local" ? "You" : author.onBehalfOf,
  automation: (automationId) =>
    automationId.startsWith("collection:") ? { name: `Named ${automationId}`, collection: "Tasks" } : null,
  named: (author) => `${author.userId}@example.com (Edit)`,
};

const TEXT_SHA = "a".repeat(64);
const BINARY_SHA = "b".repeat(64);

describe("listEngineMomentsForIpc", () => {
  it.each([
    "History is still updating. Try again.",
    "Workspace is still updating. Try again.",
  ])("preserves the %s refusal as a structured IPC result", async (message) => {
    const updating = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message,
        retry: "afterBackoff",
      },
      null,
    );
    const read = vi.fn(() => Promise.reject(updating));

    await expect(listEngineMomentsForIpc(read, names)).resolves.toEqual({
      status: "updating",
    });
  });

  it("does not reclassify an unknown daemon failure", async () => {
    const unknown = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "The engine is overloaded.",
        retry: "afterBackoff",
      },
      null,
    );

    await expect(
      listEngineMomentsForIpc(() => Promise.reject(unknown), names),
    ).rejects.toBe(unknown);
  });
});

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
  it("omits an agent owner label when its principal was not declared", () => {
    const detail = detailWith({before: null, after: textSide("new")});
    if (detail.protected) throw new Error("Expected a plaintext moment");
    detail.moment.authors = [{kind: "agent", agentId: "agent"}];
    const record = engineMomentDetailForIpc(detail, names);
    expect(record).not.toHaveProperty("agentAuthorName");
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
  });
  it("names no single author for a moment with several", () => {
    const detail = detailWith({before: null, after: textSide("new")});
    if (detail.protected) throw new Error("Expected a plaintext moment");
    detail.moment.authors = [
      {kind: "agent", agentId: "agent", onBehalfOf: "local"},
      {kind: "human", humanId: "ada"},
    ];
    const agentNamer = vi.fn(names.agent);
    const record = engineMomentDetailForIpc(detail, { ...names, agent: agentNamer });
    expect(record).not.toHaveProperty("agentAuthorName");
    expect(agentNamer).not.toHaveBeenCalled();
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
  });
  it("preserves the public author without invoking the agent name resolver", () => {
    const detail = detailWith({before: textSide("old"), after: textSide("new")});
    if (detail.protected) throw new Error("Expected a plaintext moment");
    const author = {kind: "public", principalId: "holder-2", grantId: "grant-1"} as const;
    detail.moment.authors = [author];
    const agentNamer = vi.fn(names.agent);
    const record = engineMomentDetailForIpc(detail, { ...names, agent: agentNamer });
    expect(record.publicAuthor).toEqual(author);
    expect(record.agentAuthorName).toBeUndefined();
    expect(agentNamer).not.toHaveBeenCalled();
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
  });
  it("names an automation author as main reads it, and nothing else", () => {
    const detail = detailWith({before: null, after: textSide("new")});
    if (detail.protected) throw new Error("Expected a plaintext moment");
    detail.moment.authors = [{kind: "automation", automationId: "collection:Tasks#stamp", depth: 1}];
    const record = engineMomentDetailForIpc(detail, names);
    expect(record.automationAuthor).toEqual({ name: "Named collection:Tasks#stamp", collection: "Tasks" });
    expect(record.agentAuthorName).toBeUndefined();
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
    // An id outside the Collection namespace keeps the moment's origin label.
    detail.moment.authors = [{kind: "automation", automationId: "other:tools/stamp", onBehalfOf: "local", depth: 1}];
    expect(engineMomentDetailForIpc(detail, names)).not.toHaveProperty("automationAuthor");
  });
  it("names a person the owner shared with as main reads them from the roster", () => {
    const detail = detailWith({before: textSide("old"), after: textSide("new")});
    if (detail.protected) throw new Error("Expected a plaintext moment");
    detail.moment.authors = [{kind: "named", userId: "ana", grantId: "grant-1", grantGeneration: 1}];
    const record = engineMomentDetailForIpc(detail, names);
    expect(record.namedAuthor).toEqual({ userId: "ana", label: "ana@example.com (Edit)" });
    expect(record.agentAuthorName).toBeUndefined();
    expect(record.publicAuthor).toBeUndefined();
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
  });
  it("carries an Edit link's grant and principal, and names no person for it", () => {
    const detail = detailWith({before: textSide("old"), after: textSide("new")});
    if (detail.protected) throw new Error("Expected a plaintext moment");
    const author = {kind: "link", grantId: "grant-1", grantGeneration: 2, principalId: "holder-1"} as const;
    detail.moment.author = author;
    const record = engineMomentDetailForIpc(detail, names);
    expect(record.linkAuthor).toEqual(author);
    expect(record.namedAuthor).toBeUndefined();
    expect(record.publicAuthor).toBeUndefined();
    expect(record.agentAuthorName).toBeUndefined();
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
    expect(() => EngineMomentDetailRecord.parse({...record, linkAuthor: {...author, userId: "ana"}})).toThrow();
  });
  it("keeps the plain text moment shape (no binary side fields)", () => {
    const record = engineMomentDetailForIpc(
      detailWith({ before: textSide("v1\n"), after: textSide("v2\n") }),
      names,
    );
    expect(record.beforeText).toBe("v1\n");
    expect(record.afterText).toBe("v2\n");
    expect(record.contentKind).toBeUndefined();
    expect(record.beforeBinary).toBeUndefined();
    expect(record.afterBinary).toBeUndefined();
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
  });

  it("presents a binary->text transition honestly per side", () => {
    // The binary preimage must never surface as beforeText "" (a false
    // empty->text diff); it presents as bytes instead.
    const record = engineMomentDetailForIpc(
      detailWith({ before: binarySide(4), after: textSide("text again\n") }),
      names,
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
      names,
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
      names,
    );
    expect(record.beforeText).toBeNull();
    expect(record.beforeBinary).toBeUndefined();
    expect(record.afterBinary).toEqual({ byteLength: 6, sha256: BINARY_SHA });
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
  });

  it("serves a binary delete moment as bytes on both populated sides", () => {
    const record = engineMomentDetailForIpc(
      detailWith({ before: binarySide(4), after: binarySide(4) }, "delete"),
      names,
    );
    expect(record.beforeText).toBeNull();
    expect(record.afterText).toBeNull();
    expect(record.beforeBinary).toEqual({ byteLength: 4, sha256: BINARY_SHA });
    expect(record.afterBinary).toEqual({ byteLength: 4, sha256: BINARY_SHA });
    expect(record.contentKind).toBe("binary");
    expect(EngineMomentDetailRecord.parse(record)).toEqual(record);
  });
});

// The bridge schema is the last gate a hydrated body passes: main runs
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
      names,
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
      names,
    );
    expect(EngineMomentDetailRecord.parse(record).afterText).toBe(body);
  });

  it("names the constraint, limit, unit, and observed size when a body is over", () => {
    // Over the engine's own contract, so no stored body reaches here — but a
    // reader who hits it gets the limit, not a bare Zod string complaint.
    const record = engineMomentDetailForIpc(
      detailWith({ before: null, after: textSide("x".repeat(ENGINE_TEXT_MAX_CHARS + 1)) }),
      names,
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
  // compareVersionFilesPage reads the differing-path listing and then the
  // sides of each listed path, so one modified path is the whole input the
  // compare rows come from.
  function storeWithTextFile(textByVersionId: Record<string, string>) {
    return {
      compareVersionFilesPage: async () => ({
        entries: [{ path: "notes.md", status: "modified" as const }],
        nextAfterPath: null,
      }),
      readTextFile: async ({
        versionId,
      }: {
        versionId: string;
      }): Promise<TextFileSnapshot | null> => ({
        objectId: "object_1",
        versionId,
        path: "notes.md",
        text: textByVersionId[versionId] ?? "",
        updatedAtMs: 100,
        latestMomentId: `moment_${versionId}`,
        metadata: { origin: "local-file" },
      }),
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
    const listed = ListWorkspaceVersionConflictsResult.parse({
      conflicts: [conflict],
      nextAfterConflictId: null,
    });
    expect(listed.conflicts[0]!.currentText).toBe(side);
    expect(listed.conflicts[0]!.conflictId).toBe("conflict_big");
  });

  it("compares a file whose sides are larger than the old 2 MB bound", async () => {
    // main.ts compareWorkspaceVersions parses exactly what
    // compareVersionFilesPage returned, so this is the compare channel's real
    // pairing. One over-budget row still ships whole: the page budget cuts
    // after the row that crossed it, never inside a row.
    const currentText = "x".repeat(3 * 1024 * 1024);
    const incomingText = `${currentText}tail`;
    const page = await compareVersionFilesPage(
      storeWithTextFile({ main: currentText, version_feature: incomingText }),
      {
        workspaceId: "ws-engine",
        sourceVersionId: "version_feature",
        targetVersionId: "main",
      },
    );
    const compared = CompareWorkspaceVersionsResult.parse(page);
    expect(compared.files[0]!.currentText).toBe(currentText);
    expect(compared.files[0]!.incomingText).toBe(incomingText);
    expect(compared.nextAfterPath).toBeNull();
  });

  it("admits a conflict side at the engine's own text contract", () => {
    // Stated absolutely, not as ENGINE_TEXT_MAX_CHARS: the bound the bridge
    // owes is the engine's MAX_TEXT_BYTES
    // (`crates/dohc-engine-domain/src/store.rs`), so lowering the bridge
    // constant must fail this, never move it.
    //
    // A SCHEMA claim only. A side this large does not reach main today: the
    // wire caps one string at 8 MiB and the conflict page refuses above its
    // row cap. The bridge still owes the storage contract, so that it
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
