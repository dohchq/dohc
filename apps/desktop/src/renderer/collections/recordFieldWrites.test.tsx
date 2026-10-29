// @vitest-environment jsdom

// The queue's continuity contract, driven through the REAL host and writer
// with a mocked engine-doc session (CollectionPage.test.tsx idiom): a failed
// write keeps the user's accepted value until a retry lands it or the user
// discards it, the failure stays visible and reported with no CollectionPage
// mounted, and an operation guard pauses new acceptance without dropping a
// racing edit.

import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { COPY_FEEDBACK_MS } from "../ui/CopyButton";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import type { CollectionValue } from "@dohc/workspace-contracts";
import type { UseEngineDoc } from "../collab/useEngineDoc";
import type { RecordSourceCheck } from "./recordSourceCheck";
import {
  abandonPendingCollectionFieldWrites,
  advanceCollectionWriteLineage,
  beginCollectionWriteOperation,
  collectionWriteFailures,
  discardCollectionFieldWrite,
  CollectionFieldWriteHost,
  enqueueCollectionFieldWrite,
  FILE_LOCKED_REPORT_MS,
  hasPendingCollectionFieldWrites,
  retainedCollectionFieldWritePaths,
  resetCollectionFieldWritesForTests,
  remapCollectionFieldWritePaths,
  retryCollectionFieldWrite,
  settleCollectionFieldWrites,
  setCollectionFieldWriteAccess,
  useCollectionWritesBlockingAdmission,
  useCollectionWriteStatus,
} from "./recordFieldWrites";
import { beginCollectionLineageOperation } from "./collectionLineageGate";
import { serializeCollectionSchema } from "./schemaAuthoring";

const docMock = vi.hoisted(() => ({
  current: null as UseEngineDoc | ((input: unknown) => UseEngineDoc) | null,
}));
vi.mock("../collab/useEngineDoc", () => ({
  useEngineDoc: (input: unknown): unknown => {
    const current = docMock.current;
    if (current === null) throw new Error("docMock.current unset");
    return typeof current === "function" ? current(input) : current;
  },
}));
// The record's file check runs in a worker; these tests set its answer.
const sourceMock = vi.hoisted(() => ({ current: null as RecordSourceCheck | null }));
vi.mock("./recordSourceCheck", () => ({
  useRecordSourceCheck: (): RecordSourceCheck => sourceMock.current ?? { state: "clear", contentHash: "c".repeat(64) },
}));

function engineDocState(
  partial: Partial<
    Pick<UseEngineDoc, "available" | "opening" | "doc" | "saveState" | "saveError" | "sharedWaiting" | "readOnlyWhileEditing" | "deletedWhileEditing">
  >,
): UseEngineDoc {
  return {
    available: false,
    opening: false,
    doc: null,
    saveState: { kind: "saved-here" },
    saveError: null,
    readOnlyWhileEditing: false,
    deletedWhileEditing: false,
    ...partial,
  } as UseEngineDoc;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  docMock.current = null;
  sourceMock.current = null;
  resetCollectionFieldWritesForTests();
});

const CHANGE = {
  recordId: "rec-1",
  recordPath: "tasks/Plan.md",
  field: "status",
  value: "done",
};

function enqueue(change: Parameters<typeof enqueueCollectionFieldWrite>[2] = CHANGE) {
  let accepted = false;
  act(() => {
    accepted = enqueueCollectionFieldWrite("ws-1", "tasks", change);
  });
  return accepted;
}

it("reports queued and failed paths only for their workspace before Stop and restore", () => {
  enqueue();
  enqueue({...CHANGE, recordPath: "tasks/Second.md", recordId: "rec-2"});
  expect(retainedCollectionFieldWritePaths("ws-1")).toEqual(["tasks/Plan.md", "tasks/Second.md"]);
  expect(retainedCollectionFieldWritePaths("other")).toEqual([]);
  act(() => setCollectionFieldWriteAccess("ws-1", "No connection"));
  expect(collectionWriteFailures()).toHaveLength(2);
  expect(retainedCollectionFieldWritePaths("ws-1")).toEqual(["tasks/Plan.md", "tasks/Second.md"]);
});

/** Walks the mounted head writer through saving → saved so it settles. */
function settleHead(host: ReturnType<typeof render>, doc: Y.Doc) {
  docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saving" } });
  host.rerender(<CollectionFieldWriteHost />);
  docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saved-here" } });
  host.rerender(<CollectionFieldWriteHost />);
}

