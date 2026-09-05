// @vitest-environment jsdom

// The queue's continuity contract, driven through the REAL host and writer
// with a mocked engine-doc session (CollectionPage.test.tsx idiom): a failed
// write keeps the user's accepted value until a retry lands it or the user
// discards it, the failure stays visible and reported with no CollectionPage
// mounted, and an operation guard pauses new acceptance without dropping a
// racing edit.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { UseEngineDoc } from "../collab/useEngineDoc";
import {
  beginCollectionWriteOperation,
  collectionWriteFailures,
  CollectionFieldWriteHost,
  enqueueCollectionFieldWrite,
  FILE_LOCKED_REPORT_MS,
  hasPendingCollectionFieldWrites,
  resetCollectionFieldWritesForTests,
  retryCollectionFieldWrite,
  settleCollectionFieldWrites,
} from "./recordFieldWrites";

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
  docMock.current = null;
  resetCollectionFieldWritesForTests();
});

const CHANGE = {
  recordId: "rec-1",
  recordPath: "tasks/Plan.md",
  field: "status",
  value: "done",
};

function enqueue(change = CHANGE) {
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
