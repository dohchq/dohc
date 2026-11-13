// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { insertElementRevision, putSceneAsset } from "@dohc/excalidraw-scene";
import { resetOrphanedDrafts, useOrphanedDrafts } from "../orphanedDrafts";
import { ORPHANED_DRAFT_STORAGE_KEY, loadStoredDrafts } from "../orphanedDraftStorage";
import { disposeEngineDocLeasesForTests, withClosedEngineDocSession } from "./engineDocLease";
import { retainObservedEngineDocLease } from "./engineDocLeaseTestHarness";
import { harnessBridge, IMAGE_DESCRIPTOR } from "./engineDocSaveStateTestHarness";
import { parseExcalidrawDocument } from "../excalidrawDocument";
import { REPLACED_DOCUMENT_SAVED, REPLACED_DOCUMENT_UNSAVED, useDocumentSaveNotices, type DocumentSaveFailure } from "../shell/useDocumentSaveNotices";

const projectionGate = vi.hoisted(() => ({
  pending: null as Promise<void> | null,
  completed: 0,
  // When set, each projection waits until the test releases it.
  held: null as Array<{ markdown: string; release: () => void }> | null,
}));

vi.mock("@dohc/ydoc-projection", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@dohc/ydoc-projection")
  >();
  return {
    ...actual,
    yDocToArtifactMarkdown(doc: Y.Doc) {
      const markdown = actual.yDocToArtifactMarkdown(doc);
      const held = projectionGate.held;
      if (held) {
        return new Promise<void>((release) => held.push({ markdown, release }))
          .then(() => {
            projectionGate.completed += 1;
            return `${markdown} [projected]`;
          });
      }
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
  projectionGate.held = null;
});

it.each([false, true])("flushes and closes Stop's draft before the request, then reopens it (waiting=%s)", async waiting => {
  retainDocument();
  await waitFor(() => expect(retained.snapshot.outcome?.kind).toBe("bound"));
  const previous = harness.sessionId()!;
  act(() => editDocument());
  const work = vi.fn(async () => {
    expect(harness.mainText()).toBe("seed!");
    expect(harness.closed).toContain(previous);
    expect(retained.snapshot.outcome).toBeNull();
    if (waiting) throw new Error("Stop live editing is waiting. You can keep editing.");
  });
  await act(async () => {
    const stop = withClosedEngineDocSession("ws-1", {path: "notes/big.md"}, work);
    if (waiting) await expect(stop).rejects.toThrow("waiting"); else await stop;
  });
  await waitFor(() => expect(harness.openCount()).toBe(2));
  expect(harness.sessionId()).not.toBe(previous);
  expect(work).toHaveBeenCalledTimes(1);
  expect(retained.boundDoc().getText("plainText").toString()).toBe("seed!");
  act(() => editDocument());
  await boundOutcome().flushPendingLocalUpdates();
  expect(harness.mainText()).toBe("seed!!");
});

// A record keeps the path its document had when it stopped. A Stop that names
// the document by its object id closes the panes that opened it at a new path,
// and none of another document that now has its old path.
it("closes the panes of the document a Stop names, at whatever path they opened it, and only those", async () => {
  const open = harness.api.openEngineYDocSession.bind(harness.api);
  vi.spyOn(harness.api, "openEngineYDocSession").mockImplementation(async payload => Object.assign(await open(payload), { objectId: "object-1" }));
  retainDocument("notes/new.md");
  await waitFor(() => expect(retained.snapshot.outcome?.kind).toBe("bound"));
  const previous = harness.sessionId()!;
  // The pane at notes/new.md now holds object-1; a Stop of another document there closes nothing.
  await withClosedEngineDocSession("ws-1", {objectId: "other-object"}, async () => undefined);
  await withClosedEngineDocSession("other-workspace", {objectId: "object-1"}, async () => undefined);
  expect(harness.closed).toEqual([]);
  const work = vi.fn(async () => {expect(harness.closed).toContain(previous);});
  await act(async () => {await withClosedEngineDocSession("ws-1", {objectId: "object-1"}, work);});
  expect(work).toHaveBeenCalledOnce();
  await waitFor(() => expect(harness.openCount()).toBe(2));
});

afterEach(async () => {
  const held = projectionGate.held;
  projectionGate.held = null;
  for (const projection of held ?? []) projection.release();
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

// Deleting the global makes any read of it throw the ReferenceError the
// sandboxed renderer throws.
async function withoutProcess(run: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
  if (!descriptor) throw new Error("expected a process global to remove");
  Reflect.deleteProperty(globalThis, "process");
  try {
    await run();
  } finally {
    Object.defineProperty(globalThis, "process", descriptor);
  }
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
  expect(retained.snapshot.saveState.kind).toBe("saving");

  // The old indicator flipped to "saved" 1s after the last edit regardless of
  // the engine. Run far past that: with no settle report, nothing may claim it.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(retained.snapshot.saveState.kind).toBe("saving");

  // Only main's real report clears it.
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.saveState.kind).toBe("saved-here");
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
  expect(retained.snapshot.deletion?.cause).toBe("deleted");

  act(() => {
    editDocument();
  });
  await waitFor(() => expect(drafts.result.current.at(-1)?.text).toBe("winner!"));
  expect(harness.applied).toHaveLength(appliedAtDelete);
  expect(drafts.result.current.length).toBe(2);
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("seed!");
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("winner!");
  expect(retained.snapshot.deletion?.cause).toBe("deleted");

  cleanup();
  retained.release();
  await disposeEngineDocLeasesForTests();
  await retained.lease.dispose();
  drafts = observeDrafts("notes/big.md");
  expect(drafts.result.current.length).toBe(2);
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("seed!");
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("winner!");
});

// The shell's notices for a replaced history, as the lease reports them.
function observeReplacementNotices() {
  const report = vi.fn<(failure: DocumentSaveFailure) => void>();
  const clear = vi.fn<(identity: string) => void>();
  renderHook(() => useDocumentSaveNotices({ workspaceId: "ws-1", report, clear, open: () => undefined }));
  return {
    report,
    clear,
    reports: () => report.mock.calls.map(([notice]) => notice)
      .filter((notice) => notice.identity === "document-replacement:ws-1:notes/big.md"),
  };
}

function refuseDraftStorage() {
  return vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  });
}

