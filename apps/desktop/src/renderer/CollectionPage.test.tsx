// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { parseCollectionSchema, type CollectionRecord, type CollectionRecordGroup, type CollectionSchema } from "@dohc/workspace-contracts";
import { serializeCollectionSchema } from "./collections/schemaAuthoring";
import type { AutomationRunSettledEvent, AutomationRunWaitingEvent, GetCollectionResult, PressAutomationButtonPayload, PressAutomationButtonResult, QueryCollectionRecordsResult, WorkspaceActivityEvent } from "../ipc/bridgeContract";
import type { AutomationButtonState } from "@dohc/automation-executor/automation-buttons";
import { CollectionPage, type CollectionPageProps } from "./CollectionPage";
import { disposeAutomationButtons, resetAutomationButtonsForTests } from "./collections/useAutomationButtons";
import { deferred } from "../testing/deferred";
import { beginCollectionWriteOperation, CollectionFieldWriteHost, collectionWriteFailures, hasPendingCollectionFieldWrites, resetCollectionFieldWritesForTests, retryCollectionFieldWrite } from "./collections/recordFieldWrites";
import { beginCollectionLineageOperation } from "./collections/collectionLineageGate";
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
// with a mocked session whose mirror doc is a real Y.Doc, so "the change
// reached the frontmatter map" is asserted on actual CRDT state.
const docMock = vi.hoisted(() => ({
  current: null as
    | UseEngineDoc
    | ((input: unknown) => UseEngineDoc)
    | null,
  inputs: [] as unknown[],
}));
vi.mock("./collab/useEngineDoc", () => ({
  useEngineDoc: (input: unknown): unknown => {
    docMock.inputs.push(input);
    const current = docMock.current;
    if (current === null) throw new Error("docMock.current unset");
    return typeof current === "function" ? current(input) : current;
  },
}));
// The record's file check runs in a worker and has its own tests
// (recordFieldWrites.test.tsx); here every record is clear.
vi.mock("./collections/recordSourceCheck", () => ({
  useRecordSourceCheck: () => ({ state: "clear", contentHash: "c".repeat(64) }),
}));