describe("retained failures", () => {
  it("keeps an older lineage's status reason when share access is refused", () => {
    docMock.current = engineDocState({ available: false });
    render(<CollectionFieldWriteHost />);
    enqueue();
    const status = renderHook(() => useCollectionWriteStatus("ws-1", "tasks"));
    const ownMessage = collectionWriteFailures()[0]!.message;
    const refusal = "This share must be reopened.";
    act(() => setCollectionFieldWriteAccess("ws-1", refusal));
    expect(status.result.current.error).toBe(refusal);
    act(() => advanceCollectionWriteLineage("ws-1"));
    expect(status.result.current.error).toBe(ownMessage);
    expect(screen.getByTestId("collection-write-retry")).toHaveProperty("disabled", true);
  });

  it("does not rerender a collection status for unrelated retained failures or enqueues", () => {
    docMock.current = engineDocState({ available: false });
    render(<CollectionFieldWriteHost />);
    enqueue();
    let renders = 0;
    const status = renderHook(() => {
      renders += 1;
      return useCollectionWriteStatus("ws-1", "tasks");
    });
    const refusal = "This share must be reopened.";
    act(() => setCollectionFieldWriteAccess("ws-1", refusal));
    expect(status.result.current.error).toBe(refusal);
    const before = renders;
    act(() => { enqueueCollectionFieldWrite("ws-1", "other", { ...CHANGE, recordId: "rec-2", recordPath: "other/Else.md" }); });
    expect(renders).toBe(before);
    act(() => { enqueueCollectionFieldWrite("other", "tasks", CHANGE); });
    expect(renders).toBe(before);
    expect(status.result.current.error).toBe(refusal);
  });

  it("keeps writes' own reasons through refusal A, refusal B, and restored access", () => {
    docMock.current = engineDocState({ opening: true });
    render(<CollectionFieldWriteHost />);
    enqueue();
    const original = "This field changed. Copy your value, or retry after restoring the field.";
    act(() => abandonPendingCollectionFieldWrites(original));
    enqueue({ ...CHANGE, field: "priority", value: "high" });
    const refusal = "This share must be reopened.";
    act(() => setCollectionFieldWriteAccess("ws-1", refusal));
    const unsaved = "dohc did not save this change.";
    expect(collectionWriteFailures().map(failure => failure.message)).toEqual([original, unsaved]);
    const rows = screen.getAllByTestId("collection-write-failure");
    expect(rows[0]!.textContent).toContain(refusal);
    expect(rows[1]!.textContent).toContain(refusal);
    expect(screen.getAllByTestId("collection-write-retry").every(button => button.hasAttribute("disabled"))).toBe(true);
    const changedRefusal = "Your access to this share changed.";
    act(() => setCollectionFieldWriteAccess("ws-1", changedRefusal));
    expect(rows.every(row => row.textContent?.includes(changedRefusal))).toBe(true);
    expect(collectionWriteFailures().map(failure => failure.message)).toEqual([original, unsaved]);
    act(() => setCollectionFieldWriteAccess("ws-1", null));
    expect(collectionWriteFailures().map(failure => failure.message)).toEqual([original, unsaved]);
    expect(rows[0]!.textContent).toContain(original);
    expect(rows[0]!.textContent).not.toContain(refusal);
    expect(rows[1]!.textContent).not.toContain(refusal);
    expect(rows[1]!.textContent).not.toContain(changedRefusal);
    expect(rows[1]!.textContent).toContain(unsaved);
    expect(screen.getAllByTestId("collection-write-retry").every(button => !button.hasAttribute("disabled"))).toBe(true);
  });

  it("leaves another workspace's retained row untouched when a refusal clears", () => {
    docMock.current = engineDocState({ opening: true });
    render(<CollectionFieldWriteHost />);
    const refusal = "This share must be reopened.";
    act(() => {
      setCollectionFieldWriteAccess("other", refusal);
      enqueueCollectionFieldWrite("other", "tasks", { ...CHANGE, recordPath: "tasks/Other.md" });
      setCollectionFieldWriteAccess("ws-1", refusal);
    });
    expect(enqueue()).toBe(false);
    const otherFailure = collectionWriteFailures()[0]!;
    expect(otherFailure.message).toBe("dohc did not save this change.");
    const rows = screen.getAllByTestId("collection-write-failure");
    act(() => setCollectionFieldWriteAccess("ws-1", null));
    expect(collectionWriteFailures()[0]).toBe(otherFailure);
    expect(rows[0]!.textContent).toContain(refusal);
    expect(rows[1]!.textContent).not.toContain(refusal);
    expect(screen.getAllByTestId("collection-write-retry").map(button => button.hasAttribute("disabled"))).toEqual([true, false]);
  });

  it("keeps an applied but refused field value with the confirmed access explanation", () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", CHANGE.recordId);
    docMock.current = engineDocState({ available: true, doc });
    const host = render(<CollectionFieldWriteHost />);
    try {
      enqueue();
      const message = "Your access to this share ended.";
      act(() => setCollectionFieldWriteAccess("ws-1", message));
      expect(collectionWriteFailures()).toHaveLength(0);
      docMock.current = engineDocState({ available: true, doc, saveState: { kind: "unknown" }, readOnlyWhileEditing: true, saveError: "forbidden" });
      host.rerender(<CollectionFieldWriteHost />);
      const ownMessage = "dohc did not save this change. forbidden";
      expect(collectionWriteFailures()[0]).toMatchObject({ message: ownMessage, change: CHANGE });
      expect(screen.getByTestId("collection-write-failure").textContent).toContain(message);
      expect(screen.getByTestId("collection-write-retry").hasAttribute("disabled")).toBe(true);
      act(() => setCollectionFieldWriteAccess("ws-1", null));
      expect(screen.getByTestId("collection-write-failure").textContent).toContain(ownMessage);
      expect(screen.getByTestId("collection-write-failure").textContent).not.toContain(message);
    } finally { host.unmount(); doc.destroy(); }
  });
  it.each(["ended", "changed"])("retains waiting edits and refuses retries after access %s", access => {
    docMock.current = engineDocState({ sharedWaiting: { state: "pending", message: "Waiting to send" } });
    const host = render(<CollectionFieldWriteHost />);
    enqueue();
    const message = `Your access to this share ${access}.`;
    act(() => setCollectionFieldWriteAccess("ws-1", message));
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    const failure = collectionWriteFailures()[0]!;
    expect(failure.change).toEqual(CHANGE);
    expect(failure.message).toBe("dohc did not save this change.");
    expect(screen.getByTestId("collection-write-failure").textContent).toContain(message);
    expect(screen.getByTestId("collection-write-retry").hasAttribute("disabled")).toBe(true);
    const doc = new Y.Doc();
    try {
      doc.getMap("frontmatter").set("id", CHANGE.recordId);
      docMock.current = engineDocState({ available: true, doc });
      act(() => retryCollectionFieldWrite(failure.id));
      host.rerender(<CollectionFieldWriteHost />);
      expect(doc.getMap("frontmatter").get("status")).toBeUndefined();
      expect(enqueue()).toBe(false);
      expect(collectionWriteFailures()).toHaveLength(2);
      // The restriction belongs only to the received workspace.
      expect(enqueueCollectionFieldWrite("other", "tasks", CHANGE)).toBe(true);
    } finally { host.unmount(); doc.destroy(); }
  });

  it("keeps a field edit waiting and applies it when this record becomes editable", () => {
    const message = "Record saved on this device. Waiting to send.";
    docMock.current = engineDocState({ sharedWaiting: {state: "pending", message} });
    const host = render(<CollectionFieldWriteHost />);
    const status = renderHook(() => useCollectionWriteStatus("ws-1", "tasks"));
    enqueue();
    expect(collectionWriteFailures()).toEqual([]);
    expect(hasPendingCollectionFieldWrites()).toBe(true);
    expect(status.result.current.waiting).toBe(message);
    const doc = new Y.Doc();
    try {
      doc.getMap("frontmatter").set("id", CHANGE.recordId);
      docMock.current = engineDocState({available: true, doc});
      host.rerender(<CollectionFieldWriteHost />);
      expect(doc.getMap("frontmatter").get("status")).toBe("done");
      expect(status.result.current.waiting).toBeNull();
      settleHead(host, doc);
      expect(hasPendingCollectionFieldWrites()).toBe(false);
    } finally { host.unmount(); doc.destroy(); }
  });
  it.each([
    '&root {id: rec-1, status: draft, score: .nan}',
    '!!map &root {id: rec-1, status: draft, score: .nan}',
    ': note\nid: rec-1\nstatus: draft\nscore: .nan',
    'id: rec-1\nstatus: &v .nan\nscore: *v',
    'id: rec-1\nstatus: &v .nan\nscore: {nested: [*v]}',
  ])("refuses a field write before changing the document: %s", yaml => {
    const markdown = `---\n${yaml}\n---\n\nBody`;
    const doc = markdownToYDoc(markdown);
    const before = Y.encodeStateAsUpdate(doc);
    try {
      docMock.current = engineDocState({ available: true, doc });
      const host = render(<CollectionFieldWriteHost />);
      enqueue();
      expect(collectionWriteFailures()[0]?.message).toContain("without rewriting the others");
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect(yDocToMarkdown(doc)).toBe(markdown);
      host.unmount();
    } finally { doc.destroy(); }
  });

  const LOSSY_RECORD =
    "dohc did not save this change because it would rewrite parts of this record dohc can't show. Open the record to edit it externally.";
  const sessionsOpened = (enabled: boolean[], state: UseEngineDoc) => (input: unknown) => {
    enabled.push((input as { enabled: boolean }).enabled);
    return state;
  };

  it("refuses a field write to a lossy note before opening its session", () => {
    sourceMock.current = { state: "lossy" };
    const enabled: boolean[] = [];
    docMock.current = sessionsOpened(enabled, engineDocState({}));
    render(<CollectionFieldWriteHost />);
    enqueue();
    expect(collectionWriteFailures()[0]?.message).toBe(LOSSY_RECORD);
    expect(enabled).not.toContain(true);
  });

  it("refuses a field write when its record can't be read to check, and opens no session", () => {
    sourceMock.current = { state: "unreadable" };
    const enabled: boolean[] = [];
    docMock.current = sessionsOpened(enabled, engineDocState({}));
    render(<CollectionFieldWriteHost />);
    enqueue();
    expect(collectionWriteFailures()[0]?.message).toBe(
      "dohc did not save this change because it could not read this record to check it. Try again.",
    );
    expect(enabled).not.toContain(true);
  });

  it("keeps a field edit queued while its record is checked, then opens its session and applies it", () => {
    sourceMock.current = { state: "checking" };
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", CHANGE.recordId);
    const enabled: boolean[] = [];
    docMock.current = (input: unknown) => {
      const on = (input as { enabled: boolean }).enabled;
      enabled.push(on);
      return on ? engineDocState({ available: true, doc }) : engineDocState({});
    };
    const host = render(<CollectionFieldWriteHost />);
    try {
      enqueue();
      expect(collectionWriteFailures()).toEqual([]);
      expect(hasPendingCollectionFieldWrites()).toBe(true);
      expect(enabled).not.toContain(true);
      expect(doc.getMap("frontmatter").get("status")).toBeUndefined();

      sourceMock.current = null;
      host.rerender(<CollectionFieldWriteHost />);
      expect(doc.getMap("frontmatter").get("status")).toBe("done");
      settleHead(host, doc);
      expect(hasPendingCollectionFieldWrites()).toBe(false);
    } finally { host.unmount(); doc.destroy(); }
  });

  it("refuses a field write when its session holds a lossy note other than the bytes it checked", async () => {
    const markdown = "---\nid: rec-1\nstatus: draft\n---\n\n<details>\n\nHidden.\n</details>\n";
    // The record's live document as the desktop seeds it, with a witness of
    // a file that changed after the check read it.
    const doc = markdownToYDoc(markdown);
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    doc.getMap("meta").set("dohcMarkdownSource", markdown);
    doc.getMap("meta").set("dohcMarkdownSourceSha256", sha(markdown));
    doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(doc)));
    const before = Y.encodeStateAsUpdate(doc);
    try {
      docMock.current = engineDocState({ available: true, doc });
      const host = render(<CollectionFieldWriteHost />);
      enqueue();
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      await waitFor(() => expect(collectionWriteFailures()[0]?.message).toBe(LOSSY_RECORD));
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      host.unmount();
    } finally { doc.destroy(); }
  });

  it.each<{ name: string; base: CollectionValue; current: CollectionValue | undefined }>([
    { name: "scalar", base: "alpha", current: "alpha" },
    { name: "duplicate list", base: ["alpha", "alpha"], current: ["alpha", "alpha"] },
    { name: "nested list", base: [["alpha", null]], current: [["alpha", null]] },
    { name: "mapping", base: { choices: ["alpha", { enabled: true }], count: 2 }, current: { count: 2, choices: ["alpha", { enabled: true }] } },
    { name: "missing value", base: null, current: undefined },
    { name: "empty selection", base: [], current: null },
    { name: "reordered valid selection", base: ["alpha", "beta"], current: ["beta", "alpha"] },
  ])("retries a repair over an unchanged $name", ({ base, current }) => {
    docMock.current = engineDocState({ available: false });
    const host = render(<CollectionFieldWriteHost />);
    const value = ["gamma"];
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", { ...CHANGE, field: "tags", value, previousValues: [base] }); });
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    if (current !== undefined) doc.getMap("frontmatter").set("tags", current);
    docMock.current = engineDocState({ available: true, doc });
    act(() => retryCollectionFieldWrite(collectionWriteFailures()[0]!.id));
    expect(doc.getMap("frontmatter").get("tags")).toEqual(value);
    settleHead(host, doc);
    expect(collectionWriteFailures()).toEqual([]);
  });

  it.each<{ name: string; base: CollectionValue; current: CollectionValue }>([
    { name: "scalar", base: "alpha", current: "beta" },
    { name: "duplicate list", base: ["alpha", "alpha"], current: ["alpha", "beta"] },
    { name: "nested list", base: [["alpha", null]], current: [["alpha", "beta"]] },
    { name: "mapping", base: { choices: ["alpha", { enabled: true }] }, current: { choices: ["alpha", { enabled: false }] } },
  ])("retains a repair for copying after its flagged $name changes", ({ base, current }) => {
    docMock.current = engineDocState({ available: false });
    render(<CollectionFieldWriteHost />);
    const value = ["gamma"];
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", { ...CHANGE, field: "tags", value, previousValues: [base] }); });
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    doc.getMap("frontmatter").set("tags", current);
    docMock.current = engineDocState({ available: true, doc });
    act(() => retryCollectionFieldWrite(collectionWriteFailures()[0]!.id));
    expect(doc.getMap("frontmatter").get("tags")).toEqual(current);
    expect(collectionWriteFailures()[0]).toMatchObject({ recoveryOnly: true, change: { value } });
  });

  it("allows a retry whose desired flagged value is already present", () => {
    docMock.current = engineDocState({ available: false });
    const host = render(<CollectionFieldWriteHost />);
    const value = ["alpha", "alpha", "gamma"];
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", { ...CHANGE, field: "tags", value, previousValues: [["alpha", "alpha"]] }); });
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    doc.getMap("frontmatter").set("tags", [...value]);
    docMock.current = engineDocState({ available: true, doc });
    act(() => retryCollectionFieldWrite(collectionWriteFailures()[0]!.id));
    settleHead(host, doc);
    expect(collectionWriteFailures()).toEqual([]);
    expect(doc.getMap("frontmatter").get("tags")).toEqual(value);
  });

  it.each(["addition", "removal", "duplicate"] as const)("keeps a retry copy-only after a collaborator's %s", (operation) => {
    docMock.current = engineDocState({ available: false });
    const host = render(<CollectionFieldWriteHost />);
    const base = ["alpha", "beta"];
    const value = [...base, "gamma"];
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", { ...CHANGE, field: "tags", value, previousValues: [base] }); });
    const failure = collectionWriteFailures()[0]!;
    const doc = new Y.Doc();
    const remote = operation === "addition" ? [...base, "delta"] : operation === "removal" ? ["beta"] : ["alpha", "alpha"];
    doc.getMap("frontmatter").set("id", "rec-1");
    doc.getMap("frontmatter").set("tags", remote);
    docMock.current = engineDocState({ available: true, doc });
    act(() => retryCollectionFieldWrite(failure.id));
    expect(doc.getMap("frontmatter").get("tags")).toEqual(remote);
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(collectionWriteFailures()[0]).toMatchObject({ recoveryOnly: true, change: { value } });
    expect(screen.getByTestId("collection-write-retry")).toHaveProperty("disabled", true);
    act(() => retryCollectionFieldWrite(collectionWriteFailures()[0]!.id));
    expect(doc.getMap("frontmatter").get("tags")).toEqual(remote);
    host.unmount();
  });

  it.each(["base", "already-applied"] as const)("retries a selection against its %s value", (current) => {
    docMock.current = engineDocState({ available: false });
    const host = render(<CollectionFieldWriteHost />);
    const value = ["alpha", "gamma"];
    const onDiscarded = vi.fn();
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", { ...CHANGE, field: "tags", value, previousValues: [["alpha"]] },
      undefined, undefined, undefined, onDiscarded); });
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    doc.getMap("frontmatter").set("tags", current === "base" ? ["alpha"] : value);
    docMock.current = engineDocState({ available: true, doc });
    act(() => retryCollectionFieldWrite(collectionWriteFailures()[0]!.id));
    expect(doc.getMap("frontmatter").get("tags")).toEqual(value);
    settleHead(host, doc);
    expect(collectionWriteFailures()).toEqual([]);
    expect(onDiscarded).not.toHaveBeenCalled();
  });

  it("preserves exact discard notification through a failed Retry without reporting an index commit", () => {
    docMock.current = engineDocState({ available: false });
    render(<CollectionFieldWriteHost />);
    const onDiscarded = vi.fn();
    const onIndexed = vi.fn();
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE,
      undefined, undefined, onIndexed, onDiscarded); });
    act(() => retryCollectionFieldWrite(collectionWriteFailures()[0]!.id));
    expect(onDiscarded).not.toHaveBeenCalled();
    const failureId = collectionWriteFailures()[0]!.id;
    act(() => { discardCollectionFieldWrite(failureId); discardCollectionFieldWrite(failureId); });
    expect(onDiscarded).toHaveBeenCalledOnce();
    expect(onIndexed).not.toHaveBeenCalled();
  });

  // The host sits outside every notice owner, and Discard cannot be undone,
  // so a refused copy keeps saying how to copy by hand until the next copy.
  it("keeps the instruction for a refused copy past the copy's own feedback", async () => {
    docMock.current = engineDocState({ available: false });
    render(<CollectionFieldWriteHost />);
    enqueue({ ...CHANGE, value: "Keep me." });
    const writeText = vi.fn(async (_text: string): Promise<void> => {
      throw new Error("Document is not focused.");
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    fireEvent.click(screen.getByTestId("collection-write-copy"));
    expect((await screen.findByTestId("collection-write-copy-refused")).textContent).toBe(
      "Could not copy. Select the value above to copy it.",
    );
    // The button's own "Couldn't copy" lasts COPY_FEEDBACK_MS; the line stays.
    await waitFor(() => expect(screen.getByTestId("collection-write-copy").textContent).toBe("Copy value"), {
      timeout: COPY_FEEDBACK_MS * 3,
    });
    expect(screen.getByTestId("collection-write-copy-refused")).toBeTruthy();

    writeText.mockImplementationOnce(async () => undefined);
    fireEvent.click(screen.getByTestId("collection-write-copy"));
    expect(screen.queryByTestId("collection-write-copy-refused")).toBeNull();
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Keep me."));
  });

  it("exposes the exact retained input for copying when its record cannot open", async () => {
    docMock.current = engineDocState({ available: false });
    render(<CollectionFieldWriteHost />);
    const value = "  Keep this exact input.\nWith another line.  ";
    enqueue({ ...CHANGE, value });
    expect(collectionWriteFailures()[0]?.superseded).toBe(false);
    expect(screen.getByLabelText("Unsaved collection value")).toHaveProperty("value", value);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    fireEvent.click(screen.getByTestId("collection-write-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(value));
    expect(collectionWriteFailures()[0]?.change.value).toBe(value);
  });

  it("does not replay a failed full-array edit over a newer saved selection", async () => {
    docMock.current = engineDocState({ available: false });
    const host = render(<CollectionFieldWriteHost />);
    const earlier = { ...CHANGE, field: "tags", value: ["alpha"] };
    enqueue(earlier);
    const failure = collectionWriteFailures()[0]!;
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    enqueue({ ...earlier, value: ["alpha", "beta"] });
    settleHead(host, doc);
    act(() => retryCollectionFieldWrite(failure.id));
    expect(doc.getMap("frontmatter").get("tags")).toEqual(["alpha", "beta"]);
    expect(collectionWriteFailures()[0]?.change.value).toEqual(["alpha"]);
    expect(screen.getByTestId("collection-write-retry")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Unsaved collection value")).toHaveProperty("value", '[\n  "alpha"\n]');
    expect(screen.getByText("Discard removes the input kept here. You cannot undo this.")).toBeTruthy();
  });

  it("marks the older failure when the newer same-field input was already queued", () => {
    docMock.current = engineDocState({ opening: true });
    const host = render(<CollectionFieldWriteHost />);
    enqueue();
    enqueue({ ...CHANGE, value: "newer" });
    docMock.current = engineDocState({ available: false });
    host.rerender(<CollectionFieldWriteHost />);
    expect(collectionWriteFailures().map((failure) => failure.superseded)).toEqual([true, false]);
    expect(collectionWriteFailures().map((failure) => failure.change.value)).toEqual(["done", "newer"]);
  });

  it("does not supersede a failed edit when a different field changes", () => {
    docMock.current = engineDocState({ available: false });
    render(<CollectionFieldWriteHost />);
    enqueue();
    enqueue({ ...CHANGE, field: "title", value: "newer" });
    expect(collectionWriteFailures().every((failure) => !failure.superseded)).toBe(true);
  });

  it("keeps the original value when the session cannot open, and shows it with no page mounted", async () => {
    docMock.current = engineDocState({ available: false });
    render(<CollectionFieldWriteHost />);
    enqueue();

    // The write left the queue but not the app: value retained whole.
    await waitFor(() => expect(collectionWriteFailures()).toHaveLength(1));
    expect(collectionWriteFailures()[0]?.change).toEqual(CHANGE);
    expect(hasPendingCollectionFieldWrites()).toBe(false);

    // Actionable with only the host mounted — no CollectionPage anywhere.
    screen.getByTestId("collection-write-failures");
    // The host's region comes first; the copy control has its own.
    expect(screen.getAllByRole("status")[0]!.textContent).toContain("1 unsaved collection change needs attention.");
    screen.getByTestId("collection-write-retry");
    expect(
      screen.getByTestId("collection-write-discard").textContent,
    ).toBe("Discard unsaved change");
  });

  it("lands the original value on retry and clears the failure", async () => {
    docMock.current = engineDocState({ available: false });
    const host = render(<CollectionFieldWriteHost />);
    enqueue();
    await screen.findByTestId("collection-write-retry");

    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    fireEvent.click(screen.getByTestId("collection-write-retry"));

    // Retry replays the exact accepted value through the record's doc.
    await waitFor(() =>
      expect(doc.getMap("frontmatter").get("status")).toBe("done"),
    );
    expect(collectionWriteFailures()).toHaveLength(0);
    expect(screen.queryByTestId("collection-write-failures")).toBeNull();

    settleHead(host, doc);
    expect(hasPendingCollectionFieldWrites()).toBe(false);
  });

  it("drops the value only on explicit discard", async () => {
    docMock.current = engineDocState({ available: false });
    render(<CollectionFieldWriteHost />);
    enqueue();
    await screen.findByTestId("collection-write-discard");

    fireEvent.click(screen.getByTestId("collection-write-discard"));
    expect(collectionWriteFailures()).toHaveLength(0);
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(screen.queryByTestId("collection-write-failures")).toBeNull();
  });

  it("keeps the file-locked retry status when access is refused before or after its report", async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const host = render(<CollectionFieldWriteHost />);
    const status = renderHook(() => useCollectionWriteStatus("ws-1", "tasks"));
    try {
      enqueue();
      act(() => setCollectionFieldWriteAccess("ws-1", "This share must be reopened."));
      docMock.current = engineDocState({ available: true, doc, saveState: { kind: "file-locked", reason: "test failure", issueId: null } });
      host.rerender(<CollectionFieldWriteHost />);
      await act(() => vi.advanceTimersByTimeAsync(FILE_LOCKED_REPORT_MS));
      const message = "Another program has Plan.md open, so dohc can't update it on disk. This change is saved and dohc retries until the file is free.";
      expect(collectionWriteFailures()).toEqual([]);
      expect(hasPendingCollectionFieldWrites()).toBe(false);
      expect(status.result.current.error).toBe(message);
      act(() => setCollectionFieldWriteAccess("ws-1", "Your access to this share changed."));
      expect(status.result.current.error).toBe(message);
      act(() => setCollectionFieldWriteAccess("ws-1", null));
      expect(status.result.current.error).toBe(message);
    } finally { status.unmount(); host.unmount(); doc.destroy(); }
  });

  it("does not retry into a replacement record at the old path", async () => {
    docMock.current = engineDocState({ available: false });
    render(<CollectionFieldWriteHost />);
    enqueue();
    await screen.findByTestId("collection-write-retry");

    const replacement = new Y.Doc();
    replacement.getMap("frontmatter").set("id", "rec-replacement");
    replacement.getMap("frontmatter").set("status", "new");
    docMock.current = engineDocState({ available: true, doc: replacement });
    fireEvent.click(screen.getByTestId("collection-write-retry"));

    expect(replacement.getMap("frontmatter").get("status")).toBe("new");
    expect(collectionWriteFailures()[0]?.change).toEqual(CHANGE);
  });

  it("does not retain a file-locked hold: the engine owns that write durably", async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({
      available: true,
      doc,
      saveState: { kind: "file-locked", reason: "test failure", issueId: null },
    });
    render(<CollectionFieldWriteHost />);
    enqueue();

    await act(() => vi.advanceTimersByTimeAsync(FILE_LOCKED_REPORT_MS));
    // Completed, not failed: no retry offer for a write that is not lost.
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(collectionWriteFailures()).toHaveLength(0);
    expect(screen.queryByTestId("collection-write-failures")).toBeNull();
  });
});

describe("collection index acknowledgements", () => {
  it("acknowledges a saved edit once, after the actual save result", () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const host = render(<CollectionFieldWriteHost />);
    const onIndexed = vi.fn();
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE, undefined, undefined, onIndexed); });
    expect(onIndexed).not.toHaveBeenCalled();
    settleHead(host, doc);
    host.rerender(<CollectionFieldWriteHost />);
    expect(onIndexed).toHaveBeenCalledOnce();
  });

  it.each(["retry", "discard"] as const)("does not acknowledge failed input before %s", (action) => {
    docMock.current = engineDocState({ available: false });
    const host = render(<CollectionFieldWriteHost />);
    const onIndexed = vi.fn();
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE, undefined, undefined, onIndexed); });
    expect(onIndexed).not.toHaveBeenCalled();
    const failure = collectionWriteFailures()[0]!;
    if (action === "discard") {
      act(() => discardCollectionFieldWrite(failure.id));
      expect(onIndexed).not.toHaveBeenCalled();
    } else {
      const doc = new Y.Doc();
      doc.getMap("frontmatter").set("id", "rec-1");
      docMock.current = engineDocState({ available: true, doc });
      act(() => retryCollectionFieldWrite(failure.id));
      expect(onIndexed).not.toHaveBeenCalled();
      settleHead(host, doc);
      expect(onIndexed).toHaveBeenCalledOnce();
    }
  });

  it("acknowledges a durably held file-lock edit once", async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "file-locked", reason: "test failure", issueId: null } });
    render(<CollectionFieldWriteHost />);
    const onIndexed = vi.fn();
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE, undefined, undefined, onIndexed); });
    expect(onIndexed).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(FILE_LOCKED_REPORT_MS * 2); });
    expect(onIndexed).toHaveBeenCalledOnce();
    expect(collectionWriteFailures()).toHaveLength(0);
  });
});

