// @vitest-environment jsdom

// The queue's continuity contract, driven through the REAL host and writer
// with a mocked engine-doc session (CollectionPage.test.tsx idiom): a failed
// write keeps the user's accepted value until a retry lands it or the user
// discards it, the failure stays visible and reported with no CollectionPage
// mounted, and an operation guard pauses new acceptance without dropping a
// racing edit.

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { CollectionValue } from "@dohc/workspace-contracts";
import type { UseEngineDoc } from "../collab/useEngineDoc";
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
  resetCollectionFieldWritesForTests,
  remapCollectionFieldWritePaths,
  retryCollectionFieldWrite,
  settleCollectionFieldWrites,
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

function engineDocState(
  partial: Partial<
    Pick<UseEngineDoc, "available" | "opening" | "doc" | "saveState" | "saveError">
  >,
): UseEngineDoc {
  return {
    available: false,
    opening: false,
    doc: null,
    saveState: "saved",
    saveError: null,
    ...partial,
  } as UseEngineDoc;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  docMock.current = null;
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

/** Walks the mounted head writer through saving → saved so it settles. */
function settleHead(host: ReturnType<typeof render>, doc: Y.Doc) {
  docMock.current = engineDocState({ available: true, doc, saveState: "saving" });
  host.rerender(<CollectionFieldWriteHost />);
  docMock.current = engineDocState({ available: true, doc, saveState: "saved" });
  host.rerender(<CollectionFieldWriteHost />);
}

describe("retained failures", () => {
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
    expect(screen.getByRole("status").textContent).toContain("1 unsaved collection change needs attention.");
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
      saveState: "file-locked",
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
    docMock.current = engineDocState({ available: true, doc, saveState: "file-locked" });
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
      saveState: "read-only",
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

  it("retains an initial selection if the document changed while its session opened", () => {
    docMock.current = engineDocState({ opening: true });
    const host = render(<CollectionFieldWriteHost />);
    const value = ["alpha", "gamma"];
    enqueue({ ...CHANGE, field: "tags", value, previousValues: [["alpha"]] });
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    doc.getMap("frontmatter").set("tags", ["alpha", "beta"]);
    docMock.current = engineDocState({ available: true, doc });
    host.rerender(<CollectionFieldWriteHost />);
    expect(doc.getMap("frontmatter").get("tags")).toEqual(["alpha", "beta"]);
    expect(collectionWriteFailures()[0]).toMatchObject({ recoveryOnly: true, change: { value } });
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
    docMock.current = engineDocState({ available: true, doc, saveState: "file-locked" });
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
    docMock.current = engineDocState({ available: true, doc, saveState: "error", saveError: "save failed" });
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
    enqueue();
    enqueue({ ...CHANGE, value: "newer" });
    act(() => abandonPendingCollectionFieldWrites("stalled"));
    docMock.current = engineDocState({ available: true, doc, saveState: "error" });
    host.rerender(<CollectionFieldWriteHost />);
    const older = collectionWriteFailures().find((failure) => failure.change.value === "done")!;
    expect(older.superseded).toBe(true);
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
    docMock.current = engineDocState({ available: true, doc, saveState: "file-locked" });
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
    docMock.current = engineDocState({ available: true, doc, saveState: "file-locked" });
    host.rerender(<CollectionFieldWriteHost />);
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    expect(collectionWriteFailures()).toHaveLength(0);
  });
});
