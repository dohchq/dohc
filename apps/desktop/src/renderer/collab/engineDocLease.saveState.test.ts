// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { insertElementRevision, putSceneAsset } from "@dohc/excalidraw-scene";
import { resetOrphanedDrafts, useOrphanedDrafts } from "../orphanedDrafts";
import { disposeEngineDocLeasesForTests } from "./engineDocLease";
import { retainObservedEngineDocLease } from "./engineDocLeaseTestHarness";
import { harnessBridge, IMAGE_DESCRIPTOR } from "./engineDocSaveStateTestHarness";
import { parseExcalidrawDocument } from "../excalidrawDocument";

const projectionGate = vi.hoisted(() => ({
  pending: null as Promise<void> | null,
  completed: 0,
}));

vi.mock("@dohc/ydoc-projection", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@dohc/ydoc-projection")
  >();
  return {
    ...actual,
    yDocToMarkdown(doc: Y.Doc) {
      const markdown = actual.yDocToMarkdown(doc);
      return (
        projectionGate.pending?.then(() => {
          projectionGate.completed += 1;
          return `${markdown} [projected]`;
        }) ??
        markdown
      );
    },
  };
});

// AUDIT-SILENTSAVE. The engine editor's save indicator used to be a 1s timer
// that flipped to "saved" no matter what the engine did — three dogfood
// journeys watched a doc read "Saved" over a ZERO-BYTE .md. It is now driven
// only by main's real settle outcomes. These tests own that contract: no
// timer may resurrect "saved", a failure must show, and a settle that predates
// the newest keystroke must not claim to cover it.

let harness: ReturnType<typeof harnessBridge>;
let retained: ReturnType<typeof retainObservedEngineDocLease>;
let documentKind: "richdoc" | "scene";
let sceneVersion = 1;

function observeDrafts(path: string) {
  return renderHook(() => useOrphanedDrafts("ws-1", path));
}

let drafts: ReturnType<typeof observeDrafts>;

function retainDocument(path = "notes/big.md", kind: "richdoc" | "scene" = "richdoc") {
  documentKind = kind;
  sceneVersion = 1;
  drafts = observeDrafts(path);
  retained = retainObservedEngineDocLease({
    workspaceId: "ws-1",
    path,
    kind,
    enabled: true,
  });
}

function boundOutcome() {
  const outcome = retained.snapshot.outcome;
  if (outcome?.kind !== "bound") throw new Error("Expected a bound lease");
  return outcome;
}

function editDocument() {
  const doc = retained.boundDoc();
  if (documentKind === "scene") {
    sceneVersion += 1;
    insertElementRevision(doc, {
      id: "recovered-shape",
      type: "rectangle",
      version: sceneVersion,
      versionNonce: sceneVersion,
      isDeleted: false,
      index: "a0",
      x: (sceneVersion - 1) * 10,
    });
    return;
  }
  const text = doc.getText("plainText");
  text.insert(text.length, "!");
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  harness = harnessBridge();
  vi.stubGlobal("dohcDesktop", harness.api);
  resetOrphanedDrafts();
  projectionGate.pending = null;
  projectionGate.completed = 0;
});

afterEach(async () => {
  cleanup();
  retained?.release();
  await disposeEngineDocLeasesForTests();
  await retained?.lease.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetOrphanedDrafts();
  projectionGate.pending = null;
  projectionGate.completed = 0;
});

async function retainBound() {
  retainDocument();
  await waitFor(() => expect(retained.snapshot.outcome?.kind).toBe("bound"));
}

async function flushLocalBatch(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(32);
  });
}

it("never flips back to Saved on a timer — only a real settle report clears it", async () => {
  await retainBound();

  act(() => {
    editDocument();
  });
  expect(retained.snapshot.saveState).toBe("saving");

  // The old indicator flipped to "saved" 1s after the last edit regardless of
  // the engine. Run far past that: with no settle report, nothing may claim it.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(retained.snapshot.saveState).toBe("saving");

  // Only main's real report clears it.
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.saveState).toBe("saved");
});

it("observes unsaved edits on a replacement document", async () => {
  await retainBound();
  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));

  act(() => {
    editDocument();
  });
  await flushLocalBatch();

  expect(retained.snapshot.saveState).toBe("saving");
  expect(harness.applied).toHaveLength(1);
});

it("persists a late edit on the losing mirror during replacement", async () => {
  await retainBound();
  const losingDoc = retained.boundDoc();

  harness.emitLineageReplacement("winner");
  act(() => {
    const text = losingDoc.getText("plainText");
    text.insert(text.length, "!");
  });

  await waitFor(() =>
    expect(drafts.result.current.at(-1)?.text).toBe("seed!"),
  );
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
  expect(harness.applied).toHaveLength(0);
  expect(retained.snapshot.outcome?.kind).toBe("bound");
});