describe("settleCollectionFieldWrites", () => {
  it("reports a failure from before the wait, and a second wait still reports it", async () => {
    docMock.current = engineDocState({ available: false });
    render(<CollectionFieldWriteHost />);
    enqueue();
    await waitFor(() => expect(collectionWriteFailures()).toHaveLength(1));

    // The queue is already empty; the unresolved failure must still count.
    await expect(settleCollectionFieldWrites()).resolves.toEqual({
      failed: 1,
      stalled: false,
    });
    // A second boundary (a second close attempt) must not forget it.
    await expect(settleCollectionFieldWrites()).resolves.toEqual({
      failed: 1,
      stalled: false,
    });
  });

  it("resolves a wait in flight when the head fails, counting it", async () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const host = render(<CollectionFieldWriteHost />);
    enqueue();
    const wait = settleCollectionFieldWrites();

    docMock.current = engineDocState({
      available: true,
      doc,
      saveState: { kind: "unknown" }, readOnlyWhileEditing: true,
      saveError: "This workspace is read-only.",
    });
    act(() => host.rerender(<CollectionFieldWriteHost />));
    await expect(wait).resolves.toEqual({ failed: 1, stalled: false });
  });
});

describe("beginCollectionWriteOperation", () => {
  it("keeps older paused input copy-only after retrying and saving the newer input", () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const host = render(<CollectionFieldWriteHost />);
    let guard!: ReturnType<typeof beginCollectionWriteOperation>;
    act(() => { guard = beginCollectionWriteOperation("ws-1"); });
    enqueue({ ...CHANGE, field: "tags", value: ["alpha"] });
    enqueue({ ...CHANGE, field: "tags", value: ["alpha", "beta"] });
    const [older, newer] = collectionWriteFailures();
    expect(older?.superseded).toBe(true);
    act(() => { guard.release(); retryCollectionFieldWrite(newer!.id); });
    settleHead(host, doc);
    act(() => retryCollectionFieldWrite(older!.id));
    expect(doc.getMap("frontmatter").get("tags")).toEqual(["alpha", "beta"]);
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(collectionWriteFailures()[0]?.change.value).toEqual(["alpha"]);
    expect(screen.getByTestId("collection-write-retry")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("collection-write-copy")).toBeTruthy();
    expect(screen.getByLabelText("Unsaved collection value")).toHaveProperty("value", '[\n  "alpha"\n]');
  });

  it("does not supersede current-lineage input with a delayed callback from an older lineage", () => {
    docMock.current = engineDocState({ available: false });
    const host = render(<CollectionFieldWriteHost />);
    act(() => advanceCollectionWriteLineage("ws-1"));
    enqueue({ ...CHANGE, value: "current" });
    const current = collectionWriteFailures()[0]!;
    act(() => {
      enqueueCollectionFieldWrite("ws-1", "tasks", { ...CHANGE, value: "old" }, undefined, 0);
    });
    expect(collectionWriteFailures().find((failure) => failure.id === current.id)?.superseded).toBe(false);
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    act(() => retryCollectionFieldWrite(current.id));
    settleHead(host, doc);
    expect(doc.getMap("frontmatter").get("status")).toBe("current");
    expect(collectionWriteFailures()[0]?.change.value).toBe("old");
  });

  it("rejects a failure arriving while the initial draft flush is pending", async () => {
    let finishFlush!: () => void;
    const flush = new Promise<void>((resolve) => { finishFlush = resolve; });
    const beginning = beginCollectionLineageOperation("ws-1", () => flush);
    expect(enqueue()).toBe(false);
    finishFlush();
    await expect(beginning).rejects.toThrow("A collection change did not save");
    expect(collectionWriteFailures()[0]?.change).toEqual(CHANGE);
  });

  it("retains late input for copying instead of retrying into a changed lineage", async () => {
    const original = new Y.Doc();
    original.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc: original });
    render(<CollectionFieldWriteHost />);
    let release!: () => void;
    await act(async () => { release = await beginCollectionLineageOperation("ws-1"); });
    // The actual version IPC is now in flight, beyond the preflight check.
    expect(enqueue()).toBe(false);
    const nextVersion = new Y.Doc();
    nextVersion.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc: nextVersion });
    act(() => { advanceCollectionWriteLineage("ws-1"); release(); });
    const failure = collectionWriteFailures()[0]!;
    act(() => retryCollectionFieldWrite(failure.id));
    expect(nextVersion.getMap("frontmatter").has("status")).toBe(false);
    expect(collectionWriteFailures()[0]?.change).toEqual(CHANGE);
    expect(screen.getByTestId("collection-write-retry")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Unsaved collection value")).toHaveProperty("value", "done");
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    fireEvent.click(screen.getByTestId("collection-write-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("done"));
    fireEvent.click(screen.getByTestId("collection-write-discard"));
    expect(collectionWriteFailures()).toHaveLength(0);
  });

  it("refuses an old view's callback even after the operation released its pause", () => {
    advanceCollectionWriteLineage("ws-1");
    expect(enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE, undefined, 0)).toBe(false);
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(collectionWriteFailures()[0]?.change).toEqual(CHANGE);
  });

  it("refuses a stale-path edit while paused, retains it, and accepts a retry after release", async () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const host = render(<CollectionFieldWriteHost />);

    let guard!: ReturnType<typeof beginCollectionWriteOperation>;
    act(() => {
      guard = beginCollectionWriteOperation("ws-1");
    });
    // Nothing queued and nothing failed when the operation began.
    await expect(guard.settled).resolves.toEqual({ failed: 0, stalled: false });

    // An edit racing the pause is not accepted into the queue and not lost.
    expect(enqueue()).toBe(false);
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(collectionWriteFailures()).toHaveLength(1);
    expect(collectionWriteFailures()[0]?.change).toEqual(CHANGE);
    expect(doc.getMap("frontmatter").has("status")).toBe(false);

    // Retry waits out the pause: the value stays retained, nothing writes.
    const failureId = collectionWriteFailures()[0]!.id;
    act(() => retryCollectionFieldWrite(failureId));
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(collectionWriteFailures()).toHaveLength(1);
    expect(screen.getByTestId("collection-write-retry")).toHaveProperty(
      "disabled",
      true,
    );

    act(() => guard.release());
    fireEvent.click(screen.getByTestId("collection-write-retry"));
    await waitFor(() =>
      expect(doc.getMap("frontmatter").get("status")).toBe("done"),
    );
    expect(collectionWriteFailures()).toHaveLength(0);
    settleHead(host, doc);
    expect(hasPendingCollectionFieldWrites()).toBe(false);
  });

  it("refuses an option edit while paused without starting its schema write", () => {
    // The schema bridge must stay silent: a refused edit may not begin IPC.
    const readWorkspaceText = vi.fn();
    const writeWorkspaceText = vi.fn();
    vi.stubGlobal("dohcDesktop", { readWorkspaceText, writeWorkspaceText });
    docMock.current = engineDocState({ available: false });
    render(<CollectionFieldWriteHost />);
    let guard!: ReturnType<typeof beginCollectionWriteOperation>;
    act(() => {
      guard = beginCollectionWriteOperation("ws-1");
    });

    let accepted = true;
    act(() => {
      accepted = enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE, "done");
    });
    expect(accepted).toBe(false);
    expect(readWorkspaceText).not.toHaveBeenCalled();
    expect(writeWorkspaceText).not.toHaveBeenCalled();
    // The option rides the retained edit, so the retry after release can
    // still create it in the schema.
    expect(collectionWriteFailures()[0]?.createOption).toBe("done");
    act(() => guard.release());
  });

  it("settles input queued before the pause and reports when it lands", async () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const host = render(<CollectionFieldWriteHost />);
    enqueue();
    expect(doc.getMap("frontmatter").get("status")).toBe("done");

    let guard!: ReturnType<typeof beginCollectionWriteOperation>;
    act(() => {
      guard = beginCollectionWriteOperation("ws-1");
    });
    // The queued head keeps settling under the pause; only NEW edits wait.
    settleHead(host, doc);
    await expect(guard.settled).resolves.toEqual({ failed: 0, stalled: false });
    act(() => guard.release());
  });

  it("reports a failure retained before the operation began", async () => {
    docMock.current = engineDocState({ available: false });
    render(<CollectionFieldWriteHost />);
    enqueue();
    await waitFor(() => expect(collectionWriteFailures()).toHaveLength(1));

    let guard!: ReturnType<typeof beginCollectionWriteOperation>;
    act(() => {
      guard = beginCollectionWriteOperation("ws-1");
    });
    await expect(guard.settled).resolves.toEqual({ failed: 1, stalled: false });
    act(() => guard.release());
  });
});

