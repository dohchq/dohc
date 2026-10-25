import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EngineYdocProviderSessionOptions } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { createWorkspaceEngineCapture, isYDocPathNotInVersionError, YDocUncapturedArtifactError } from "./workspaceEngineCapture";
import { engineSaveState } from "./engineYDocSaveState";
import { createTestScratch } from "./testTemp";

it.each(["clean", "outside", "unchecked"])("publishes only checked save states on open and lineage replacement (%s)", async mode => {
  const rootPath = await createTestScratch("dohc-save-state-");
  const workspaceId = "save-state-test";
  const text = "checked text\n";
  const sha256 = createHash("sha256").update(text).digest("hex");
  await writeFile(join(rootPath, "note.md"), mode === "outside" ? "outside edit" : text);
  const loopback = new VersionedLoopbackEngine();
  if (mode !== "unchecked") loopback.seedTextFile({ workspace: workspaceId, versionId: "main", path: "note.md", text });
  let replace!: () => void;
  const settle = vi.fn();
  const capture = createWorkspaceEngineCapture({
    rootPath, workspaceId, attachmentId: Symbol("save-state"),
    rustEngineSessions: mockLiveSessions(loopback),
    openRustYDocProviderSession: async (options: EngineYdocProviderSessionOptions) => {
      const doc = new Y.Doc();
      replace = () => options.onLineageReplaced?.(new Y.Doc(), []);
      return {
        doc, initialUpdate: Y.encodeStateAsUpdate(doc), path: options.path,
        contentKind: "plaintext", head: "present", lineage: "existing", canSkipSettle: false, unsettled: false,
        applyLocalUpdate: async () => undefined, evict: async () => undefined,
        close: async () => undefined,
        settleNow: async () => {
          settle();
          options.onSettleStart?.(1);
          const result = { sha256, content: text, materialized: true, momentId: "settle", path: options.path,
            projection: { contentKind: "plaintext" as const, sourceStateVectorSha256: "a".repeat(64), destructive: false } };
          await options.onSettled?.(result, 1);
          return result;
        },
      };
    },
  });
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: "note.md", onRemoteUpdate: () => undefined,
    onSaveState: state => states.push(engineSaveState(state).state.kind),
    onLineageReplaced: () => states.push("replacement"),
  });
  try {
    expect(states).toEqual(mode === "clean" ? ["saved-here"] : mode === "outside" ? ["error"] : []);
    expect(settle).not.toHaveBeenCalled();
    await writeFile(join(rootPath, "note.md"), text);
    replace();
    await vi.waitFor(() => expect(states.at(-1)).toBe("saved-here"));
    expect(states).toContain("replacement");
    expect(settle).toHaveBeenCalledTimes(1);
  } finally {
    await session.close({ settle: false });
    await capture.stop();
  }
});


it.each(["empty", "nonempty", "missing", "update"])("checks a fresh absent-head document before reporting Saved (%s)", async mode => {
  const rootPath = await createTestScratch("dohc-new-file-save-state-");
  const workspaceId = "new-file-save-state-test";
  if (mode !== "missing") await writeFile(join(rootPath, "new.md"), mode === "nonempty" ? "not captured yet" : "");
  const settle = vi.fn();
  const capture = createWorkspaceEngineCapture({
    rootPath, workspaceId, attachmentId: Symbol("new-file-save-state"),
    rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine()),
    openRustYDocProviderSession: async options => {
      const doc = new Y.Doc();
      if (mode === "update") {
        doc.getText("content").insert(0, "peer update");
        options.onRemoteUpdate(Y.encodeStateAsUpdate(doc));
      }
      return {
        doc, initialUpdate: Y.encodeStateAsUpdate(doc), path: options.path,
        contentKind: "plaintext", head: "absent", lineage: "absent", canSkipSettle: false, unsettled: mode === "update",
        applyLocalUpdate: async () => undefined, evict: async () => undefined,
        close: async () => undefined,
        settleNow: async () => {
          settle();
          return { sha256: createHash("sha256").update("").digest("hex"), content: "", materialized: true,
            momentId: "settle", path: options.path,
            projection: { contentKind: "plaintext" as const, sourceStateVectorSha256: "a".repeat(64), destructive: false } };
        },
      };
    },
  });
  const states: string[] = [];
  try {
    const opening = capture.openYDocSession({ path: "new.md", onRemoteUpdate: () => undefined,
      onSaveState: state => states.push(state) });
    if (mode === "nonempty") {
      await expect(opening).rejects.toBeInstanceOf(YDocUncapturedArtifactError);
    } else if (mode === "missing") {
      await expect(opening).rejects.toSatisfy(isYDocPathNotInVersionError);
    } else {
      const session = await opening;
      expect(states).toEqual(mode === "empty" ? ["saved"] : []);
      await session.close({ settle: false });
    }
    expect(states).toEqual(mode === "empty" ? ["saved"] : []);
    expect(settle).not.toHaveBeenCalled();
  } finally {
    await capture.stop();
  }
});