it("binds a winning lineage while the deleted path stays deleted", async () => {
  // Main keeps a deleted entry refusing updates whichever lineage wins, so
  // the renderer must keep reporting deletion across the replacement — while
  // a slow retired-recovery projection must still not block the winner from
  // binding.
  let releaseProjection!: () => void;
  projectionGate.pending = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  try {
    await retainBound();

    act(() => editDocument());
    harness.emitNow("deleted", 0);
    harness.emitLineageReplacement("unused");

    await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
    await act(async () => {
      releaseProjection();
      await projectionGate.pending;
    });
    await waitFor(() =>
      expect(projectionGate.completed).toBeGreaterThanOrEqual(2),
    );
    expect(retained.snapshot.outcome?.kind).toBe("bound");
    expect(retained.snapshot.deletion?.token).toBe(boundOutcome().token);
  } finally {
    releaseProjection();
  }
});

it("loads scene asset bytes only when recovery needs them", async () => {
  harness = harnessBridge("scene");
  const readAsset = vi.fn(async () => ({
    descriptor: IMAGE_DESCRIPTOR,
    bytes: new Uint8Array([1, 2, 3]),
  }));
  harness.setArtifactReader([IMAGE_DESCRIPTOR], readAsset);
  putSceneAsset(harness.sourceDoc, IMAGE_DESCRIPTOR);
  insertElementRevision(harness.sourceDoc, {
    id: "image-element",
    type: "image",
    fileId: IMAGE_DESCRIPTOR.id,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    index: "a1",
  });
  vi.stubGlobal("dohcDesktop", harness.api);
  retainDocument("drawing.excalidraw", "scene");
  await waitFor(() =>
    expect(retained.snapshot.outcome?.kind).toBe("bound"),
  );

  expect(readAsset).not.toHaveBeenCalled();

  act(() => editDocument());
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  await waitFor(() => expect(readAsset).toHaveBeenCalledOnce());
  await waitFor(() => {
    const recovered = parseExcalidrawDocument(
      drafts.result.current.at(-1)?.text!,
    );
    expect(recovered.files[IMAGE_DESCRIPTOR.id]).toMatchObject({
      dataURL: "data:image/png;base64,AQID",
    });
  });
});

it("keeps deletion recovery separate from refused winner edits", async () => {
  await retainBound();
  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  const appliedAtDelete = harness.applied.length;
  harness.emit("deleted", harness.applied.at(-1)!.seq);
  await waitFor(() => expect(drafts.result.current.at(-1)?.text).toBe("seed!"));

  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
  expect(retained.snapshot.saveState).toBe("deleted");

  act(() => {
    editDocument();
  });
  await waitFor(() => expect(drafts.result.current.at(-1)?.text).toBe("winner!"));
  expect(harness.applied).toHaveLength(appliedAtDelete);
  expect(drafts.result.current.length).toBe(2);
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("seed!");
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("winner!");
  expect(retained.snapshot.saveState).toBe("deleted");

  cleanup();
  retained.release();
  await disposeEngineDocLeasesForTests();
  await retained.lease.dispose();
  drafts = observeDrafts("notes/big.md");
  expect(drafts.result.current.length).toBe(2);
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("seed!");
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("winner!");
});

it("keeps recovery from consecutive independent lineage replacements", async () => {
  await retainBound();
  act(() => {
    editDocument();
  });
  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));

  act(() => {
    editDocument();
  });
  harness.emitLineageReplacement("final", [], 3);
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2, 3]));

  expect(drafts.result.current.length).toBe(2);
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("seed!");
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("winner!");
});

it("shows the failure when a settle fails, instead of reading Saved", async () => {
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  harness.emit("error", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.saveState).toBe("error");

  // It stays honest: no timer, no later edit-less event, walks it back.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(retained.snapshot.saveState).toBe("error");
});

it("does not report Saved while an earlier delivery is still unanswered", async () => {
  await retainBound();
  const rejectFirst = harness.deferNextApplyFailure();
  try {

    act(() => {
      editDocument();
    });
    await flushLocalBatch();
    expect(harness.applyAttempts).toHaveLength(1);

    act(() => {
      editDocument();
    });
    await flushLocalBatch();

    // Main echoes a settle covering the newest seq while the first delivery has
    // not answered. It must not vouch for the whole mirror yet.
    harness.emit("saved", 2);
    expect(retained.snapshot.saveState).toBe("saving");

    rejectFirst();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await waitFor(() => expect(harness.applied.at(-1)?.seq).toBe(2));
    expect(harness.mainText()).toBe("seed!!");
    // Every outstanding delivery is acknowledged; the deferred settle now
    // reports the mirror durable without another event.
    await waitFor(() =>
      expect(retained.snapshot.saveState).toBe("saved"),
    );
  } finally {
    rejectFirst();
  }
});