const storedDraftTexts = () => loadStoredDrafts(Date.now(), { bindHandles: false }).map((draft) => draft.text);

it("keeps the retired editor frozen while storage refuses its edits, and Try again installs the same winner once", async () => {
  const notices = observeReplacementNotices();
  await retainBound();
  const losingDoc = retained.boundDoc();
  act(() => editDocument());
  await flushLocalBatch();
  const setItem = refuseDraftStorage();
  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(retained.snapshot.readOnlyTransition?.cause).toBe("lineage-failure"));

  // No acknowledgement, no winner, and nothing of the retired editor sent.
  expect(harness.acknowledgedGenerations).toEqual([]);
  expect(retained.boundDoc()).toBe(losingDoc);
  const failure = notices.reports().at(-1)!;
  expect(failure).toMatchObject({ title: "notes/big.md", message: REPLACED_DOCUMENT_UNSAVED });
  act(() => editDocument());
  await flushLocalBatch();
  expect(harness.applied).toHaveLength(1);
  await waitFor(() => expect(drafts.result.current.map((draft) => draft.text)).toEqual(["seed!!"]));
  expect(storedDraftTexts()).toEqual([]);

  setItem.mockRestore();
  act(() => failure.retry!());
  await waitFor(() => expect(retained.boundDoc().getText("plainText").toString()).toBe("winner"));
  expect(harness.acknowledgedGenerations).toEqual([2]);
  expect(retained.snapshot.readOnlyTransition).toBeNull();
  expect(storedDraftTexts()).toEqual(["seed!!"]);
  expect(drafts.result.current).toHaveLength(1);
  expect(notices.reports().at(-1)).toMatchObject({ tone: "success", message: REPLACED_DOCUMENT_SAVED });

  // The installed generation does not install again.
  act(() => failure.retry!());
  await act(async () => { await Promise.resolve(); });
  expect(harness.acknowledgedGenerations).toEqual([2]);
  act(() => editDocument());
  await flushLocalBatch();
  expect(harness.applied).toHaveLength(2);
});

