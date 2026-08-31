// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type {
  CollectionRecord,
  CollectionSchema,
} from "@dohc/workspace-contracts";
import type {
  GetCollectionResult,
  QueryCollectionRecordsResult,
  WorkspaceActivityEvent,
} from "../ipc/bridgeContract";
import {
  CollectionPage,
  CollectionRecordFieldWrite,
  frontmatterWriteValue,
} from "./CollectionPage";
import type { UseEngineDoc } from "./collab/useEngineDoc";

// @dnd-kit/dom (BoardView's dependency) references ResizeObserver while its
// module evaluates and tracks droppable geometry with IntersectionObserver.
// jsdom implements neither, so the stubs must exist before the imports run
// (BoardView.test.tsx precedent in @dohc/collection-views).
vi.hoisted(() => {
  class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): never[] {
      return [];
    }
  }
  Object.assign(globalThis, {
    ResizeObserver: ObserverStub,
    IntersectionObserver: ObserverStub,
  });
});

// The record write path opens an engine doc session; these tests drive it
// with a mocked session whose mirror doc is a REAL Y.Doc, so "the change
// reached the frontmatter map" is asserted on actual CRDT state.
const docMock = vi.hoisted(() => ({
  current: null as unknown,
  inputs: [] as unknown[],
}));
vi.mock("./collab/useEngineDoc", () => ({
  useEngineDoc: (input: unknown): unknown => {
    docMock.inputs.push(input);
    if (docMock.current === null) throw new Error("docMock.current unset");
    return docMock.current;
  },
}));