function engineDocState(
  partial: Partial<Pick<UseEngineDoc, "available" | "opening" | "doc" | "saveState" | "saveError" | "readOnlyWhileEditing" | "deletedWhileEditing">>,
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
  resetAutomationButtonsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  docMock.current = null;
  docMock.inputs = [];
  // The write queue is module state on purpose (it outlives the page);
  // tests must not leak a pending head into each other.
  resetCollectionFieldWritesForTests();
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
    /** What main says each Button field does. */
    buttons?: Array<{ field: string; state: AutomationButtonState }>;
    /** Main's answer to a press. */
    press?: (payload: PressAutomationButtonPayload) => Promise<PressAutomationButtonResult>;
  },
) {
  const activityCallbacks = new Set<(event: WorkspaceActivityEvent) => void>();
  const settledCallbacks = new Set<(event: AutomationRunSettledEvent) => void>();
  const waitingCallbacks = new Set<(event: AutomationRunWaitingEvent) => void>();
  const automationsCallbacks = new Set<(event: { workspaceId: string }) => void>();
  // The schema round-trips through the stub the way it does through the
  // engine: reads serve the last written text's parse, writes conflict on a
  // stale expected identity.
  let currentSchema = schema;
  let contentHash = hashFor(0);
  let writes = 0;
  return {
    emitAutomationsChanged: (workspaceId: string) => {
      for (const callback of [...automationsCallbacks]) callback({ workspaceId });
    },
    onCollectionAutomationsChanged: (callback: (event: { workspaceId: string }) => void) => {
      automationsCallbacks.add(callback);
      return () => { automationsCallbacks.delete(callback); };
    },
    emitWorkspaceActivity: (event: WorkspaceActivityEvent) => {
      for (const callback of [...activityCallbacks]) callback(event);
    },
    emitRunSettled: (event: AutomationRunSettledEvent) => {
      for (const callback of [...settledCallbacks]) callback(event);
    },
    emitRunWaiting: (event: AutomationRunWaitingEvent) => {
      for (const callback of [...waitingCallbacks]) callback(event);
    },
    listAutomationButtons: vi.fn(async () => ({ buttons: extra?.buttons ?? [] })),
    pressAutomationButton: vi.fn(
      extra?.press ?? (async (): Promise<PressAutomationButtonResult> => ({ busy: false, claimId: "atc_press", settled: null })),
    ),
    retryCollectionAutomation: vi.fn(async () => ({ status: "queued" as const, press: true })),
    onAutomationRunSettled: vi.fn((callback: (event: AutomationRunSettledEvent) => void) => {
      settledCallbacks.add(callback);
      return () => {
        settledCallbacks.delete(callback);
      };
    }),
    onAutomationRunWaiting: vi.fn((callback: (event: AutomationRunWaitingEvent) => void) => {
      waitingCallbacks.add(callback);
      return () => {
        waitingCallbacks.delete(callback);
      };
    }),
    getCollection: vi.fn(
      async (): Promise<GetCollectionResult> => ({
        path: "tasks",
        objectId: "object-test",
        status: "valid",
        reasons: [],
        schema: currentSchema,
        recordCount: records.length,
      }),
    ),
    listCollections: vi.fn(async () => ({
      collections: [{ path: "tasks", objectId: "object-test", status: "valid", reasons: [] }],
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
            collection: { path: params.collectionPath, objectId: "object-test", status: "valid", reasons: [] },
            records: related,
            groups: null,
            nextCursor: null,
          };
        }
        return {
          collection: { path: "tasks", objectId: "object-test", status: "valid", reasons: [] },
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
    // The header's ⚡ count reads the Collection's automations.
    listCollectionAutomations: vi.fn(async () => ({ status: "missing" as const })),
    listAutomationHolds: vi.fn(async () => ({ holds: [], unreadable: false })),
  };
}

// The props a page gets from the shell besides its collection and view.
const SHELL_PROPS = {
  onOpenFile: () => undefined,
  onOpenScheduleSettings: () => undefined,
  onError: () => undefined,
  onNotice: () => undefined,
  automationFocus: null,
  onAutomationFocused: () => undefined,
};

// The page plus the ONE writer host the shell mounts; rerenders reuse this
// element so the host is never doubled or dropped.
function pageWithHost(
  onNewRecord: CollectionPageProps["onNewRecord"] = () => undefined,
  onOpenRecord: (recordPath: string) => void = () => undefined,
  view?: {
    readOnly?: boolean;
    accessEnded?: boolean;
    writeRefusal?: string;
    activeViewName?: string | null;
    onActiveViewChange?: (viewName: string | null) => void;
    onError?: CollectionPageProps["onError"];
    onNotice?: CollectionPageProps["onNotice"];
    onOpenFile?: CollectionPageProps["onOpenFile"];
  },
) {
  return (
    <>
      <CollectionPage
        workspaceId="ws-1"
        collectionPath="tasks"
        readOnly={view?.readOnly}
        accessEnded={view?.accessEnded}
        writeRefusal={view?.writeRefusal}
        activeViewName={view?.activeViewName ?? null}
        onActiveViewChange={view?.onActiveViewChange ?? (() => undefined)}
        onNewRecord={onNewRecord}
        onOpenRecord={onOpenRecord}
        {...SHELL_PROPS}
        onError={view?.onError ?? SHELL_PROPS.onError}
        onNotice={view?.onNotice ?? SHELL_PROPS.onNotice}
        onOpenFile={view?.onOpenFile ?? SHELL_PROPS.onOpenFile}
      />
      <CollectionFieldWriteHost />
    </>
  );
}

function renderPage(
  bridge: ReturnType<typeof makeBridge>,
  onNewRecord: CollectionPageProps["onNewRecord"] = () => undefined,
  onOpenRecord: (recordPath: string) => void = () => undefined,
  view?: {
    readOnly?: boolean;
    accessEnded?: boolean;
    writeRefusal?: string;
    activeViewName?: string | null;
    onActiveViewChange?: (viewName: string | null) => void;
    onError?: CollectionPageProps["onError"];
  },
) {
  vi.stubGlobal("dohcDesktop", bridge);
  return render(pageWithHost(onNewRecord, onOpenRecord, view));
}

describe("CollectionPage", () => {
  it("keeps draft delivery separate from owner application, retries, and reverses local discard", async () => {
    const draft = { ...record("rec_aaaaaaaaaaaaaaaaaaaaaaaaaa", "Socks"), creationDelivery: "pending" as const, creationCanDiscard: true };
    const records = [draft];
    const api = { ...makeBridge(records), pushShareDirectWrites: vi.fn(async () => undefined),
      deleteWorkspacePath: vi.fn(async () => { records.splice(0); }), createWorkspaceFile: vi.fn(async () => { records.push(draft); }) };
    const text = `---\nid: ${draft.id}\nTitle: Socks\n---\nKeep the entire draft.\n`;
    api.readWorkspaceText.mockResolvedValue({ text, truncated: false, contentHash: hashFor(0) });
    const onNotice = vi.fn();
    vi.stubGlobal("dohcDesktop", api);
    render(pageWithHost(undefined, undefined, { onNotice }));
    await screen.findByText("Saved on this computer. Waiting to send");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.pushShareDirectWrites).toHaveBeenCalledWith({ workspaceId: "ws-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    expect(api.deleteWorkspacePath).toHaveBeenCalledWith({ workspaceId: "ws-1", relativePath: draft.path });
    act(() => onNotice.mock.calls[0]![1]());
    await waitFor(() => expect(api.createWorkspaceFile).toHaveBeenCalledWith({ workspaceId: "ws-1", relativePath: draft.path, initialText: text }));
  });

  it("does not offer Discard while the submission outcome is unknown", async () => {
    renderPage(makeBridge([{ ...record("rec-1", "Socks"), creationDelivery: "pending", creationCanDiscard: false }]));
    await screen.findByText("Saved on this computer. Waiting to send");
    expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  });

  it("keeps ended drafts visible and discards a retry response after unmount", async () => {
    const api = { ...makeBridge([{ ...record("rec-1", "Socks"), creationDelivery: "pending" as const }]),
      pushShareDirectWrites: vi.fn() };
    const pending = deferred<void>();
    api.pushShareDirectWrites.mockReturnValue(pending.promise);
    const onError = vi.fn();
    const view = renderPage(api, undefined, undefined, { onError });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    view.unmount();
    await act(async () => pending.reject(new Error("old workspace")));
    expect(onError).not.toHaveBeenCalled();
    renderPage(api, undefined, undefined, { readOnly: true, accessEnded: true });
    expect(await screen.findByText("Access ended. This draft cannot be sent. It is kept on this computer.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each([
    { accessEnded: true, writeRefusal: undefined },
  ])("refuses an old draft retry after read-only access: $accessEnded, $writeRefusal", async ({ accessEnded, writeRefusal }) => {
    const api = { ...makeBridge([{ ...record("rec-1", "Socks"), creationDelivery: "pending" as const }]),
      pushShareDirectWrites: vi.fn().mockRejectedValueOnce(new Error("offline")) };
    const onError = vi.fn();
    const view = renderPage(api, undefined, undefined, { onError });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const retry = onError.mock.calls[0]![2];
    view.rerender(pageWithHost(undefined, undefined, { onError, readOnly: true, accessEnded, writeRefusal }));
    await act(async () => retry());
    expect(api.pushShareDirectWrites).toHaveBeenCalledOnce();
    const message = writeRefusal ?? (accessEnded ? "Your access to this share ended."
      : "Your access to this share changed. Ask for Edit access, then reopen the share.");
    expect(onError).toHaveBeenLastCalledWith(message, expect.any(Error));
  });

  it("keeps View tables readable without record or definition writes", async () => {
    const bridge = makeBridge([record("rec-1", "Shared task")]);
    renderPage(bridge, undefined, undefined, { readOnly: true });
    await screen.findByText("Shared task");
    expect(screen.queryByTestId("collection-new-record")).toBeNull();
    expect(screen.queryByTestId("collection-fields-button")).toBeNull();
    expect(screen.queryByTestId("collection-views-button")).toBeNull();
    expect(bridge.listAutomationButtons).not.toHaveBeenCalled();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("keeps a remote selection after a coalesced refresh acknowledges a local round trip", async () => {
    const schema: CollectionSchema = {
      ...SCHEMA,
      fields: [...SCHEMA.fields, { name: "tags", type: "multi-select", options: ["alpha", "beta", "gamma"] }],
    };
    const records: CollectionRecord[] = [{
      ...record("rec-1", "Plan"),
      values: [{ field: "tags", value: ["alpha"], validation: { status: "valid" }, resolvedRelations: [] }],
    }];
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    doc.getMap("frontmatter").set("tags", ["alpha"]);
    docMock.current = engineDocState({ available: true, doc });
    const bridge = makeBridge(records, schema);
    const page = renderPage(bridge);
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
    for (let index = 0; index < 2; index += 1) {
      docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saving" } });
      page.rerender(pageWithHost());
      docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saved-here" } });
      page.rerender(pageWithHost());
    }
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(bridge.queryCollectionRecords).toHaveBeenCalledTimes(2);

    doc.getMap("frontmatter").set("tags", ["alpha", "beta"]);
    records[0] = {
      ...records[0]!,
      values: [{ field: "tags", value: ["alpha", "beta"], validation: { status: "valid" }, resolvedRelations: [] }],
    };
    bridge.emitWorkspaceActivity({ workspaceId: "ws-1", paths: ["tasks/Plan.md"] });
    await act(() => vi.advanceTimersByTimeAsync(250));
    fireEvent.click(screen.getByRole("checkbox", { name: "gamma" }));
    expect(doc.getMap("frontmatter").get("tags")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("does not acknowledge a save through an index query that started before it", async () => {
    const schema: CollectionSchema = {
      ...SCHEMA,
      fields: [...SCHEMA.fields, { name: "tags", type: "multi-select", options: ["alpha", "beta", "gamma"] }],
    };
    const records: CollectionRecord[] = [{
      ...record("rec-1", "Plan"),
      values: [{ field: "tags", value: ["alpha"], validation: { status: "valid" }, resolvedRelations: [] }],
    }];
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    doc.getMap("frontmatter").set("tags", ["alpha"]);
    docMock.current = engineDocState({ available: true, doc });
    const bridge = makeBridge(records, schema);
    const page = renderPage(bridge);
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));

    let resolveQuery!: (result: QueryCollectionRecordsResult) => void;
    bridge.queryCollectionRecords.mockReturnValueOnce(new Promise((resolve) => { resolveQuery = resolve; }));
    bridge.emitWorkspaceActivity({ workspaceId: "ws-1", paths: ["tasks/Plan.md"] });
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(bridge.queryCollectionRecords).toHaveBeenCalledTimes(2);

    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saving" } });
    page.rerender(pageWithHost());
    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saved-here" } });
    page.rerender(pageWithHost());
    expect(hasPendingCollectionFieldWrites()).toBe(false);
    await act(async () => resolveQuery({
      collection: { path: "tasks", objectId: "object-test", status: "valid", reasons: [] },
      records,
      groups: null,
      nextCursor: null,
    }));

    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "beta" }).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "gamma" }));
    expect(doc.getMap("frontmatter").get("tags")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("retries a failed record query", async () => {
    const bridge = makeBridge([record("rec-1", "Plan")]);
    bridge.queryCollectionRecords.mockRejectedValueOnce(
      new Error("temporary failure"),
    );
    renderPage(bridge);

    expect(
      await screen.findByText(
        "dohc could not read this collection's records. temporary failure",
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Plan")).toBeDefined();
    expect(bridge.queryCollectionRecords).toHaveBeenCalledTimes(2);
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

  it("owns an accepted option edit before its schema write, so a lineage gate waits it out", async () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
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
    const page = renderPage(bridge);
    await screen.findByText("Plan");

    fireEvent.click(screen.getByText("Todo"));
    const addOption = screen.getByLabelText("Add option");
    fireEvent.change(addOption, { target: { value: "Later" } });
    fireEvent.keyDown(addOption, { key: "Enter" });

    // The accepted edit is in the global queue before any schema IPC
    // settles — the whole point: a version or path operation now sees it.
    expect(hasPendingCollectionFieldWrites()).toBe(true);

    let release: (() => void) | null = null;
    let operation!: Promise<unknown>;
    act(() => {
      operation = beginCollectionLineageOperation("ws-1").then(
        (r) => (release = r),
      );
    });
    // Navigation unmounts the page (the host stays, as in the shell); the
    // gate must keep waiting while the schema write is in flight, so the
    // next lineage can never see this edit land on it.
    page.rerender(
      <>
        {null}
        <CollectionFieldWriteHost />
      </>,
    );
    await act(async () => {});
    expect(release).toBeNull();
    expect(doc.getMap("frontmatter").get("status")).toBeUndefined();

    await act(async () => {
      releaseWrite();
    });
    await waitFor(() =>
      expect(doc.getMap("frontmatter").get("status")).toBe("Later"),
    );
    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saving" } });
    page.rerender(
      <>
        {null}
        <CollectionFieldWriteHost />
      </>,
    );
    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saved-here" } });
    page.rerender(
      <>
        {null}
        <CollectionFieldWriteHost />
      </>,
    );
    await act(async () => {
      await operation;
    });
    expect(release).not.toBeNull();
    act(() => release!());
    expect(hasPendingCollectionFieldWrites()).toBe(false);
  });

  it("retains a rejected option edit after the page unmounts and retries it whole", async () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const bridge = makeBridge([selectRecord()], SELECT_SCHEMA);
    bridge.writeWorkspaceText.mockImplementationOnce(async () => {
      throw new Error("Write stopped because this window changed workspaces.");
    });
    const page = renderPage(bridge);
    await screen.findByText("Plan");

    fireEvent.click(screen.getByText("Todo"));
    const addOption = screen.getByLabelText("Add option");
    fireEvent.change(addOption, { target: { value: "Later" } });
    fireEvent.keyDown(addOption, { key: "Enter" });
    page.rerender(
      <>
        {null}
        <CollectionFieldWriteHost />
      </>,
    );

    // The rejection lands after navigation: the accepted value is retained
    // whole — option included — not lost in an unmounted page's closure.
    await waitFor(() => expect(collectionWriteFailures()).toHaveLength(1));
    const failure = collectionWriteFailures()[0]!;
    expect(failure.change.value).toBe("Later");
    expect(failure.createOption).toBe("Later");
    expect(hasPendingCollectionFieldWrites()).toBe(false);

    // Retry replays the whole edit: the schema write did not land, so the
    // option is recreated first, then the value reaches the record.
    docMock.current = engineDocState({ available: true, doc });
    act(() => retryCollectionFieldWrite(failure.id));
    await waitFor(() =>
      expect(doc.getMap("frontmatter").get("status")).toBe("Later"),
    );
    expect(lastWrittenSchema(bridge).schema.fields[1]).toEqual({
      name: "status",
      type: "select",
      options: ["Todo", "Later"],
    });
    expect(collectionWriteFailures()).toHaveLength(0);
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
    // The create form stays mounted through the refresh, so scope to the
    // rename input rather than the ambiguous display value.
    fireEvent.change(screen.getByLabelText("New view name"), {
      target: { value: "My board" },
    });
    fireEvent.click(screen.getByText("Save view"));
    await waitFor(() =>
      expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    expect(
      lastWrittenSchema(bridge).schema.views.map((view) => view.name),
    ).toEqual(["My board"]);

    // Deleting a view drops its configuration, so one click only arms the
    // button; the confirming click runs the rewrite.
    fireEvent.click(await screen.findByLabelText("Delete view My board"));
    // Arming swaps the control for the danger confirm under the same name.
    const confirmButton = screen.getByLabelText("Delete view My board");
    expect(confirmButton.textContent).toBe("Confirm delete");
    expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(2);
    fireEvent.click(confirmButton);
    await waitFor(() =>
      expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(3),
    );
    expect(lastWrittenSchema(bridge).schema.views).toEqual([]);
  });

});

const CHECKBOX_SCHEMA: CollectionSchema = {
  name: "Tasks",
  description: null,
  fields: [
    { name: "title", type: "text" },
    { name: "done", type: "checkbox" },
  ],
  views: [],
};

describe("cell write queue", () => {

  it("keeps a queued edit and finishes it after the page unmounts", async () => {
    // The queue lives outside the page and the shell hosts the writer:
    // unmounting the page (a tab switch) with the head save pending must not
    // drop the edit queued behind it.
    const withCheckbox = (id: string, title: string): CollectionRecord => {
      const base = record(id, title);
      return {
        ...base,
        values: [
          ...base.values,
          {
            field: "done",
            value: false,
            validation: { status: "valid" },
            resolvedRelations: [],
          },
        ],
      };
    };
    const firstDoc = new Y.Doc();
    firstDoc.getMap("frontmatter").set("id", "rec-1");
    const nextDoc = new Y.Doc();
    nextDoc.getMap("frontmatter").set("id", "rec-2");
    const docFor = (saveState: UseEngineDoc["saveState"]) => (input: unknown) =>
      (input as { path: string }).path === "tasks/Plan.md"
        ? engineDocState({ available: true, doc: firstDoc, saveState })
        : engineDocState({ available: true, doc: nextDoc });
    docMock.current = docFor({ kind: "saved-here" });
    const bridge = makeBridge(
      [withCheckbox("rec-1", "Plan"), withCheckbox("rec-2", "Ship")],
      CHECKBOX_SCHEMA,
    );
    vi.stubGlobal("dohcDesktop", bridge);
    // The host in its own root, standing in for the shell: it must outlive
    // the page below exactly as the shell outlives a closed tab.
    const host = render(<CollectionFieldWriteHost />);
    const page = render(
      <CollectionPage
        workspaceId="ws-1"
        collectionPath="tasks"
        activeViewName={null}
        onActiveViewChange={() => undefined}
        onNewRecord={() => undefined}
        onOpenRecord={() => undefined}
        {...SHELL_PROPS}
      />,
    );
    await screen.findByText("Plan");

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[1]!);
    // The head reached its doc and its save is still pending; the second
    // edit waits behind it.
    expect(firstDoc.getMap("frontmatter").get("done")).toBe(true);
    expect(nextDoc.getMap("frontmatter").has("done")).toBe(false);

    page.unmount();

    // The pending head settles only now, after the page is gone.
    docMock.current = docFor({ kind: "saving" });
    host.rerender(<CollectionFieldWriteHost />);
    docMock.current = docFor({ kind: "saved-here" });
    host.rerender(<CollectionFieldWriteHost />);

    await waitFor(() =>
      expect(nextDoc.getMap("frontmatter").get("done")).toBe(true),
    );
  });

  it("disables cell editing and says so while a write operation is in progress", async () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const base = record("rec-1", "Plan");
    const checkboxRecord: CollectionRecord = {
      ...base,
      values: [
        ...base.values,
        {
          field: "done",
          value: false,
          validation: { status: "valid" },
          resolvedRelations: [],
        },
      ],
    };
    const bridge = makeBridge([checkboxRecord], CHECKBOX_SCHEMA);
    renderPage(bridge);
    await screen.findByText("Plan");

    let guard!: ReturnType<typeof beginCollectionWriteOperation>;
    act(() => {
      guard = beginCollectionWriteOperation("ws-1");
    });
    // The header says why, and the cell no longer accepts an edit.
    await screen.findByTestId("collection-writes-paused");
    expect(
      (screen.getByRole("checkbox") as HTMLInputElement).disabled,
    ).toBe(true);

    act(() => guard.release());
    await waitFor(() =>
      expect(screen.queryByTestId("collection-writes-paused")).toBeNull(),
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(doc.getMap("frontmatter").get("done")).toBe(true);
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

describe("record click-through", () => {

  it("reports a board column color that could not be saved, with a retry", async () => {
    const bridge = makeBridge([selectRecord()], BOARD_SCHEMA, {
      groups: [{ value: "Todo", records: [selectRecord()] }],
    });
    bridge.writeWorkspaceText.mockRejectedValueOnce(new Error("disk full"));
    const onError = vi.fn<CollectionPageProps["onError"]>();
    renderPage(bridge, undefined, undefined, { onError });

    fireEvent.click(await screen.findByRole("button", { name: "Todo options" }));
    fireEvent.click(screen.getByRole("radio", { name: "Plum" }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const [message, , retry] = onError.mock.calls[0]!;
    expect(message).toMatch(/^dohc could not update this collection\./);
    retry!();
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(2));
    expect(lastWrittenSchema(bridge).schema.fields[1]).toMatchObject({ colors: { Todo: "plum" } });
  });

});

describe("pagination", () => {
  it("retries a near-end page after observation refresh replaces a pending page", async () => {
    const bridge = makeBridge([]);
    const firstRecords = Array.from({ length: 100 }, (_, n) => record(`rec-${n}`, `Task ${n}`));
    const cursor = { sortValues: [], recordPath: "tasks/99.md", recordId: "rec-99" };
    const second = deferred<QueryCollectionRecordsResult>();
    const result = (records: CollectionRecord[], nextCursor: typeof cursor | null): QueryCollectionRecordsResult => ({
      collection: { path: "tasks", objectId: "object-test", status: "valid", reasons: [] }, records, groups: null, nextCursor,
    });
    let pages = 0;
    bridge.queryCollectionRecords.mockImplementation(async params => {
      if (!("cursor" in params)) return result(firstRecords, cursor);
      if (++pages === 1) return second.promise;
      return result([record("last", "Last record")], null);
    });
    const { container } = renderPage(bridge);
    await waitFor(() => expect(screen.getByRole("grid").getAttribute("aria-rowcount")).toBe("102"));
    const scroller = container.querySelector<HTMLElement>("[role=grid]")!;
    scroller.scrollTop = 2800;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(pages).toBe(1));
    bridge.emitWorkspaceActivity({ workspaceId: "ws-1", paths: ["tasks/changed.md"], pathSetChanged: false });
    await waitFor(() => expect(pages).toBe(2));
    await act(async () => { second.resolve(result([record("stale", "Stale record")], null)); await second.promise; });
    await waitFor(() => expect(screen.getByRole("grid").getAttribute("aria-rowcount")).toBe("103"));
    expect(screen.queryByText("Stale record")).toBeNull();
  });

  // Serves the engine's paged shape: each page but the last carries a
  // cursor, and a request with `cursor` serves the page after it.
  function servePages(
    bridge: ReturnType<typeof makeBridge>,
    pages: { records: CollectionRecord[]; groups: CollectionRecordGroup[] | null }[],
  ) {
    const cursorFor = (page: number) => ({
      sortValues: [{ present: true, value: String(page) }],
      recordPath: `tasks/page-${page}.md`,
      recordId: `page-${page}`,
    });
    bridge.queryCollectionRecords.mockImplementation(async (params) => {
      const { cursor } = params as { cursor?: { recordId: string } };
      const index = cursor
        ? Number(cursor.recordId.slice("page-".length)) + 1
        : 0;
      const page = pages[index];
      if (!page) throw new Error(`no page ${index}`);
      return {
        collection: { path: "tasks", objectId: "object-test", status: "valid", reasons: [] },
        records: page.records,
        groups: page.groups,
        nextCursor: index + 1 < pages.length ? cursorFor(index) : null,
      };
    });
  }

  function statusRecord(id: string, title: string): CollectionRecord {
    return {
      ...record(id, title),
      values: [
        ...record(id, title).values,
        {
          field: "status",
          value: "Todo",
          validation: { status: "valid" },
          resolvedRelations: [],
        },
      ],
    };
  }

  it("drains every page so a board view places all cards", async () => {
    const bridge = makeBridge([], BOARD_SCHEMA);
    const pageOne = statusRecord("rec-1", "Plan");
    const pageTwo = statusRecord("rec-2", "Ship");
    servePages(bridge, [
      { records: [pageOne], groups: [{ value: "Todo", records: [pageOne] }] },
      { records: [pageTwo], groups: [{ value: "Todo", records: [pageTwo] }] },
    ]);
    renderPage(bridge);

    expect(await screen.findByText("Plan")).toBeDefined();
    expect(await screen.findByText("Ship")).toBeDefined();
    expect(bridge.queryCollectionRecords).toHaveBeenCalledTimes(2);
    expect(bridge.queryCollectionRecords).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: expect.objectContaining({ recordId: "page-0" }),
      }),
    );
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
    doc.getMap("frontmatter").set("id", "rec-1");
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

describe("Button fields", () => {
  const BUTTON_SCHEMA: CollectionSchema = {
    ...SCHEMA,
    fields: [...SCHEMA.fields, { name: "Mark paid", type: "button" }, { name: "Archive", type: "button" }],
  };
  const READY: AutomationButtonState = { kind: "ready", automationId: "collection:tasks#paid" };
  const buttonsWith = (extra: Parameters<typeof makeBridge>[2] = {}) =>
    makeBridge([record("rec-1", "Invoice 12")], BUTTON_SCHEMA, {
      buttons: [
        { field: "Mark paid", state: READY },
        { field: "Archive", state: { kind: "no-automation", reason: "No automation uses this button." } },
      ],
      ...extra,
    });

  it("presses a button for its record, stays busy until the run settles, and shows the result", async () => {
    const bridge = buttonsWith();
    vi.stubGlobal("dohcDesktop", bridge);
    const onNotice = vi.fn();
    render(pageWithHost(undefined, undefined, { onNotice }));
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Mark paid for Invoice 12" })).toBe(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await waitFor(() => expect(bridge.pressAutomationButton).toHaveBeenCalledTimes(1));
    const pressed = bridge.pressAutomationButton.mock.calls[0]![0];
    expect(pressed).toEqual({ workspaceId: "ws-1", collectionPath: "tasks", field: "Mark paid", recordId: "rec-1", pressId: expect.any(String), confirmed: [] });
    expect(pressed.pressId).toMatch(/^[0-9a-f-]{36}$/);
    act(() => bridge.emitRunWaiting({ workspaceId: "ws-1", claimId: "atc_press", reason: "roster" }));
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent)
      .toBe("Waiting to check who can edit this Collection.");
    act(() => bridge.emitRunSettled({ workspaceId: "ws-1", claimId: "atc_press", outcome: "done", error: null }));
    expect(onNotice).toHaveBeenCalledWith("Ran Mark paid on Invoice 12");
    expect(button.getAttribute("aria-busy")).toBeNull();
  });

  it("says why a button cannot run, and does not press it", async () => {
    const bridge = buttonsWith();
    vi.stubGlobal("dohcDesktop", bridge);
    render(pageWithHost());
    const button = await screen.findByRole("button", { name: "Archive for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-describedby")).not.toBeNull());
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const words = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(words.textContent).toBe("No automation uses this button.");
    expect(words.hidden).toBe(true);
    fireEvent.focus(button);
    expect(words.hidden).toBe(false);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(words.hidden).toBe(true);
    fireEvent.click(button);
    expect(bridge.pressAutomationButton).not.toHaveBeenCalled();
  });

  it("drops a closed workspace's runs, so their end does not report", async () => {
    const bridge = buttonsWith();
    vi.stubGlobal("dohcDesktop", bridge);
    const onNotice = vi.fn(), onError = vi.fn();
    const page = render(pageWithHost(undefined, undefined, { onNotice, onError }));
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    await waitFor(() => expect(bridge.pressAutomationButton).toHaveBeenCalled());
    await act(async () => undefined);
    page.unmount();
    disposeAutomationButtons("ws-1");
    act(() => bridge.emitRunSettled({ workspaceId: "ws-1", claimId: "atc_press", outcome: "done", error: null }));
    expect(onNotice).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

});

describe("a calendar view without a date field", () => {
  const schema: CollectionSchema = { ...CALENDAR_SCHEMA, fields: [{ name: "title", type: "text" }],
    views: [{ ...CALENDAR_SCHEMA.views[0]!, dateField: null }] };

  it("asks for one and opens Fields on a new Date field", async () => {
    renderPage(makeBridge([record("rec-1", "Plan")], schema));

    expect(await screen.findByText("A calendar needs a date field.")).toBeDefined();
    expect(screen.queryByRole("grid")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a date field" }));
    const dialog = await screen.findByTestId("collection-fields-dialog");
    expect((within(dialog).getByLabelText("Field type") as HTMLSelectElement).value).toBe("date");
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Field name"));
  });

  it("leaves the button out for someone who cannot change fields", async () => {
    renderPage(makeBridge([record("rec-1", "Plan")], schema), undefined, undefined, { readOnly: true });

    expect(await screen.findByText("A calendar needs a date field.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Add a date field" })).toBeNull();
  });
});