it.each(["newest text first"])("keeps the newest retired text whichever projection finishes last (%s)", async (order) => {
  await retainBound();
  const losingDoc = retained.boundDoc();
  act(() => editDocument());
  await flushLocalBatch();
  projectionGate.held = [];
  const setItem = refuseDraftStorage();
  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(retained.snapshot.readOnlyTransition?.retry).toBeTypeOf("function"));
  const retry = retained.snapshot.readOnlyTransition!.retry!;
  // Typed into the frozen editor after the failed attempt.
  act(() => editDocument());

  setItem.mockRestore();
  act(() => retry());
  await waitFor(() => expect(retained.boundDoc().getText("plainText").toString()).toBe("winner"));
  // A late edit on the retired mirror after the winner installed.
  act(() => {
    const text = losingDoc.getText("plainText");
    text.insert(text.length, "!");
  });

  // Each attempt and edit projects once, one at a time, and so does the
  // recovery slot's own refresh of the frozen edit beside them. Either the
  // newest text finishes first, so an older projection that is still pending
  // finishes last, or the refresh finishes after every retired projection.
  const held = projectionGate.held;
  const release = (entry: (typeof held)[number]) => {
    held.splice(held.indexOf(entry), 1);
    entry.release();
  };
  await waitFor(() => expect(held.map((entry) => entry.markdown).sort()).toEqual(["seed!", "seed!!"]));
  const refresh = held.find((entry) => entry.markdown === "seed!!")!;
  if (order === "newest text first") {
    for (let released = 0; released < 5; released += 1) {
      await waitFor(() => expect(held.length).toBeGreaterThan(0));
      release(held.reduce((best, entry) => entry.markdown.length > best.markdown.length ? entry : best));
    }
  } else {
    for (let released = 0; released < 4; released += 1) {
      await waitFor(() => expect(held.some((entry) => entry !== refresh)).toBe(true));
      release(held.find((entry) => entry !== refresh)!);
    }
    await waitFor(() => expect(projectionGate.completed).toBe(4));
    await waitFor(() => expect(storedDraftTexts()).toEqual(["seed!!! [projected]"]));
    release(refresh);
  }
  await waitFor(() => expect(projectionGate.completed).toBe(5));
  // Disposal waits for the recovery slot's queue, so its write has landed.
  await act(async () => { await retained.lease.dispose(); });
  const newestText = `${losingDoc.getText("plainText").toString()} [projected]`;
  expect(losingDoc.getText("plainText").toString()).toBe("seed!!!");
  await waitFor(() => expect(drafts.result.current.map((draft) => draft.text)).toEqual([newestText]));
  expect(storedDraftTexts()).toEqual([newestText]);
});

// Turning sync on claims the open document's lineage, so main hands the
// renderer a replacement while the person is still typing. The sandboxed
// renderer has no `process`, and a handoff that reached it stayed frozen.
it.each([
  { path: "trip/plan.md", platform: "win32", stored: true },
  { path: "trip/.env", platform: "linux", stored: false },
] as const)(
  "hands off $path on $platform with no process global, and typing resumes",
  async ({ path, platform, stored }) => {
    vi.stubGlobal("dohcDesktop", { ...harness.api, platform });
    retainDocument(path);
    await waitFor(() => expect(retained.snapshot.outcome?.kind).toBe("bound"));
    act(() => {
      editDocument();
    });

    await withoutProcess(async () => {
      harness.emitLineageReplacement("winner");
      await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
      act(() => {
        editDocument();
      });
      await flushLocalBatch();
    });

    expect(retained.boundDoc().getText("plainText").toString()).toBe("winner!");
    expect(harness.applied).toHaveLength(1);
    expect(retained.snapshot.saveState.kind).toBe("saving");
    // The typing the replacement retired stays recoverable in this window
    // either way. Only a tracked path may reach plaintext storage.
    expect(drafts.result.current.map((draft) => draft.text)).toEqual(["seed!"]);
    expect(
      Object.keys(localStorage)
        .filter(key => key === ORPHANED_DRAFT_STORAGE_KEY || key.startsWith(`${ORPHANED_DRAFT_STORAGE_KEY}:`))
        .some(key => localStorage.getItem(key)?.includes("seed!")),
    ).toBe(stored);
  },
);

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
    expect(retained.snapshot.saveState.kind).toBe("saving");

    rejectFirst();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await waitFor(() => expect(harness.applied.at(-1)?.seq).toBe(2));
    expect(harness.mainText()).toBe("seed!!");
    // Every outstanding delivery is acknowledged; the deferred settle now
    // reports the mirror durable without another event.
    await waitFor(() =>
      expect(retained.snapshot.saveState.kind).toBe("saved-here"),
    );
  } finally {
    rejectFirst();
  }
});

