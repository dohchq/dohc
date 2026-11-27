import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { foldScene, insertElementRevision } from "@dohc/excalidraw-scene";
import { YdocOwnerDraftPendingError } from "@dohc/workspace-engine-client";
import { createDrawing, editDrawing, readDrawing } from "./drawingEdit";
import {
  DOCUMENT_EDIT_PENDING_WARNING,
  LiveDocumentEditAppliedError,
  type EngineYDocSessionProvider,
  type LiveDocumentSessions,
} from "./engineYDocSessionIpc";

const origin = { attribution: { kind: "agent", agentRunId: "run-1" } } as never;

function sessions(doc: Y.Doc, hooks: { afterApply?(): void; settle?(): Promise<void> } = {}) {
  const shown: Uint8Array[] = [];
  const applied: unknown[] = [];
  const provider = {
    doc,
    applyDecidedLocalUpdate: async (
      decide: (doc: Y.Doc) => Uint8Array | null,
      _armed: unknown,
      options: unknown,
    ) => {
      const update = decide(doc);
      if (update === null) return false;
      Y.applyUpdate(doc, update);
      applied.push(options);
      hooks.afterApply?.();
      return true;
    },
    settleNow: vi.fn(async () => await hooks.settle?.()),
  } as unknown as EngineYDocSessionProvider;
  const live = {
    readDocument: async ({ path }: { path: string }) => ({
      path,
      state: Y.encodeStateAsUpdate(doc),
    }),
    editLiveDocument: async (
      input: { path: string; kind: string },
      apply: Parameters<LiveDocumentSessions["editLiveDocument"]>[1],
    ) => {
      expect(input.kind).toBe("scene");
      const result = await apply(provider, input.path, {
        held: true,
        shared: false,
        assertSame: () => undefined,
        show: (update) => shown.push(update),
      });
      return { path: input.path, result };
    },
  } as unknown as LiveDocumentSessions;
  return { live, shown, applied, provider };
}

const target = { workspaceId: "ws", path: "plan.excalidraw", origin };

describe("editDrawing", () => {
  it("applies through the held session, shows the canvas, and credits the run", async () => {
    const doc = new Y.Doc();
    const { live, shown, applied, provider } = sessions(doc);
    const result = await editDrawing(live, {
      ...target,
      edit: { add: [{ id: "a", type: "rectangle", x: 0, y: 0 }] },
    });
    expect(result).toEqual({
      ok: true,
      path: "plan.excalidraw",
      elements: [{ id: "a", version: 1 }],
    });
    expect(shown).toHaveLength(1);
    expect(applied[0]).toMatchObject({ attribution: { agentRunId: "run-1" } });
    expect(provider.settleNow).toHaveBeenCalledOnce();
  });

  it("refuses a stale expectedVersion without writing", async () => {
    const doc = new Y.Doc();
    const { live, shown, provider } = sessions(doc);
    await editDrawing(live, {
      ...target,
      edit: { add: [{ id: "a", type: "ellipse", x: 0, y: 0 }] },
    });
    const result = await editDrawing(live, {
      ...target,
      edit: { update: [{ id: "a", expectedVersion: 0, x: 9 }] },
    });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("a is at version 1, not 0"),
    });
    expect(shown).toHaveLength(1);
    expect(provider.settleNow).toHaveBeenCalledOnce();
  });

  it("reports an element a concurrent change won as applied, so a retry does not repeat it", async () => {
    const doc = new Y.Doc();
    const canvas = new Y.Doc();
    const { live } = sessions(doc, {
      afterApply: () => {
        const ours = foldScene(doc).elements.find((element) => element.id === "a");
        if (ours?.version !== 2) return;
        insertElementRevision(canvas, { ...ours, x: 500, version: 3, versionNonce: 1 });
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(canvas));
      },
    });
    await editDrawing(live, {
      ...target,
      edit: { add: [{ id: "a", type: "diamond", x: 0, y: 0 }] },
    });
    Y.applyUpdate(canvas, Y.encodeStateAsUpdate(doc));
    await expect(
      editDrawing(live, { ...target, edit: { update: [{ id: "a", expectedVersion: 1, x: 10 }] } }),
    ).rejects.toThrow(LiveDocumentEditAppliedError);
    expect(foldScene(doc).elements[0]).toMatchObject({ x: 500, version: 3 });
  });

  it("answers a pending owner draft with the pending warning", async () => {
    const { live } = sessions(new Y.Doc(), {
      settle: async () => {
        throw new YdocOwnerDraftPendingError("pending" as never);
      },
    });
    const result = await editDrawing(live, {
      ...target,
      edit: { add: [{ type: "text", x: 0, y: 0, text: "hi" }] },
    });
    expect(result).toMatchObject({ ok: true, warning: DOCUMENT_EDIT_PENDING_WARNING });
  });
});