it("stays Saving until a retried delivery converges", async () => {
  await retainBound();
  harness.rejectNextApplyAttempts(2);

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  expect(harness.applyAttempts).toHaveLength(1);
  expect(retained.snapshot.saveState).toBe("saving");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(harness.applyAttempts).toHaveLength(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  await waitFor(() => expect(harness.applyAttempts).toHaveLength(3));
  expect(harness.mainText()).toBe("seed!");

  harness.emit("saved", harness.applied.at(-1)!.seq);
  await waitFor(() =>
    expect(retained.snapshot.saveState).toBe("saved"),
  );
});

it("refuses transport writes synchronously after main reports deletion", async () => {
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  const appliedAtDelete = harness.applied.length;
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  expect(retained.snapshot.saveState).toBe("deleted");
  expect(retained.snapshot.deletion?.token).toBe(boundOutcome().token);

  // A Y.Doc update can fire before the read-only React render commits. The
  // transport ref closes that gap, so no later update reaches main.
  act(() => {
    editDocument();
  });
  expect(harness.applied).toHaveLength(appliedAtDelete);
  expect(retained.snapshot.saveState).toBe("deleted");

  harness.emit("error", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.saveState).toBe("deleted");
});

it("keeps one recovery draft when deletion lands during a lineage replacement handoff", async () => {
  await retainBound();

  act(() => {
    editDocument();
  });
  // The mirror is dirty, so the replacement's preserve persists a recovery
  // draft synchronously; main's deletion notice for the same session lands
  // before the handoff acknowledges. The deletion must refine the preserved
  // draft, not capture a sibling from the same mirror.
  act(() => {
    harness.emitLineageReplacement("winner!");
    harness.emitNow("deleted", 0);
  });

  await waitFor(() =>
    expect(retained.snapshot.saveState).toBe("deleted"),
  );
  expect(drafts.result.current.length).toBe(1);
  expect(drafts.result.current.at(-1)?.text).toContain("seed!");
});

it("freezes the deleted doc's bytes at the event, immune to a remote edit that lands before serialization resolves", async () => {
  // The boundary capture snapshots the doc synchronously at the
  // deletion event and defers only the markdown PROJECTION (the part that
  // needs the lazy Tiptap module). Nothing before this pin distinguished
  // that from deferring the snapshot too — both pass every earlier test,
  // because unmount alone does not corrupt a Y.Doc's encodable state.
  //
  // A remote update is the real discriminator: it is not gated by
  // `writesRefused` (only LOCAL writes are refused after deletion), so it
  // can still land on the same doc while the projection is in flight. A
  // synchronous snapshot is immune to it; a deferred one would pick it up.
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  harness.emitNow("deleted", harness.applied.at(-1)!.seq);

  // Lands after the event, before the queued serialize job has resolved.
  harness.emitRemoteEdit("+remote");

  await waitFor(() => expect(drafts.result.current.at(-1)?.text).toBe("seed!"));
});

it("stores a deleted scene as portable Excalidraw JSON", async () => {
  harness = harnessBridge("scene");
  vi.stubGlobal("dohcDesktop", harness.api);
  retainDocument("drawing.excalidraw", "scene");
  await waitFor(() =>
    expect(retained.snapshot.outcome?.kind).toBe("bound"),
  );

  act(() => editDocument());
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  await waitFor(() => {
    const text = drafts.result.current.at(-1)?.text ?? "none";
    expect(text).not.toBe("none");
    const recovered = JSON.parse(text);
    expect(recovered).toMatchObject({
      type: "excalidraw",
      source: "https://excalidraw.com",
      elements: [{ id: "recovered-shape" }],
      files: {},
    });
  });
});

it("observes deletion while the open answer is still in flight", async () => {
  harness.setEmitDeletedDuringOpen(true);
  retainDocument();

  await waitFor(() => expect(retained.snapshot.outcome?.kind).toBe("bound"));
  expect(retained.snapshot.saveState).toBe("deleted");
  expect(retained.snapshot.deletion?.token).toBe(boundOutcome().token);
});

it("passes a file-locked report through, and a real settle clears it", async () => {
  // The transient lock is its own state so the surface can name the
  // blocker. Like "error" it never decays on a timer — only a real settle
  // report walks it back, which is what the engine's own retry produces.
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  harness.emit("file-locked", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.saveState).toBe("file-locked");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(retained.snapshot.saveState).toBe("file-locked");

  // The engine's retry lands: the same real report clears it to Saved.
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.saveState).toBe("saved");
});