describe("abandoned schema preparation", () => {
  const read = {
    text: serializeCollectionSchema({ name: null, description: null, fields: [{ name: "status", type: "select", options: [] }], views: [] }),
    truncated: false,
    contentHash: "same-schema-in-both-versions",
  };

  it.each(["initial", "retry"] as const)("does not prepare an %s option write after the selection changes during the schema read", async (attempt) => {
    let finishRead!: (value: typeof read) => void;
    const readWorkspaceText = vi.fn(() => new Promise<typeof read>((resolve) => { finishRead = resolve; }));
    const writeWorkspaceText = vi.fn(async () => ({ status: "written" }));
    vi.stubGlobal("dohcDesktop", { readWorkspaceText, writeWorkspaceText });
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    doc.getMap("frontmatter").set("tags", ["alpha"]);
    docMock.current = engineDocState({ available: attempt === "initial", doc });
    render(<CollectionFieldWriteHost />);
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", {
      ...CHANGE, field: "tags", value: ["alpha", "gamma"], previousValues: [["alpha"]],
    }, "gamma"); });
    if (attempt === "retry") {
      docMock.current = engineDocState({ available: true, doc });
      act(() => retryCollectionFieldWrite(collectionWriteFailures()[0]!.id));
    }
    expect(readWorkspaceText).toHaveBeenCalledOnce();
    doc.getMap("frontmatter").set("tags", ["alpha", "beta"]);
    await act(async () => finishRead({ ...read, text: serializeCollectionSchema({
      name: null, description: null,
      fields: [{ name: "tags", type: "multi-select", options: ["alpha", "beta"] }], views: [],
    }) }));
    expect(writeWorkspaceText).not.toHaveBeenCalled();
    expect(doc.getMap("frontmatter").get("tags")).toEqual(["alpha", "beta"]);
    expect(collectionWriteFailures()[0]).toMatchObject({ recoveryOnly: true, createOption: "gamma" });
  });

  it("retains an initial option value when the selection changes during the schema write", async () => {
    let finishWrite!: (value: { status: "written" }) => void;
    const writeWorkspaceText = vi.fn(() => new Promise<{ status: "written" }>((resolve) => { finishWrite = resolve; }));
    vi.stubGlobal("dohcDesktop", {
      readWorkspaceText: vi.fn(async () => ({ ...read, text: serializeCollectionSchema({
        name: null, description: null,
        fields: [{ name: "tags", type: "multi-select", options: ["alpha", "beta"] }], views: [],
      }) })),
      writeWorkspaceText,
    });
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    doc.getMap("frontmatter").set("tags", ["alpha"]);
    docMock.current = engineDocState({ available: true, doc });
    render(<CollectionFieldWriteHost />);
    const value = ["alpha", "gamma"];
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", {
      ...CHANGE, field: "tags", value, previousValues: [["alpha"]],
    }, "gamma"); });
    await waitFor(() => expect(writeWorkspaceText).toHaveBeenCalledOnce());
    doc.getMap("frontmatter").set("tags", ["alpha", "beta"]);
    await act(async () => finishWrite({ status: "written" }));
    expect(doc.getMap("frontmatter").get("tags")).toEqual(["alpha", "beta"]);
    expect(collectionWriteFailures()[0]).toMatchObject({ recoveryOnly: true, createOption: undefined, change: { value } });
  });

  it("keeps a changed selection recovery-only through refusal changes and restored access", () => {
    docMock.current = engineDocState({ opening: true });
    const host = render(<CollectionFieldWriteHost />);
    const status = renderHook(() => useCollectionWriteStatus("ws-1", "tasks"));
    const value = ["alpha", "gamma"];
    enqueue({ ...CHANGE, field: "tags", value, previousValues: [["alpha"]] });
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    doc.getMap("frontmatter").set("tags", ["alpha", "beta"]);
    docMock.current = engineDocState({ available: true, doc });
    host.rerender(<CollectionFieldWriteHost />);
    expect(doc.getMap("frontmatter").get("tags")).toEqual(["alpha", "beta"]);
    const ownMessage = "This selection changed since your edit. Copy your unsaved value before discarding it.";
    expect(collectionWriteFailures()[0]).toMatchObject({ recoveryOnly: true, change: { value }, message: ownMessage });
    for (const refusal of ["This share must be reopened.", "Your access to this share changed.", null]) {
      act(() => setCollectionFieldWriteAccess("ws-1", refusal));
      expect(collectionWriteFailures()[0]?.message).toBe(ownMessage);
      expect(status.result.current.error).toBe(ownMessage);
      expect(screen.getByTestId("collection-write-failure").textContent).toContain(ownMessage);
      if (refusal !== null) expect(screen.getByTestId("collection-write-failure").textContent).not.toContain(refusal);
      expect(screen.getByTestId("collection-write-retry")).toHaveProperty("disabled", true);
    }
    act(() => retryCollectionFieldWrite(collectionWriteFailures()[0]!.id));
    expect(doc.getMap("frontmatter").get("tags")).toEqual(["alpha", "beta"]);
  });

  it.each(["removed", "renamed", "number", "multi-select"] as const)(
    "retains an option edit when its select field was %s before preparation",
    async (scenario) => {
      const schema: Parameters<typeof serializeCollectionSchema>[0] = {
        name: null,
        description: null,
        fields: scenario === "removed" ? []
          : scenario === "renamed" ? [{ name: "other", type: "select", options: [] }]
          : scenario === "number" ? [{ name: "status", type: "number" }]
          : [{ name: "status", type: "multi-select", options: [] }],
        views: [],
      };
      const writeWorkspaceText = vi.fn(async () => ({ status: "written" }));
      vi.stubGlobal("dohcDesktop", {
        readWorkspaceText: vi.fn(async () => ({ ...read, text: serializeCollectionSchema(schema) })),
        writeWorkspaceText,
      });
      const doc = new Y.Doc();
      doc.getMap("frontmatter").set("id", "rec-1");
      docMock.current = engineDocState({ available: true, doc });
      render(<CollectionFieldWriteHost />);
      const onIndexed = vi.fn();
      act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE, "done", undefined, onIndexed); });
      await waitFor(() => expect(collectionWriteFailures()).toHaveLength(1));
      expect(writeWorkspaceText).not.toHaveBeenCalled();
      expect(doc.getMap("frontmatter").has("status")).toBe(false);
      expect(collectionWriteFailures()[0]?.change).toEqual(CHANGE);
      expect(collectionWriteFailures()[0]?.createOption).toBe("done");
      expect(collectionWriteFailures()[0]?.message).toContain("This field changed.");
      expect(onIndexed).not.toHaveBeenCalled();
    },
  );

  it("does not prepare an option until the bound document proves the original record identity", () => {
    const readWorkspaceText = vi.fn(async () => read);
    const writeWorkspaceText = vi.fn(async () => ({ status: "written" }));
    vi.stubGlobal("dohcDesktop", { readWorkspaceText, writeWorkspaceText });
    docMock.current = engineDocState({ opening: true });
    const host = render(<CollectionFieldWriteHost />);
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE, "done"); });
    expect(readWorkspaceText).not.toHaveBeenCalled();
    const replacement = new Y.Doc();
    replacement.getMap("frontmatter").set("id", "replacement-record");
    docMock.current = engineDocState({ available: true, doc: replacement });
    host.rerender(<CollectionFieldWriteHost />);
    expect(readWorkspaceText).not.toHaveBeenCalled();
    expect(writeWorkspaceText).not.toHaveBeenCalled();
    expect(replacement.getMap("frontmatter").has("status")).toBe(false);
    expect(collectionWriteFailures()[0]?.change).toEqual(CHANGE);
    expect(collectionWriteFailures()[0]?.createOption).toBe("done");
  });

  it("cancels a discarded option edit before its delayed schema read starts a write", async () => {
    let finishRead!: (value: typeof read) => void;
    const reading = new Promise<typeof read>((resolve) => { finishRead = resolve; });
    const writeWorkspaceText = vi.fn(async () => ({ status: "written" }));
    vi.stubGlobal("dohcDesktop", { readWorkspaceText: vi.fn(() => reading), writeWorkspaceText });
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    render(<CollectionFieldWriteHost />);
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE, "done"); });
    // Cancel synchronously, without depending on React's unmount cleanup.
    await act(async () => {
      abandonPendingCollectionFieldWrites("stalled");
      discardCollectionFieldWrite(collectionWriteFailures()[0]!.id);
      advanceCollectionWriteLineage("ws-1");
      finishRead(read);
      await reading;
    });
    expect(writeWorkspaceText).not.toHaveBeenCalled();
    expect(collectionWriteFailures()).toHaveLength(0);
  });

  it("keeps an issued schema mutation owned after the user discards its stalled entry", async () => {
    const observer = renderHook(() => useCollectionWritesBlockingAdmission("ws-2"));
    let finishWrite!: (value: { status: "written" }) => void;
    const writing = new Promise<{ status: "written" }>((resolve) => { finishWrite = resolve; });
    const writeWorkspaceText = vi.fn(() => writing);
    vi.stubGlobal("dohcDesktop", { readWorkspaceText: vi.fn(async () => read), writeWorkspaceText });
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    render(<CollectionFieldWriteHost />);
    act(() => { enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE, "done"); });
    await waitFor(() => expect(writeWorkspaceText).toHaveBeenCalledOnce());
    act(() => {
      abandonPendingCollectionFieldWrites("stalled");
      discardCollectionFieldWrite(collectionWriteFailures()[0]!.id);
    });
    expect(hasPendingCollectionFieldWrites()).toBe(true);
    expect(observer.result.current).toBe(true);
    let admitted = false;
    const beginning = beginCollectionLineageOperation("ws-1").then((release) => { admitted = true; release(); });
    await Promise.resolve();
    expect(admitted).toBe(false);
    await act(async () => { finishWrite({ status: "written" }); await writing; await beginning; });
    expect(admitted).toBe(true);
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(observer.result.current).toBe(false);
    expect(collectionWriteFailures()).toHaveLength(0);
  });
});

