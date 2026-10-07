import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EngineYdocProviderSessionOptions } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
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