it("does not claim File in use for a lock refusal that predates the newest keystroke", async () => {
  // `file-locked` is the one refusal whose copy makes a durability claim —
  // dohc has your edits, and it is retrying. A refusal about older text would
  // promise safety for a keystroke the settle never carried, so it is held to
  // the same sequence guard "saved" uses.
  //
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  const firstSeq = harness.applied.at(-1)!.seq;
  act(() => {
    editDocument();
  });

  // The lock refusal belongs to the settle that started before the second
  // keystroke. The second edit is staged but not sent yet. The local sequence
  // already guards it, so the document stays saving instead of claiming the
  // edit is safely parked under a lock.
  harness.emit("file-locked", firstSeq);
  expect(retained.snapshot.saveState).toBe("saving");

  // A refusal that does cover the newest edit names the blocker.
  await flushLocalBatch();
  const secondSeq = harness.applied.at(-1)!.seq;
  expect(secondSeq).toBeGreaterThan(firstSeq);
  harness.emit("file-locked", secondSeq);
  expect(retained.snapshot.saveState).toBe("file-locked");
});

it("does not claim Saved for a settle that predates the newest keystroke", async () => {
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  const firstSeq = harness.applied.at(-1)!.seq;
  act(() => {
    editDocument();
  });

  // A settle that started before the second keystroke reports success. It
  // never carried that staged, not-yet-sent edit, so the indicator must keep
  // saying "saving".
  harness.emit("saved", firstSeq);
  expect(retained.snapshot.saveState).toBe("saving");

  // The follow-up settle covers it.
  await flushLocalBatch();
  const secondSeq = harness.applied.at(-1)!.seq;
  expect(secondSeq).toBeGreaterThan(firstSeq);
  harness.emit("saved", secondSeq);
  await waitFor(() =>
    expect(retained.snapshot.saveState).toBe("saved"),
  );
});

it("counts a save that kept the person's text over an outside write, even while they type on", async () => {
  // The notice must not wait for the chip: the person is usually still
  // typing, which holds the chip on "saving" past this settle's seq.
  await retainBound();
  expect(retained.snapshot.externalWritesInHistory).toBe(0);

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  const firstSeq = harness.applied.at(-1)!.seq;
  act(() => {
    editDocument();
  });

  harness.emit("external-write-in-history", firstSeq);
  expect(retained.snapshot.externalWritesInHistory).toBe(1);
  expect(retained.snapshot.saveState).toBe("saving");

  // It is a save like any other for the chip.
  await flushLocalBatch();
  harness.emit("external-write-in-history", harness.applied.at(-1)!.seq);
  await waitFor(() => expect(retained.snapshot.saveState).toBe("saved"));
  expect(retained.snapshot.externalWritesInHistory).toBe(2);
});

it("stays Saving while a rejected transport head retries ahead of later edits", async () => {
  harness.rejectNextApplyAttempts(1);
  await retainBound();

  act(() => editDocument());
  await flushLocalBatch();
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1]);
  expect(harness.applied).toEqual([]);
  expect(retained.snapshot.saveState).toBe("saving");

  // A later edit advances the same Yjs client clock. Its batch may become
  // ready, but it cannot pass the rejected head in the provider's send chain.
  act(() => editDocument());
  await flushLocalBatch();
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1]);
  expect(retained.snapshot.saveState).toBe("saving");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(218);
  });
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1, 1, 2]);
  expect(harness.applied.map(({ seq }) => seq)).toEqual([1, 2]);

  // Even after transport recovery, the first batch's settle cannot vouch for
  // the later edit. Only the acknowledgement covering sequence 2 may clear it.
  harness.emit("saved", 1);
  expect(retained.snapshot.saveState).toBe("saving");
  harness.emit("saved", 2);
  expect(retained.snapshot.saveState).toBe("saved");
});

it("ignores a save-state report addressed to a different session", async () => {
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  const seq = harness.applied.at(-1)!.seq;

  // Another document's settle must never repaint this one (the renderer
  // async-state invariant): right seq, wrong session id.
  harness.emit("saved", seq, "eyd-someone-else");
  expect(retained.snapshot.saveState).toBe("saving");

  harness.emit("saved", seq);
  await waitFor(() =>
    expect(retained.snapshot.saveState).toBe("saved"),
  );
});