describe("abandonPendingCollectionFieldWrites", () => {
  it.each(["rename", "delete"] as const)("clears the old completed file-lock status after collection %s", (operation) => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "file-locked", reason: "test failure", issueId: null } });
    render(<CollectionFieldWriteHost />);
    const observer = renderHook(() => ({
      original: useCollectionWriteStatus("ws-1", "tasks"),
      moved: useCollectionWriteStatus("ws-1", "archive/tasks"),
      otherWorkspace: useCollectionWriteStatus("ws-2", "tasks"),
    }));
    enqueue();
    act(() => vi.advanceTimersByTime(FILE_LOCKED_REPORT_MS));
    act(() => { enqueueCollectionFieldWrite("ws-2", "tasks", CHANGE); });
    act(() => vi.advanceTimersByTime(FILE_LOCKED_REPORT_MS));
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(collectionWriteFailures()).toEqual([]);
    const lockedStatus = observer.result.current.original;
    const otherStatus = observer.result.current.otherWorkspace;
    expect(lockedStatus.error).not.toBeNull();
    expect(lockedStatus.settled).toBe(1);
    expect(otherStatus.error).not.toBeNull();
    act(() => remapCollectionFieldWritePaths("ws-1", (path) =>
      path === "tasks" || path.startsWith("tasks/")
        ? operation === "rename" ? `archive/${path}` : null
        : path,
    ));
    expect(observer.result.current.moved).toEqual(operation === "rename" ? lockedStatus : { error: null, settled: 0 });
    expect(observer.result.current.original).toEqual({ error: null, settled: 0 });
    expect(observer.result.current.otherWorkspace).toEqual(otherStatus);
  });

  it("observes admission blockers from other workspaces through retention and discard", () => {
    const observer = renderHook(() => useCollectionWritesBlockingAdmission("ws-2"));
    expect(observer.result.current).toBe(false);
    act(() => { enqueueCollectionFieldWrite("ws-2", "tasks", CHANGE); });
    expect(observer.result.current).toBe(false);
    enqueue();
    expect(observer.result.current).toBe(true);
    act(() => abandonPendingCollectionFieldWrites("stalled", "ws-2"));
    expect(observer.result.current).toBe(true);
    act(() => discardCollectionFieldWrite(collectionWriteFailures()[0]!.id));
    expect(observer.result.current).toBe(false);
    expect(hasPendingCollectionFieldWrites()).toBe(true);
    observer.unmount();
  });

  it("orders an abandoned older edit against newer input already retained during a pause", () => {
    docMock.current = engineDocState({ opening: true });
    const host = render(<CollectionFieldWriteHost />);
    enqueue({ ...CHANGE, value: "older" });
    let guard!: ReturnType<typeof beginCollectionWriteOperation>;
    act(() => { guard = beginCollectionWriteOperation("ws-1"); });
    enqueue({ ...CHANGE, value: "newer" });
    const newer = collectionWriteFailures()[0]!;
    act(() => abandonPendingCollectionFieldWrites("stalled"));
    const older = collectionWriteFailures().find((failure) => failure.change.value === "older")!;
    expect(older.superseded).toBe(true);
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    act(() => { guard.release(); retryCollectionFieldWrite(newer.id); });
    settleHead(host, doc);
    act(() => retryCollectionFieldWrite(older.id));
    expect(doc.getMap("frontmatter").get("status")).toBe("newer");
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(collectionWriteFailures()[0]?.change.value).toBe("older");
  });

  it("keeps an applied head owned and abandons only its unapplied tail", () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const host = render(<CollectionFieldWriteHost />);
    enqueue();
    enqueue({ ...CHANGE, recordId: "rec-2", recordPath: "tasks/two.md" });
    act(() => abandonPendingCollectionFieldWrites("stalled"));
    expect(collectionWriteFailures().map((failure) => failure.change.recordId)).toEqual(["rec-2"]);
    expect(hasPendingCollectionFieldWrites()).toBe(true);
    expect(doc.getMap("frontmatter").get("status")).toBe("done");
    act(() => discardCollectionFieldWrite(collectionWriteFailures()[0]!.id));
    expect(hasPendingCollectionFieldWrites()).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("dohc has not confirmed this save yet.");
    expect(screen.getByTestId("collection-save-unconfirmed")).toBeTruthy();
    settleHead(host, doc);
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(collectionWriteFailures()).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("turns the owned applied head into a failure only when the save actually fails", () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const host = render(<CollectionFieldWriteHost />);
    enqueue();
    act(() => abandonPendingCollectionFieldWrites("stalled"));
    expect(collectionWriteFailures()).toHaveLength(0);
    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "error", reason: "test failure", issueId: null }, saveError: "save failed" });
    host.rerender(<CollectionFieldWriteHost />);
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(collectionWriteFailures()[0]?.change).toEqual(CHANGE);
    expect(collectionWriteFailures()[0]?.message).toContain("save failed");
  });

  it("keeps a later failure from being overwritten when the retained applied head then fails", () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const host = render(<CollectionFieldWriteHost />);
    const status = renderHook(() => useCollectionWriteStatus("ws-1", "tasks"));
    enqueue();
    enqueue({ ...CHANGE, value: "newer" });
    act(() => abandonPendingCollectionFieldWrites("stalled"));
    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "error", reason: "test failure", issueId: null } });
    host.rerender(<CollectionFieldWriteHost />);
    const older = collectionWriteFailures().find((failure) => failure.change.value === "done")!;
    expect(older.superseded).toBe(true);
    expect(status.result.current.error).toBe(older.message);
    act(() => setCollectionFieldWriteAccess("ws-1", "This share must be reopened."));
    expect(status.result.current.error).toBe(older.message);
    act(() => retryCollectionFieldWrite(older.id));
    expect(hasPendingCollectionFieldWrites()).toBe(false);
  });

  it("uses witnessed file-lock durability when the drain times out before the lock-report timer", async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const host = render(<CollectionFieldWriteHost />);
    enqueue();
    const draining = settleCollectionFieldWrites(undefined, { stallMs: 20_000 });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "file-locked", reason: "test failure", issueId: null } });
    host.rerender(<CollectionFieldWriteHost />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await expect(draining).resolves.toEqual({ stalled: true, failed: 0 });
    act(() => abandonPendingCollectionFieldWrites("stalled"));
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(collectionWriteFailures()).toHaveLength(0);
  });

  it("excludes the same workspace as an admission drain", () => {
    docMock.current = engineDocState({ opening: true });
    render(<CollectionFieldWriteHost />);
    enqueue();
    act(() => {
      enqueueCollectionFieldWrite("ws-2", "tasks", CHANGE);
      abandonPendingCollectionFieldWrites("stalled", "ws-2");
    });
    expect(collectionWriteFailures().map((failure) => failure.workspaceId)).toEqual(["ws-1"]);
    expect(hasPendingCollectionFieldWrites()).toBe(true);
    act(() => abandonPendingCollectionFieldWrites("now ws-2"));
    expect(collectionWriteFailures().map((failure) => failure.workspaceId)).toEqual(["ws-1", "ws-2"]);
  });

  it("finishes a previously stalled head when the engine later confirms durable file-lock ownership", () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const host = render(<CollectionFieldWriteHost />);
    enqueue();
    act(() => abandonPendingCollectionFieldWrites("stalled"));
    expect(hasPendingCollectionFieldWrites()).toBe(true);
    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "file-locked", reason: "test failure", issueId: null } });
    host.rerender(<CollectionFieldWriteHost />);
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(collectionWriteFailures()).toHaveLength(0);
  });
});
