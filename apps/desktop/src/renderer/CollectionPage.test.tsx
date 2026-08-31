// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  parseCollectionSchema,
  type CollectionRecord,
  type CollectionRecordGroup,
  type CollectionSchema,
} from "@dohc/workspace-contracts";
import { serializeCollectionSchema } from "./collections/schemaAuthoring";
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

// A content hash the stub can advance per write; main's real hashes are
// SHA-256, but the renderer only round-trips the value.
const hashFor = (writes: number) => String(writes).padStart(64, "0");

function makeBridge(
  records: CollectionRecord[],
  schema: CollectionSchema = SCHEMA,
  extra?: {
    /** The grouped result a board view's query serves. */
    groups?: CollectionRecordGroup[];
    /** Records served for queries against other collection paths. */
    related?: Record<string, CollectionRecord[]>;
  },
) {
  const activityCallbacks = new Set<(event: WorkspaceActivityEvent) => void>();
  // The schema round-trips through the stub the way it does through the
  // engine: reads serve the last written text's parse, writes conflict on a
  // stale expected identity.
  let currentSchema = schema;
  let contentHash = hashFor(0);
  let writes = 0;
  return {
    emitWorkspaceActivity: (event: WorkspaceActivityEvent) => {
      for (const callback of [...activityCallbacks]) callback(event);
    },
    getCollection: vi.fn(
      async (): Promise<GetCollectionResult> => ({
        path: "tasks",
        status: "valid",
        reasons: [],
        schema: currentSchema,
        recordCount: records.length,
      }),
    ),
    listCollections: vi.fn(async () => ({
      collections: [{ path: "tasks", status: "valid", reasons: [] }],
    })),
    readWorkspaceText: vi.fn(async () => ({
      text: serializeCollectionSchema(currentSchema),
      truncated: false as const,
      contentHash,
    })),
    writeWorkspaceText: vi.fn(
      async (payload: { text: string; expectedContentHash: string }) => {
        if (payload.expectedContentHash !== contentHash) {
          return { status: "conflict" as const, currentContentHash: contentHash };
        }
        currentSchema = parseCollectionSchema(payload.text).schema;
        writes += 1;
        contentHash = hashFor(writes);
        return { status: "written" as const, contentHash };
      },
    ),
    queryCollectionRecords: vi.fn(
      async (params: {
        collectionPath: string;
      }): Promise<QueryCollectionRecordsResult> => {
        const related = extra?.related?.[params.collectionPath];
        if (related) {
          return {
            collection: { path: params.collectionPath, status: "valid", reasons: [] },
            records: related,
            groups: null,
            nextCursor: null,
          };
        }
        return {
          collection: { path: "tasks", status: "valid", reasons: [] },
          records,
          groups: extra?.groups ?? null,
          nextCursor: null,
        };
      },
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
  onOpenRecord: (recordPath: string) => void = () => undefined,
) {
  vi.stubGlobal("dohcDesktop", bridge);
  return render(
    <CollectionPage
      workspaceId="ws-1"
      collectionPath="tasks"
      onNewRecord={onNewRecord}
      onOpenRecord={onOpenRecord}
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

const SELECT_SCHEMA: CollectionSchema = {
  name: "Tasks",
  description: null,
  fields: [
    { name: "title", type: "text" },
    { name: "status", type: "select", options: ["Todo"] },
  ],
  views: [],
};

function selectRecord(): CollectionRecord {
  return {
    id: "rec-1",
    path: "tasks/Plan.md",
    conflicted: false,
    values: [
      {
        field: "title",
        value: "Plan",
        validation: { status: "valid" },
        resolvedRelations: [],
      },
      {
        field: "status",
        value: "Todo",
        validation: { status: "valid" },
        resolvedRelations: [],
      },
    ],
  };
}

function lastWrittenSchema(bridge: ReturnType<typeof makeBridge>) {
  const call = bridge.writeWorkspaceText.mock.calls.at(-1);
  if (!call) throw new Error("no schema write");
  return parseCollectionSchema(call[0].text);
}

describe("collection authoring", () => {
  it("adds a field through one schema rewrite with the file's expected identity", async () => {
    const bridge = makeBridge([record("rec-1", "Plan")]);
    renderPage(bridge);
    await screen.findByText("Plan");

    fireEvent.click(screen.getByTestId("collection-fields-button"));
    fireEvent.change(screen.getByLabelText("Field name"), {
      target: { value: "Status" },
    });
    fireEvent.change(screen.getByLabelText("Field type"), {
      target: { value: "select" },
    });
    fireEvent.change(screen.getByLabelText("Options"), {
      target: { value: "Todo, Done" },
    });
    fireEvent.click(screen.getByTestId("collection-add-field"));

    await waitFor(() =>
      expect(bridge.writeWorkspaceText).toHaveBeenCalledOnce(),
    );
    const payload = bridge.writeWorkspaceText.mock.calls[0]?.[0] as {
      workspaceId: string;
      relativePath: string;
      expectedContentHash: string;
      text: string;
    };
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.relativePath).toBe("tasks/collection.yaml");
    expect(payload.expectedContentHash).toBe(hashFor(0));
    const written = parseCollectionSchema(payload.text);
    expect(written.status).toBe("valid");
    expect(written.schema.fields).toEqual([
      { name: "title", type: "text" },
      { name: "Status", type: "select", options: ["Todo", "Done"] },
    ]);
    // Round trip: the refreshed schema reaches the dialog's field list and
    // the table header.
    expect((await screen.findAllByText("Status")).length).toBeGreaterThan(0);
  });

  it("changes a select field's options without touching its name", async () => {
    const bridge = makeBridge([selectRecord()], SELECT_SCHEMA);
    renderPage(bridge);
    await screen.findByText("Plan");

    fireEvent.click(screen.getByTestId("collection-fields-button"));
    // Renaming ships with the record-key rewrite: no edit affordance on
    // non-select fields, and the name input stays disabled.
    expect(screen.queryByLabelText("Edit field title")).toBeNull();
    fireEvent.click(screen.getByLabelText("Edit field status"));
    const name = screen.getByDisplayValue<HTMLInputElement>("status");
    expect(name.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Options"), {
      target: { value: "Todo, Done, Later" },
    });
    fireEvent.click(screen.getByText("Save field"));

    await waitFor(() =>
      expect(bridge.writeWorkspaceText).toHaveBeenCalledOnce(),
    );
    expect(lastWrittenSchema(bridge).schema.fields).toEqual([
      { name: "title", type: "text" },
      { name: "status", type: "select", options: ["Todo", "Done", "Later"] },
    ]);
  });

  it("writes a created select option to the schema before the cell write", async () => {
    const doc = new Y.Doc();
    docMock.current = engineDocState({ available: true, doc });
    const bridge = makeBridge([selectRecord()], SELECT_SCHEMA);
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const write = bridge.writeWorkspaceText.getMockImplementation();
    if (!write) throw new Error("write stub missing");
    bridge.writeWorkspaceText.mockImplementationOnce(async (payload) => {
      await gate;
      return write(payload);
    });
    renderPage(bridge);
    await screen.findByText("Plan");

    fireEvent.click(screen.getByText("Todo"));
    const addOption = screen.getByLabelText("Add option");
    fireEvent.change(addOption, { target: { value: "Later" } });
    fireEvent.keyDown(addOption, { key: "Enter" });

    await waitFor(() =>
      expect(bridge.writeWorkspaceText).toHaveBeenCalledOnce(),
    );
    // The schema write has not settled: the cell write must not have run.
    expect(doc.getMap("frontmatter").get("status")).toBeUndefined();

    releaseWrite();
    await waitFor(() =>
      expect(doc.getMap("frontmatter").get("status")).toBe("Later"),
    );
    const written = lastWrittenSchema(bridge).schema;
    expect(written.fields[1]).toEqual({
      name: "status",
      type: "select",
      options: ["Todo", "Later"],
    });
  });

  it("creates, renames, and deletes a view through schema rewrites", async () => {
    const bridge = makeBridge([selectRecord()], SELECT_SCHEMA);
    renderPage(bridge);
    await screen.findByText("Plan");

    fireEvent.click(screen.getByTestId("collection-views-button"));
    fireEvent.change(screen.getByLabelText("View name"), {
      target: { value: "Board" },
    });
    fireEvent.change(screen.getByLabelText("View kind"), {
      target: { value: "board" },
    });
    fireEvent.change(await screen.findByLabelText("Group by"), {
      target: { value: "status" },
    });
    fireEvent.click(screen.getByTestId("collection-add-view"));
    await waitFor(() =>
      expect(bridge.writeWorkspaceText).toHaveBeenCalledOnce(),
    );
    expect(lastWrittenSchema(bridge).schema.views).toEqual([
      {
        name: "Board",
        kind: "board",
        groupBy: "status",
        sort: [],
        visibleFields: null,
        dateField: null,
      },
    ]);

    // The dialog lists the view once the refreshed schema arrives.
    fireEvent.click(await screen.findByLabelText("Rename view Board"));
    fireEvent.change(screen.getByDisplayValue("Board"), {
      target: { value: "My board" },
    });
    fireEvent.click(screen.getByText("Save view"));
    await waitFor(() =>
      expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    expect(
      lastWrittenSchema(bridge).schema.views.map((view) => view.name),
    ).toEqual(["My board"]);

    fireEvent.click(await screen.findByLabelText("Delete view My board"));
    await waitFor(() =>
      expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(3),
    );
    expect(lastWrittenSchema(bridge).schema.views).toEqual([]);
  });
});

const BOARD_SCHEMA: CollectionSchema = {
  ...SELECT_SCHEMA,
  views: [
    {
      name: "Board",
      kind: "board",
      groupBy: "status",
      sort: [],
      visibleFields: null,
      dateField: null,
    },
  ],
};

const CALENDAR_SCHEMA: CollectionSchema = {
  name: "Tasks",
  description: null,
  fields: [
    { name: "title", type: "text" },
    { name: "due", type: "date" },
  ],
  views: [
    {
      name: "Calendar",
      kind: "calendar",
      groupBy: null,
      sort: [],
      visibleFields: null,
      dateField: "due",
    },
  ],
};

/** Today as a date field value, so the event lands in the opened month. */
function localToday(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

describe("record click-through", () => {
  it("opens the record's file from a table row", async () => {
    const bridge = makeBridge([record("rec-1", "Plan")]);
    const onOpenRecord = vi.fn();
    renderPage(bridge, undefined, onOpenRecord);

    fireEvent.click(await screen.findByRole("button", { name: "Open Plan" }));
    expect(onOpenRecord).toHaveBeenCalledExactlyOnceWith("tasks/Plan.md");
  });

  it("opens the record's file from a board card", async () => {
    const bridge = makeBridge([selectRecord()], BOARD_SCHEMA, {
      groups: [{ value: "Todo", records: [selectRecord()] }],
    });
    const onOpenRecord = vi.fn();
    renderPage(bridge, undefined, onOpenRecord);

    fireEvent.click(await screen.findByRole("listitem", { name: "Plan" }));
    expect(onOpenRecord).toHaveBeenCalledExactlyOnceWith("tasks/Plan.md");
  });

  it("opens the record's file from a calendar event", async () => {
    const dated: CollectionRecord = {
      id: "rec-1",
      path: "tasks/Plan.md",
      conflicted: false,
      values: [
        {
          field: "title",
          value: "Plan",
          validation: { status: "valid" },
          resolvedRelations: [],
        },
        {
          field: "due",
          value: localToday(),
          validation: { status: "valid" },
          resolvedRelations: [],
        },
      ],
    };
    const bridge = makeBridge([dated], CALENDAR_SCHEMA);
    const onOpenRecord = vi.fn();
    renderPage(bridge, undefined, onOpenRecord);

    fireEvent.click(await screen.findByText("Plan"));
    expect(onOpenRecord).toHaveBeenCalledExactlyOnceWith("tasks/Plan.md");
  });
});

const RELATION_SCHEMA: CollectionSchema = {
  name: "Tasks",
  description: null,
  fields: [
    { name: "title", type: "text" },
    { name: "owner", type: "relation", collection: "people", many: false },
  ],
  views: [],
};

function person(id: string, name: string): CollectionRecord {
  return {
    id,
    path: `people/${name}.md`,
    conflicted: false,
    values: [
      {
        field: "name",
        value: name,
        validation: { status: "valid" },
        resolvedRelations: [],
      },
    ],
  };
}

describe("relation picking", () => {
  it("queries the related collection and writes the picked id through the record's doc", async () => {
    const doc = new Y.Doc();
    docMock.current = engineDocState({ available: true, doc });
    const relationRecord: CollectionRecord = {
      id: "rec-1",
      path: "tasks/Plan.md",
      conflicted: false,
      values: [
        {
          field: "title",
          value: "Plan",
          validation: { status: "valid" },
          resolvedRelations: [],
        },
        {
          field: "owner",
          value: "rec-p1",
          validation: { status: "valid" },
          resolvedRelations: [{ recordId: "rec-p1", label: "Ada" }],
        },
      ],
    };
    const bridge = makeBridge([relationRecord], RELATION_SCHEMA, {
      related: { people: [person("rec-p1", "Ada"), person("rec-p2", "Grace")] },
    });
    renderPage(bridge);
    await screen.findByText("Plan");

    fireEvent.click(screen.getByRole("button", { name: "Ada" }));
    fireEvent.click(await screen.findByRole("option", { name: "Grace" }));

    expect(bridge.queryCollectionRecords).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      collectionPath: "people",
      limit: 100,
    });
    await waitFor(() =>
      expect(doc.getMap("frontmatter").get("owner")).toBe("rec-p2"),
    );
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