describe("editDrawing on a drawing the engine cannot open", () => {
  it("explains what a native drawing needs, and leaves later refusals alone", async () => {
    const refusal = new Error("invalid-input");
    const unopened = {
      editLiveDocument: async () => {
        throw refusal;
      },
    } as unknown as LiveDocumentSessions;
    const edit = { update: [{ id: "a", expectedVersion: 1, x: 5 }] };
    await expect(editDrawing(unopened, { ...target, edit })).rejects.toThrow(
      "plan.excalidraw is not saved in Excalidraw's own format",
    );
    const { live } = sessions(new Y.Doc(), {
      afterApply: () => {
        throw refusal;
      },
    });
    await expect(
      editDrawing(live, { ...target, edit: { add: [{ type: "rectangle", x: 0, y: 0 }] } }),
    ).rejects.toBe(refusal);
  });
});

describe("createDrawing", () => {
  it("writes the empty scene, then adds elements; refuses bad elements before writing", async () => {
    const doc = new Y.Doc();
    const { live } = sessions(doc);
    const writes: string[] = [];
    const refused = await createDrawing(
      live,
      { ...target, elements: [{ type: "rectangle", x: 0, y: 0, text: "no" }] },
      async (text) => void writes.push(text),
    );
    expect(refused).toMatchObject({ ok: false });
    expect(writes).toEqual([]);
    const created = await createDrawing(
      live,
      { ...target, elements: [{ id: "a", type: "frame", x: 0, y: 0 }] },
      async (text) => void writes.push(text),
    );
    expect(created).toMatchObject({ ok: true, elements: [{ id: "a", version: 1 }] });
    expect(JSON.parse(writes[0]!)).toMatchObject({ type: "excalidraw", elements: [] });
  });
});

describe("readDrawing", () => {
  it("reads the live scene, or the settled file without deleted elements", async () => {
    const doc = new Y.Doc();
    const { live } = sessions(doc);
    await editDrawing(live, {
      ...target,
      edit: {
        add: [
          {
            id: "a",
            type: "line",
            x: 0,
            y: 0,
            points: [
              [0, 0],
              [5, 5],
            ],
          },
        ],
      },
    });
    expect(await readDrawing(live, target, async () => "")).toMatchObject({
      live: true,
      elements: [{ id: "a", type: "line", pointCount: 2 }],
    });
    const settled = {
      ...live,
      readDocument: async ({ path }: { path: string }) => ({ path, state: null }),
    } as LiveDocumentSessions;
    const file = JSON.stringify({
      type: "excalidraw",
      elements: [
        { id: "x", type: "rectangle", version: 4, x: 1, y: 2, width: 3, height: 4 },
        { id: "gone", type: "rectangle", isDeleted: true },
      ],
      appState: { viewBackgroundColor: "#fff", zoom: { value: 2 } },
    });
    expect(await readDrawing(settled, target, async () => file)).toEqual({
      path: "plan.excalidraw",
      live: false,
      elements: [{ id: "x", type: "rectangle", version: 4, x: 1, y: 2, width: 3, height: 4 }],
      appState: { viewBackgroundColor: "#fff" },
    });
    await expect(
      readDrawing(settled, target, async () => JSON.stringify({ type: "unrelated" })),
    ).rejects.toThrow("plan.excalidraw is not an Excalidraw drawing.");
    expect(await readDrawing(settled, target, async () => "")).toMatchObject({ elements: [] });
  });
});