it("stays Saving while a rejected transport head retries ahead of later edits", async () => {
  harness.rejectNextApplyAttempts(1);
  await retainBound();

  act(() => editDocument());
  await flushLocalBatch();
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1]);
  expect(harness.applied).toEqual([]);
  expect(retained.snapshot.saveState.kind).toBe("saving");

  // A later edit advances the same Yjs client clock. Its batch may become
  // ready, but it cannot pass the rejected head in the provider's send chain.
  act(() => editDocument());
  await flushLocalBatch();
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1]);
  expect(retained.snapshot.saveState.kind).toBe("saving");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(218);
  });
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1, 1, 2]);
  expect(harness.applied.map(({ seq }) => seq)).toEqual([1, 2]);

  // Even after transport recovery, the first batch's settle cannot vouch for
  // the later edit. Only the acknowledgement covering sequence 2 may clear it.
  harness.emit("saved", 1);
  expect(retained.snapshot.saveState.kind).toBe("saving");
  harness.emit("saved", 2);
  expect(retained.snapshot.saveState.kind).toBe("saved-here");
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
  expect(retained.snapshot.saveState.kind).toBe("saving");

  harness.emit("saved", seq);
  await waitFor(() =>
    expect(retained.snapshot.saveState.kind).toBe("saved-here"),
  );
});

it("publishes no additional save snapshots during repeated dirty keystrokes", async () => {
  await retainBound();
  const notified = vi.fn();
  const unsubscribe = retained.lease.subscribe(notified);
  act(() => editDocument());
  expect(notified).toHaveBeenCalledTimes(1);
  notified.mockClear();
  act(() => { for (let i = 0; i < 3; i++) editDocument(); });
  expect(notified).not.toHaveBeenCalled();
  await flushLocalBatch();
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(notified).toHaveBeenCalledTimes(1);
  notified.mockClear();
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(notified).not.toHaveBeenCalled();
  unsubscribe();
});

it("ends clean share access as read-only without a recovery draft", async () => {
  await retainBound();
  harness.emit("saved-to-host", 0);
  harness.emit("read-only", 0);

  expect(retained.snapshot.readOnlyTransition?.token).toBe(boundOutcome().token);
  expect(drafts.result.current).toHaveLength(0);
  await waitFor(() => expect(harness.closed).toHaveLength(1));
  harness.emit("saved-to-host", 0);
  expect(retained.snapshot.readOnlyTransition?.token).toBe(boundOutcome().token);
  expect(drafts.result.current).toHaveLength(0);
});

it("keeps edits made before the clean read-only render commits", async () => {
  await retainBound();
  harness.emit("saved-to-host", 0);
  harness.emit("read-only", 0);
  let releaseProjection!: () => void;
  projectionGate.pending = new Promise<void>((resolve) => { releaseProjection = resolve; });
  try {
    act(() => editDocument());
    expect(loadStoredDrafts(Date.now()).at(-1)?.text).toBe("seed!");
    expect(projectionGate.completed).toBe(0);
  } finally {
    releaseProjection();
    projectionGate.pending = null;
  }

  await waitFor(() => expect(drafts.result.current.at(-1)?.text).toBe("seed!"));
  expect(harness.mainText()).toBe("seed");
  expect(drafts.result.current).toHaveLength(1);
});