function engineDocState(
  partial: Partial<Pick<UseEngineDoc, "available" | "opening" | "doc" | "saveState" | "saveError">>,
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

// The table virtualizer reads offsetWidth/offsetHeight, which jsdom reports
// as 0. Give every element a nonzero box so rows render.
const offsetDescriptors = {
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: 600,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    value: 900,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  docMock.current = null;
  docMock.inputs = [];
  for (const [name, descriptor] of Object.entries(offsetDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
});

const SCHEMA: CollectionSchema = {
  name: "Tasks",
  description: null,
  fields: [{ name: "title", type: "text" }],
  views: [],
};

function record(id: string, title: string): CollectionRecord {
  return {
    id,
    path: `tasks/${title}.md`,
    conflicted: false,
    values: [
      {
        field: "title",
        value: title,
        validation: { status: "valid" },
        resolvedRelations: [],
      },
    ],
  };
}

function makeBridge(records: CollectionRecord[]) {
  const activityCallbacks = new Set<(event: WorkspaceActivityEvent) => void>();
  return {
    emitWorkspaceActivity: (event: WorkspaceActivityEvent) => {
      for (const callback of [...activityCallbacks]) callback(event);
    },
    getCollection: vi.fn(
      async (): Promise<GetCollectionResult> => ({
        path: "tasks",
        status: "valid",
        reasons: [],
        schema: SCHEMA,
        recordCount: records.length,
      }),
    ),
    queryCollectionRecords: vi.fn(
      async (): Promise<QueryCollectionRecordsResult> => ({
        collection: { path: "tasks", status: "valid", reasons: [] },
        records,
        groups: null,
        nextCursor: null,
      }),
    ),
    onWorkspaceActivity: vi.fn(
      (callback: (event: WorkspaceActivityEvent) => void) => {
        activityCallbacks.add(callback);
        return () => {
          activityCallbacks.delete(callback);
        };
      },
    ),
  };
}

function renderPage(
  bridge: ReturnType<typeof makeBridge>,
  onNewRecord: (collectionPath: string) => void = () => undefined,
) {
  vi.stubGlobal("dohcDesktop", bridge);
  return render(
    <CollectionPage
      workspaceId="ws-1"
      collectionPath="tasks"
      onNewRecord={onNewRecord}
    />,
  );
}

describe("CollectionPage", () => {
  it("binds the store executor to the query bridge call and renders records", async () => {
    const bridge = makeBridge([record("rec-1", "Plan")]);
    renderPage(bridge);

    await waitFor(() =>
      expect(bridge.queryCollectionRecords).toHaveBeenCalledOnce(),
    );
    expect(bridge.queryCollectionRecords).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      collectionPath: "tasks",
      resolveRelations: true,
    });
    expect(await screen.findByText("Plan")).toBeDefined();
    expect(screen.getByTestId("collection-page")).toBeDefined();
  });

  it("shows one line and the New record action for an empty collection", async () => {
    const bridge = makeBridge([]);
    const onNewRecord = vi.fn();
    renderPage(bridge, onNewRecord);

    expect(
      await screen.findByText("No records in this collection yet."),
    ).toBeDefined();
    // Settled 2026-08-31: the line and the action, nothing else.
    const empty = screen.getByTestId("collection-empty");
    expect(empty.querySelectorAll("button")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("collection-new-record"));
    expect(onNewRecord).toHaveBeenCalledExactlyOnceWith("tasks");
  });

  it("refreshes when workspace activity touches the collection folder", async () => {
    const bridge = makeBridge([record("rec-1", "Plan")]);
    renderPage(bridge);
    await waitFor(() =>
      expect(bridge.queryCollectionRecords).toHaveBeenCalledOnce(),
    );
    const detailReads = bridge.getCollection.mock.calls.length;

    vi.useFakeTimers();
    // An unrelated path must not refresh this collection.
    bridge.emitWorkspaceActivity({
      workspaceId: "ws-1",
      paths: ["notes/other.md"],
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(bridge.queryCollectionRecords).toHaveBeenCalledOnce();

    bridge.emitWorkspaceActivity({
      workspaceId: "ws-1",
      paths: ["tasks/Plan.md"],
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(bridge.queryCollectionRecords).toHaveBeenCalledTimes(2);
    // Schema edits arrive the same way, so the details re-read rides along.
    expect(bridge.getCollection.mock.calls.length).toBe(detailReads + 1);
  });
});

describe("CollectionRecordFieldWrite", () => {
  const CHANGE = {
    recordId: "rec-1",
    recordPath: "tasks/Plan.md",
    field: "status",
    value: "done",
  };

  it("writes the field on the frontmatter map and releases after the save settles", () => {
    const doc = new Y.Doc();
    docMock.current = engineDocState({ available: true, doc });
    const onDone = vi.fn();
    const onError = vi.fn();
    const view = render(
      <CollectionRecordFieldWrite
        workspaceId="ws-1"
        change={CHANGE}
        onDone={onDone}
        onError={onError}
      />,
    );

    expect(docMock.inputs[0]).toEqual({
      workspaceId: "ws-1",
      path: "tasks/Plan.md",
      enabled: true,
    });
    expect(doc.getMap("frontmatter").get("status")).toBe("done");
    // The session opens in "saved"; releasing on that snapshot would race
    // the staged local-update flush, so the writer must still be waiting.
    expect(onDone).not.toHaveBeenCalled();

    docMock.current = engineDocState({ available: true, doc, saveState: "saving" });
    view.rerender(
      <CollectionRecordFieldWrite
        workspaceId="ws-1"
        change={CHANGE}
        onDone={onDone}
        onError={onError}
      />,
    );
    expect(onDone).not.toHaveBeenCalled();

    docMock.current = engineDocState({ available: true, doc, saveState: "saved" });
    view.rerender(
      <CollectionRecordFieldWrite
        workspaceId="ws-1"
        change={CHANGE}
        onDone={onDone}
        onError={onError}
      />,
    );
    expect(onDone).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces a save error and still releases", () => {
    const doc = new Y.Doc();
    docMock.current = engineDocState({ available: true, doc });
    const onDone = vi.fn();
    const onError = vi.fn();
    const view = render(
      <CollectionRecordFieldWrite
        workspaceId="ws-1"
        change={CHANGE}
        onDone={onDone}
        onError={onError}
      />,
    );
    docMock.current = engineDocState({
      available: true,
      doc,
      saveState: "error",
      saveError: "file too large",
    });
    view.rerender(
      <CollectionRecordFieldWrite
        workspaceId="ws-1"
        change={CHANGE}
        onDone={onDone}
        onError={onError}
      />,
    );
    expect(onError).toHaveBeenCalledExactlyOnceWith("file too large");
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("reports a refusal without touching the doc", () => {
    docMock.current = engineDocState({ available: false });
    const onDone = vi.fn();
    const onError = vi.fn();
    render(
      <CollectionRecordFieldWrite
        workspaceId="ws-1"
        change={CHANGE}
        onDone={onDone}
        onError={onError}
      />,
    );
    expect(onError).toHaveBeenCalledExactlyOnceWith(null);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("writes bigints back as numbers when exact, else decimal text", () => {
    expect(frontmatterWriteValue(10n)).toBe(10);
    expect(frontmatterWriteValue(2n ** 63n)).toBe("9223372036854775808");
    expect(frontmatterWriteValue(["a", 3n])).toEqual(["a", 3]);
  });
});
