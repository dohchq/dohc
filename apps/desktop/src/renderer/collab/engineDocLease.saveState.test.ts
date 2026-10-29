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
import { EngineYDocDeliveryRefusedError } from "./engineYDocProvider";
import { parseExcalidrawDocument } from "../excalidrawDocument";
import {
  REPLACED_DOCUMENT_SAVED,
  REPLACED_DOCUMENT_UNSAVED,
  useDocumentSaveNotices,
  type DocumentSaveFailure,
} from "../shell/useDocumentSaveNotices";

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

it("does not close another document when Stop changes one document", async () => {
  retainDocument();
  await waitFor(() => expect(retained.snapshot.outcome?.kind).toBe("bound"));
  await withClosedEngineDocSession("other-workspace", {path: "notes/big.md"}, async () => undefined);
  expect(harness.closed).toEqual([]);
  expect(harness.openCount()).toBe(1);
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

it("refuses Stop when its lease is disposed while the draft closes", async () => {
  await retainBound();
  let finish!: () => void;
  const closing = new Promise<void>(resolve => {finish = resolve;});
  const close = vi.spyOn(harness.api, "closeEngineYDocSession").mockImplementationOnce(async () => {await closing;return undefined;});
  const work = vi.fn(async () => undefined);
  const stop = withClosedEngineDocSession("ws-1", {path: "notes/big.md"}, work);
  const result = expect(stop).rejects.toThrow("could not stop live editing");
  await waitFor(() => expect(close).toHaveBeenCalled());
  const disposal = retained.lease.dispose();
  finish();
  await disposal;
  await result;
  expect(work).not.toHaveBeenCalled();
});

it("refuses a superseded Stop while the next transition still runs",async () => {
  await retainBound();
  let finish!:()=>void;
  const closing=new Promise<void>(resolve=>{finish=resolve;});
  const close=vi.spyOn(harness.api,"closeEngineYDocSession").mockImplementationOnce(async()=>{await closing;return undefined;});
  const first=vi.fn(async()=>undefined),second=vi.fn(async()=>undefined);
  const stop=withClosedEngineDocSession("ws-1",{path:"notes/big.md"},first);
  const result=expect(stop).rejects.toThrow("could not stop live editing");
  await waitFor(()=>expect(close).toHaveBeenCalled());
  const successor=withClosedEngineDocSession("ws-1",{path:"notes/big.md"},second);
  finish();await result;await successor;
  expect(first).not.toHaveBeenCalled();expect(second).toHaveBeenCalledOnce();
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

it("receives saved state at the resolved path when opened through a case alias", async () => {
  let report!: Parameters<typeof harness.api.onEngineYDocSaveState>[0];
  const subscribe = harness.api.onEngineYDocSaveState.bind(harness.api);
  vi.spyOn(harness.api, "onEngineYDocSaveState").mockImplementation(listener => {
    report = listener;
    return subscribe(listener);
  });
  retainDocument("notes/folder/a.md");
  await waitFor(() => expect(retained.snapshot.outcome?.kind).toBe("bound"));
  act(() => editDocument());
  await flushLocalBatch();
  expect(retained.snapshot.saveState.kind).toBe("saving");
  act(() => report({
    sessionId: harness.sessionId()!, workspaceId: "ws-1", path: "Notes/Folder/A.md",
    state: { kind: "saved-here" }, seq: harness.applied.at(-1)!.seq, headSha256: "a".repeat(64),
  }));
  expect(retained.snapshot.saveState.kind).toBe("saved-here");
  expect(boundOutcome().headSha256).toBe("a".repeat(64));
});

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

// #2463. Main counts the edits it has. A change outside dohc must not read as
// nothing unsaved while this editor still has edits main has not confirmed.
it("counts an edit main has not confirmed when the file changed outside dohc", async () => {
  await retainBound();
  act(() => {
    editDocument();
  });
  harness.emitChangedOutside(false, 0);
  expect(retained.snapshot.changedOutside?.unsaved).toBe(true);
});

it("makes a change outside dohc unsaved when typing lands after it", async () => {
  await retainBound();
  harness.emitChangedOutside(false, 0);
  expect(retained.snapshot.changedOutside?.unsaved).toBe(false);
  act(() => {
    editDocument();
  });
  expect(retained.snapshot.changedOutside?.unsaved).toBe(true);
  // A later report from main cannot make it saved again.
  harness.emitChangedOutside(false, 0);
  expect(retained.snapshot.changedOutside?.unsaved).toBe(true);
});

// An agent's edit through dohc reaches this editor from main, so it is not a
// local edit. Landing after main said nothing was unsaved, it still is one.
it("makes a change outside dohc unsaved when an agent's edit lands after it", async () => {
  await retainBound();
  harness.emitChangedOutside(false, 0);
  harness.emitRemoteEdit(" agent", 1);
  expect(retained.snapshot.changedOutside?.unsaved).toBe(true);
  expect(retained.lease.unsavedEditsPending()).toBe(true);
});

it("keeps a change outside dohc reported while a history replacement installs", async () => {
  await retainBound();
  harness.emitLineageReplacement("winner");
  harness.emitChangedOutside(true, 0);
  // The replacement keeps only the newest save state for after it installs.
  harness.emit("settling", 0);
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
  expect(retained.snapshot.changedOutside?.unsaved).toBe(true);
});

it("observes unsaved edits on a replacement document", async () => {
  await retainBound();
  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));

  act(() => {
    editDocument();
  });
  await flushLocalBatch();

  expect(retained.snapshot.saveState.kind).toBe("saving");
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

it("keeps the losing mirror when storage refuses its late edit, and Try again installs the winner", async () => {
  const notices = observeReplacementNotices();
  await retainBound();
  const losingDoc = retained.boundDoc();

  // Clean when replacement starts, so nothing is set aside until the late edit.
  harness.emitLineageReplacement("winner");
  const setItem = refuseDraftStorage();
  act(() => {
    const text = losingDoc.getText("plainText");
    text.insert(text.length, "!");
  });

  await waitFor(() => expect(retained.snapshot.readOnlyTransition?.cause).toBe("lineage-failure"));
  expect(harness.acknowledgedGenerations).toEqual([]);
  expect(retained.boundDoc()).toBe(losingDoc);
  expect(drafts.result.current.map((draft) => draft.text)).toEqual(["seed!"]);
  expect(storedDraftTexts()).toEqual([]);
  const failure = notices.reports().at(-1)!;
  expect(failure).toMatchObject({ message: REPLACED_DOCUMENT_UNSAVED, retry: expect.any(Function) });

  setItem.mockRestore();
  act(() => failure.retry!());
  await waitFor(() => expect(retained.boundDoc().getText("plainText").toString()).toBe("winner"));
  expect(harness.acknowledgedGenerations).toEqual([2]);
  expect(storedDraftTexts()).toEqual(["seed!"]);
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

it.each(["plain text", "rich text"] as const)(
  "sets aside %s typed before and during a replaced history, then installs the winner",
  async (format) => {
    if (format === "rich text") harness.sourceDoc.getMap("meta").delete("contentKind");
    const notices = observeReplacementNotices();
    await retainBound();
    const losingDoc = retained.boundDoc();
    const type = (text: string) => act(() => {
      if (format === "plain text") {
        const plain = losingDoc.getText("plainText");
        plain.insert(plain.length, text);
        return;
      }
      const paragraph = new Y.XmlElement("paragraph");
      const run = new Y.XmlText();
      run.insert(0, text);
      paragraph.insert(0, [run]);
      const body = losingDoc.getXmlFragment("body");
      body.insert(body.length, [paragraph]);
    });
    const [before, during] = format === "plain text" ? [" before", " during"] : ["Typed before", "Typed during"];
    type(before);
    await flushLocalBatch();
    expect(harness.applied).toHaveLength(1);
    // Still in the send batch when main announces the replaced history.
    type(during);
    let acknowledgedAtNotice: number[] | null = null;
    notices.report.mockImplementation(() => { acknowledgedAtNotice = [...harness.acknowledgedGenerations]; });
    harness.emitLineageReplacement("winner");
    await waitFor(() => expect(retained.boundDoc().getText("plainText").toString()).toBe("winner"));

    const expected = format === "plain text" ? "seed before during" : "Typed before\n\nTyped during";
    expect(harness.applied).toHaveLength(1);
    await waitFor(() => expect(drafts.result.current.map((draft) => draft.text)).toEqual([expected]));
    // Reading storage again brings the same text back.
    expect(storedDraftTexts()).toEqual([expected]);
    expect(notices.reports()).toEqual([expect.objectContaining({
      tone: "success", title: "notes/big.md", message: REPLACED_DOCUMENT_SAVED,
    })]);
    expect(acknowledgedAtNotice).toEqual([2]);

    act(() => editDocument());
    await flushLocalBatch();
    expect(harness.applied).toHaveLength(2);
  },
);

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

it.each(["newest text first", "recovery refresh last"] as const)("keeps the newest retired text whichever projection finishes last (%s)", async (order) => {
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

it("shows the success notice when an unrelated refusal came before an earlier history", async () => {
  const notices = observeReplacementNotices();
  await retainBound();
  act(() => editDocument());
  await flushLocalBatch();
  // This refusal belongs to the first history, and its replacement.
  harness.emitEditRefusal("dohc could not save an edit.", 1);
  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
  expect(notices.reports()).toEqual([]);

  act(() => editDocument());
  await flushLocalBatch();
  harness.emitLineageReplacement("final", [], 3);
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2, 3]));
  expect(notices.reports()).toEqual([expect.objectContaining({ tone: "success", message: REPLACED_DOCUMENT_SAVED })]);
});

it("keeps Try again on the frozen editor when a retry fails, then installs the winner", async () => {
  await retainBound();
  const losingDoc = retained.boundDoc();
  act(() => editDocument());
  await flushLocalBatch();
  const setItem = refuseDraftStorage();
  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(retained.snapshot.readOnlyTransition?.cause).toBe("lineage-failure"));
  const first = retained.snapshot.readOnlyTransition!.retry!;

  // Try again while storage still refuses: still frozen, with a new Try again.
  act(() => first());
  await waitFor(() => expect(retained.snapshot.readOnlyTransition?.retry).not.toBe(first));
  expect(retained.boundDoc()).toBe(losingDoc);
  expect(harness.acknowledgedGenerations).toEqual([]);

  setItem.mockRestore();
  act(() => retained.snapshot.readOnlyTransition!.retry!());
  await waitFor(() => expect(retained.boundDoc().getText("plainText").toString()).toBe("winner"));
  expect(retained.snapshot.readOnlyTransition).toBeNull();
  expect(harness.acknowledgedGenerations).toEqual([2]);
  expect(storedDraftTexts()).toEqual(["seed!"]);
});

it("keeps the earlier edits in Notices and withdraws Try again when the frozen tab closes", async () => {
  const notices = observeReplacementNotices();
  await retainBound();
  act(() => editDocument());
  await flushLocalBatch();
  const setItem = refuseDraftStorage();
  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(retained.snapshot.readOnlyTransition?.cause).toBe("lineage-failure"));
  const failure = notices.reports().at(-1)!;

  retained.release();
  await disposeEngineDocLeasesForTests();
  await retained.lease.dispose();
  expect(notices.clear).toHaveBeenCalledWith("document-replacement:ws-1:notes/big.md");
  expect(drafts.result.current.map((draft) => draft.text)).toEqual(["seed!"]);

  setItem.mockRestore();
  act(() => failure.retry!());
  await act(async () => { await Promise.resolve(); });
  expect(harness.acknowledgedGenerations).toEqual([]);
});

it("leaves a replacement that follows a refused edit to the refusal's own notice", async () => {
  const notices = observeReplacementNotices();
  await retainBound();
  act(() => editDocument());
  await flushLocalBatch();
  harness.emitEditRefusal("dohc could not save an edit.", 1);
  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
  await waitFor(() => expect(drafts.result.current.map((draft) => draft.text)).toEqual(["seed!"]));
  expect(notices.reports()).toEqual([]);
});

// Turning sync on claims the open document's lineage, so main hands the
// renderer a replacement while the person is still typing. The sandboxed
// renderer has no `process`, and a handoff that reached it stayed frozen.
it.each([
  { path: "trip/plan.md", platform: "win32", stored: true },
  { path: "trip/plan.md:notes", platform: "win32", stored: false },
  { path: "trip/plan.md:notes", platform: "darwin", stored: true },
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

it("shows the failure when a settle fails, instead of reading Saved", async () => {
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  harness.emit("error", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.saveState.kind).toBe("error");

  // It stays honest: no timer, no later edit-less event, walks it back.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(retained.snapshot.saveState.kind).toBe("error");
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

it("stays Saving until a retried delivery converges", async () => {
  await retainBound();
  harness.rejectNextApplyAttempts(2);

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  expect(harness.applyAttempts).toHaveLength(1);
  expect(retained.snapshot.saveState.kind).toBe("saving");

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
    expect(retained.snapshot.saveState.kind).toBe("saved-here"),
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

  expect(retained.snapshot.deletion?.cause).toBe("deleted");
  expect(retained.snapshot.deletion?.token).toBe(boundOutcome().token);

  // A Y.Doc update can fire before the read-only React render commits. The
  // transport ref closes that gap, so no later update reaches main.
  act(() => {
    editDocument();
  });
  expect(harness.applied).toHaveLength(appliedAtDelete);
  expect(retained.snapshot.deletion?.cause).toBe("deleted");

  harness.emit("error", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.deletion?.cause).toBe("deleted");
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
    expect(retained.snapshot.deletion?.cause).toBe("deleted"),
  );
  expect(drafts.result.current.length).toBe(1);
  expect(drafts.result.current.at(-1)?.text).toContain("seed!");
});

// A reopen in main found another file at this document's path. The text in
// the editor has nowhere left to save, so it is set aside with the cause.
it("sets the text aside when another file takes the document's path", async () => {
  await retainBound();
  act(() => {
    editDocument();
  });

  harness.emitNow("object-changed", 0);

  await waitFor(() => expect(retained.snapshot.deletion?.cause).toBe("object-changed"));
  expect(retained.snapshot.deletion).toMatchObject({ cause: "object-changed" });
  await waitFor(() => expect(drafts.result.current.at(-1)?.text).toBe("seed!"));
  // Nothing may repaint the terminal state.
  harness.emitNow("saved", 1);
  expect(retained.snapshot.deletion?.cause).toBe("object-changed");
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
  expect(retained.snapshot.deletion?.cause).toBe("deleted");
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
  expect(retained.snapshot.saveState.kind).toBe("file-locked");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(retained.snapshot.saveState.kind).toBe("file-locked");

  // The engine's retry lands: the same real report clears it to Saved.
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.saveState.kind).toBe("saved-here");
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
  expect(retained.snapshot.saveState.kind).toBe("saving");

  // A refusal that does cover the newest edit names the blocker.
  await flushLocalBatch();
  const secondSeq = harness.applied.at(-1)!.seq;
  expect(secondSeq).toBeGreaterThan(firstSeq);
  harness.emit("file-locked", secondSeq);
  expect(retained.snapshot.saveState.kind).toBe("file-locked");
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
  expect(retained.snapshot.saveState.kind).toBe("saving");

  // The follow-up settle covers it.
  await flushLocalBatch();
  const secondSeq = harness.applied.at(-1)!.seq;
  expect(secondSeq).toBeGreaterThan(firstSeq);
  harness.emit("saved", secondSeq);
  await waitFor(() =>
    expect(retained.snapshot.saveState.kind).toBe("saved-here"),
  );
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
  act(() => { for (let i = 0; i < 30; i++) editDocument(); });
  expect(notified).not.toHaveBeenCalled();
  await flushLocalBatch();
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(notified).toHaveBeenCalledTimes(1);
  notified.mockClear();
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(notified).not.toHaveBeenCalled();
  unsubscribe();
});

it("keeps generic reasons out of saveError and gives refusal text precedence over capacity", async () => {
  const subscribe = vi.spyOn(harness.api, "onEngineYDocSaveState");
  await retainBound();
  const listener = subscribe.mock.calls[0]![0];
  const sessionId = harness.sessionId()!;
  act(() => listener({ sessionId, workspaceId: "ws-1", path: "notes/a.md", state: { kind: "error", reason: "generic reason", issueId: null }, seq: 0 }));
  expect(retained.snapshot.saveError).toBeNull();
  act(() => listener({ sessionId, workspaceId: "ws-1", path: "notes/a.md", state: { kind: "changed-on-disk", reason: "The file changed on disk.", issueId: null }, seq: 0 }));
  expect(retained.snapshot.saveError).toBeNull();
  act(() => listener({ sessionId, workspaceId: "ws-1", path: "notes/a.md", state: { kind: "error", reason: "generic reason", issueId: "refusal" }, seq: 0,
    authorCapacity: true, editRefusal: { workspaceId: "ws-1", path: "notes/big.md", requestId: "refusal", message: "refusal message" } }));
  expect(retained.snapshot.saveError).toBe("refusal message");
});

it("keeps main's checked save state across a delayed replacement acknowledgement", async () => {
  await retainBound();
  harness.emitLineageReplacement("winner");
  harness.emit("saved", 0);
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
  await waitFor(() => expect(retained.snapshot.saveState.kind).toBe("saved-here"));
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

it("ends clean share access after acknowledged edits without a recovery draft", async () => {
  await retainBound();
  act(() => editDocument());
  await boundOutcome().flushPendingLocalUpdates();
  harness.emit("saved-to-host", harness.applied.at(-1)!.seq);
  harness.emit("read-only", 0);

  expect(retained.snapshot.readOnlyTransition?.token).toBe(boundOutcome().token);
  await waitFor(() => expect(harness.closed).toHaveLength(1));
  expect(drafts.result.current).toHaveLength(0);
});

it("keeps unsent edits in recovery when share access ends", async () => {
  await retainBound();
  act(() => editDocument());
  harness.emit("read-only", 0);

  expect(retained.snapshot.readOnlyTransition?.token).toBe(boundOutcome().token);
  await waitFor(() => expect(drafts.result.current.at(-1)?.text).toBe("seed!"));
  expect(harness.mainText()).toBe("seed");
  expect(drafts.result.current).toHaveLength(1);
});

it("keeps explicitly rejected edits in recovery when share access ends", async () => {
  vi.spyOn(harness.api, "applyEngineYDocUpdate").mockImplementationOnce(async () => {
    throw new EngineYDocDeliveryRefusedError("read-only");
  });
  await retainBound();
  act(() => editDocument());
  await boundOutcome().flushPendingLocalUpdates();

  expect(retained.snapshot.readOnlyTransition?.token).toBe(boundOutcome().token);
  await waitFor(() => expect(drafts.result.current.at(-1)?.text).toBe("seed!"));
  expect(harness.mainText()).toBe("seed");
  expect(drafts.result.current).toHaveLength(1);
});


it("keeps delivered edits awaiting host confirmation in recovery when share access ends", async () => {
  await retainBound();
  act(() => editDocument());
  await boundOutcome().flushPendingLocalUpdates();
  harness.emit("pending-share", harness.applied.at(-1)!.seq);
  harness.emit("read-only", 0);

  await waitFor(() => expect(drafts.result.current.at(-1)?.text).toBe("seed!"));
  expect(drafts.result.current).toHaveLength(1);
});

it("keeps a refused apply report in recovery even after delivery drains", async () => {
  await retainBound();
  act(() => editDocument());
  await boundOutcome().flushPendingLocalUpdates();
  harness.emit("saved-to-host", harness.applied.at(-1)!.seq);
  harness.emit("read-only", harness.applied.at(-1)!.seq);

  await waitFor(() => expect(drafts.result.current.at(-1)?.text).toBe("seed!"));
  expect(drafts.result.current).toHaveLength(1);
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


it("ends clean share access after remote updates without a recovery draft", async () => {
  const remote = vi.spyOn(harness.api, "onEngineYDocRemoteUpdate");
  await retainBound();
  act(() => editDocument());
  await boundOutcome().flushPendingLocalUpdates();
  harness.emit("saved-to-host", harness.applied.at(-1)!.seq);
  act(() => {
    const before = Y.encodeStateVector(harness.sourceDoc);
    harness.sourceDoc.getText("plainText").insert(5, "+remote");
    const event = {
      sessionId: harness.sessionId()!,
      update: Y.encodeStateAsUpdate(harness.sourceDoc, before),
      lineageGeneration: 1,
    };
    remote.mock.calls[0]![0](event);
  });
  expect(retained.boundDoc().getText("plainText").toString()).toBe("seed!+remote");
  harness.emit("read-only", 0);

  await waitFor(() => expect(harness.closed).toHaveLength(1));
  expect(drafts.result.current).toHaveLength(0);
});
