import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DaemonRefusalError, type EngineYdocProviderSessionOptions } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { createWorkspaceEngineCapture, isYDocPathNotInVersionError, YDocUncapturedArtifactError } from "./workspaceEngineCapture";
import { engineSaveState } from "./engineYDocSaveState";
import { flushTypingCheckpoints, readTypingCheckpoints, retireTypingCheckpoint, typingRecoveryStateVectorSha256, writeTypingCheckpoint, type OutageTypingCheckpoint } from "./outageTypingRecovery";
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
        contentKind: "plaintext", head: "present", lineage: "existing", unsettled: false,
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
        contentKind: "plaintext", head: "absent", lineage: "absent", unsettled: mode === "update",
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

it("keeps typing a busy store refused in a typing checkpoint, retired once the engine records all of it", async () => {
  const rootPath = await createTestScratch("dohc-busy-typing-");
  const workspaceId = "busy-typing-test";
  const directory = join(rootPath, "recovery");
  await writeFile(join(rootPath, "note.md"), "");
  const loopback = new VersionedLoopbackEngine();
  loopback.seedTextFile({ workspace: workspaceId, versionId: "main", path: "note.md", text: "" });
  const busy = () => new DaemonRefusalError({ code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff" }, new Error("daemon response"));
  // The provider keeps each edit the busy store refused and resends it itself.
  const refused: string[] = [];
  let recorded!: (id: string) => void;
  const retire = vi.fn(async (checkpoint: OutageTypingCheckpoint) => {
    for (const row of await readTypingCheckpoints(directory, workspaceId)) {
      if (row.content === JSON.stringify(checkpoint)) await retireTypingCheckpoint(row);
    }
  });
  const capture = createWorkspaceEngineCapture({
    rootPath, workspaceId, attachmentId: Symbol("busy-typing"),
    rustEngineSessions: mockLiveSessions(loopback), onError: () => undefined,
    writeTypingCheckpoint: checkpoint => writeTypingCheckpoint(directory, checkpoint),
    retireTypingCheckpoint: retire,
    openRustYDocProviderSession: async (options: EngineYdocProviderSessionOptions) => {
      const doc = new Y.Doc();
      recorded = id => options.onLocalUpdateAcknowledged?.(id, "journal");
      return {
        doc, initialUpdate: Y.encodeStateAsUpdate(doc), path: options.path, objectId: "object", versionId: "main",
        contentKind: "plaintext", head: "present", lineage: "existing", unsettled: false,
        applyLocalUpdate: async (_update, applyOptions) => { refused.push(applyOptions!.idempotencyKey!); throw busy(); },
        evict: async () => undefined, close: async () => undefined,
        settleNow: async () => { throw busy(); },
      };
    },
  });
  const session = await capture.openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined });
  const renderer = new Y.Doc();
  Y.applyUpdate(renderer, session.initialUpdate);
  const type = (text: string) => {
    const before = Y.encodeStateVector(renderer);
    const body = renderer.getText("plainText");
    body.insert(body.length, text);
    session.applyLocalUpdate(Y.encodeStateAsUpdate(renderer, before));
  };
  const saved = async () => (await readTypingCheckpoints(directory, workspaceId)).map(row => row.checkpoint);
  try {
    type("BUSY");
    await vi.waitFor(async () => expect((await saved())[0]?.text).toBe("BUSY"));
    type(" MORE");
    await vi.waitFor(() => expect(refused).toHaveLength(2));
    await flushTypingCheckpoints(workspaceId);
    const [checkpoint] = await saved();
    expect(checkpoint!.updates.map(update => update.requestId)).toEqual(refused);
    // After a crash, recovery replays these edits over the admitted base the
    // engine checks, or keeps the text when the file changed since.
    expect(checkpoint!.text).toBe("BUSY MORE");
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, Buffer.from(checkpoint!.admittedBaseBase64, "base64"));
    expect(typingRecoveryStateVectorSha256(Y.encodeStateVector(recovered))).toBe(checkpoint!.expectedStateVectorSha256);
    for (const update of checkpoint!.updates) Y.applyUpdate(recovered, Buffer.from(update.updateBase64, "base64"));
    expect(recovered.getText("plainText").toString()).toBe("BUSY MORE");
    recovered.destroy();

    // The engine records the first edit. The second still needs the checkpoint.
    recorded(refused[0]!);
    await flushTypingCheckpoints(workspaceId);
    expect(retire).not.toHaveBeenCalled();
    expect((await saved()).map(row => row.updates.map(update => update.requestId))).toEqual([[refused[1]]]);
    recorded(refused[1]!);
    await vi.waitFor(async () => expect(await saved()).toEqual([]));
    expect(retire).toHaveBeenCalledOnce();
  } finally {
    await session.close({ settle: false });
    await capture.stop();
    renderer.destroy();
  }
});
