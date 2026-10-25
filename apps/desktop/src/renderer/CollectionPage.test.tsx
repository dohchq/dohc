// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  AutomationRunSettledEvent,
  AutomationRunWaitingEvent,
  GetCollectionResult,
  ListAutomationButtonsResult,
  PressAutomationButtonPayload,
  PressAutomationButtonResult,
  QueryCollectionRecordsResult,
  WorkspaceActivityEvent,
} from "../ipc/bridgeContract";
import type { AutomationButtonState } from "@dohc/automation-executor/automation-buttons";
import { CollectionPage, DRAIN_RECORD_LIMIT, type CollectionPageProps } from "./CollectionPage";
import { CustomizeContext } from "./settings/customize";
import { documentCollectionFiles } from "./collections/CollectionCustomizeDialog";
import { automationButtonsFor, disposeAutomationButtons, resetAutomationButtonsForTests } from "./collections/useAutomationButtons";
import { deferred } from "../testing/deferred";
import {
  beginCollectionWriteOperation,
  enqueueCollectionFieldWrite,
  CollectionFieldWriteHost,
  collectionWriteFailures,
  CollectionRecordFieldWrite,
  FILE_LOCKED_REPORT_MS,
  frontmatterWriteValue,
  hasPendingCollectionFieldWrites,
  resetCollectionFieldWritesForTests,
  retryCollectionFieldWrite,
  setCollectionFieldWriteAccess,
} from "./collections/recordFieldWrites";
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
  onNewRecord: (collectionPath: string) => void = () => undefined,
  onOpenRecord: (recordPath: string) => void = () => undefined,
  view?: {
    readOnly?: boolean;
    accessEnded?: boolean;
    writeRefusal?: string;
    activeViewName?: string | null;
    onActiveViewChange?: (viewName: string | null) => void;
    onError?: CollectionPageProps["onError"];
    onNotice?: CollectionPageProps["onNotice"];
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
      />
      <CollectionFieldWriteHost />
    </>
  );
}

function renderPage(
  bridge: ReturnType<typeof makeBridge>,
  onNewRecord: (collectionPath: string) => void = () => undefined,
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

  it("drops accepted creations from the attention strip", async () => {
    renderPage(makeBridge([{ ...record("rec-1", "Socks"), creationDelivery: "accepted" }]));
    await screen.findByText("Socks");
    expect(screen.queryByTestId("collection-record-drafts")).toBeNull();
  });

  it("shows the relay refusal reason", async () => {
    renderPage(makeBridge([{ ...record("rec-1", "Socks"), creationDelivery: "refused", creationRefusal: "This record name is taken." }]));
    expect(await screen.findByText("This record name is taken.")).toBeTruthy();
  });

  it("does not offer Discard while the submission outcome is unknown", async () => {
    renderPage(makeBridge([{ ...record("rec-1", "Socks"), creationDelivery: "pending", creationCanDiscard: false }]));
    await screen.findByText("Saved on this computer. Waiting to send");
    expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  });

  it("shows the race winner without a creation strip when creation status clears", async () => {
    const records: CollectionRecord[] = [{ ...record("loser", "Socks"), creationDelivery: "refused", creationRefusal: "This record name is taken." }];
    const api = makeBridge(records);
    const onOpenRecord = vi.fn();
    renderPage(api, undefined, onOpenRecord);
    await screen.findByText("This record name is taken.");
    records.splice(0, 1, record("winner", "Socks"));
    act(() => api.emitWorkspaceActivity({ workspaceId: "ws-1", paths: ["tasks/Socks.md"] }));
    await waitFor(() => expect(screen.queryByTestId("collection-record-drafts")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open Socks" }));
    expect(onOpenRecord).toHaveBeenCalledWith("tasks/Socks.md");
    expect(screen.queryByTestId("collection-record-drafts")).toBeNull();
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

  it.each(["offline", "refused"] as const)("explains that an ended %s draft cannot be sent", async creationDelivery => {
    renderPage(makeBridge([{ ...record("rec-1", "Socks"), creationDelivery }]), undefined, undefined, { readOnly: true, accessEnded: true });
    await screen.findByText("Access ended. This draft cannot be sent. It is kept on this computer.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each([
    { accessEnded: true, writeRefusal: undefined },
    { accessEnded: false, writeRefusal: undefined },
    { accessEnded: false, writeRefusal: "This share must be reopened." },
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

  it.each(["View access", "damaged share"])("does not call %s ended access", async () => {
    renderPage(makeBridge([{ ...record("rec-1", "Socks"), creationDelivery: "pending" }]), undefined, undefined, {readOnly: true});
    await screen.findByText("This draft cannot be sent with the current share access. It is kept on this computer.");
    expect(screen.queryByText(/Access ended/)).toBeNull();
    expect(screen.queryByRole("button", {name: "Try again"})).toBeNull();
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
  it("reloads initially empty Buttons when the automation index changes in this workspace", async () => {
    const bridge = makeBridge([record("rec-1", "Plan")], {
      ...SCHEMA, fields: [...SCHEMA.fields, { name: "Finish", type: "button" }],
    });
    renderPage(bridge);
    await screen.findByText("Plan");
    await waitFor(() => expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(1));
    bridge.listAutomationButtons.mockResolvedValue({ buttons: [
      { field: "Finish", state: { kind: "ready", automationId: "collection:tasks#finish" } },
    ] });
    act(() => bridge.emitAutomationsChanged("ws-2"));
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(1);
    act(() => bridge.emitAutomationsChanged("ws-1"));
    await waitFor(() => expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Finish for Plan" }).getAttribute("aria-disabled")).toBeNull());
  });

  it("reports real Buttons read errors through the shell error hook with retry", async () => {
    const bridge = makeBridge([]);
    const error = new Error("The workspace engine is not running.");
    bridge.listAutomationButtons.mockRejectedValueOnce(error);
    const onError = vi.fn();
    renderPage(bridge, undefined, undefined, { onError });
    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      "dohc could not read this Collection's buttons.", error, expect.any(Function),
    ));
    act(() => onError.mock.calls[0]![2]());
    await waitFor(() => expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(2));
  });

  it("reports nothing while the workspace's files are still being read, and reads Buttons again when main says the read finished", async () => {
    const bridge = makeBridge([record("rec-1", "Plan")], {
      ...SCHEMA, fields: [...SCHEMA.fields, { name: "Finish", type: "button" }],
    });
    bridge.listAutomationButtons.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'desktop:list-automation-buttons': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
    ));
    const onError = vi.fn();
    renderPage(bridge, undefined, undefined, { onError });
    await screen.findByText("Plan");
    await waitFor(() => expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(onError).not.toHaveBeenCalled();
    // The button waits for the read instead of offering Check again.
    expect(screen.queryByRole("button", { name: "Check Finish for Plan again" })).toBeNull();
    bridge.listAutomationButtons.mockResolvedValue({ buttons: [
      { field: "Finish", state: { kind: "ready", automationId: "collection:tasks#finish" } },
    ] });
    vi.useFakeTimers();
    // What main sends when the engine announces capture.initialSettled.
    bridge.emitWorkspaceActivity({ workspaceId: "ws-1", pathSetChanged: false });
    await act(() => vi.advanceTimersByTimeAsync(250));
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByRole("button", { name: "Finish for Plan" }).getAttribute("aria-disabled")).toBeNull());
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("names a newer Collection file and asks to update dohc", async () => {
    const bridge = makeBridge([]);
    bridge.getCollection.mockResolvedValue({ path: "tasks", objectId: "object-test", status: "degraded", reasons: [{ code: "unsupported-version", path: "/version" }],
      schema: { name: null, description: null, fields: [], views: [] }, recordCount: 0 });
    renderPage(bridge);
    expect(await screen.findByText("tasks/collection.yaml uses a newer version. Update dohc to read this file.")).toBeDefined();
    expect(screen.queryByTestId("collection-page")).toBeNull();
  });
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

  it("shows the columns and a New record row for an empty collection", async () => {
    const bridge = makeBridge([]);
    const onNewRecord = vi.fn();
    renderPage(bridge, onNewRecord);

    const grid = await screen.findByRole("grid");
    expect(within(grid).getAllByRole("columnheader").length).toBeGreaterThan(0);
    expect(screen.queryByText("No records in this collection yet.")).toBeNull();
    expect(screen.getByTestId("collection-fields-button")).toBeDefined();
    expect(screen.getByTestId("collection-views-button")).toBeDefined();

    fireEvent.click(within(grid).getByRole("button", { name: "New record" }));
    fireEvent.click(screen.getByTestId("collection-new-record"));
    expect(onNewRecord.mock.calls).toEqual([["tasks"], ["tasks"]]);
  });

  it("names the Collection's files from Customize… and hands them to the agent", async () => {
    const bridge = makeBridge([]);
    const ask = vi.fn();
    vi.stubGlobal("dohcDesktop", bridge);
    render(
      <CustomizeContext.Provider value={{ customize: vi.fn(), askAgent: { ready: true, ask, setUp: vi.fn() } }}>
        {pageWithHost(() => undefined, () => undefined)}
      </CustomizeContext.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Collection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Customize…" }));
    const dialog = await screen.findByRole("dialog", { name: "Customize Tasks" });
    expect(within(dialog).getByText("tasks/collection.yaml")).toBeDefined();
    expect(within(dialog).getByText("tasks/automations.yaml")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Ask my agent" }));
    expect(ask).toHaveBeenCalledExactlyOnceWith({
      kind: "collection", name: "Tasks", files: documentCollectionFiles("tasks"),
    });
    expect(screen.queryByRole("dialog", { name: "Customize Tasks" })).toBeNull();

    // Escape returns focus to the menu's button.
    const trigger = screen.getByRole("button", { name: "Collection actions" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Customize…" }));
    await screen.findByRole("dialog", { name: "Customize Tasks" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Customize Tasks" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("counts the Collection's automations in the header and docks the ⚡ panel beside the view", async () => {
    const bridge = makeBridge([record("rec-1", "Plan")]);
    const automations = { status: "read" as const, contentHash: hashFor(0), automations: [
      { valid: false as const, id: "a", name: "A", diagnostics: [] },
      { valid: false as const, id: "b", name: "B", diagnostics: [] },
    ] };
    bridge.listCollectionAutomations.mockResolvedValue(automations as never);
    Object.assign(bridge, {
      onAutomationRunsChanged: () => () => undefined,
      onAutomationHoldsChanged: () => () => undefined,
    });
    renderPage(bridge);

    const button = await screen.findByTestId("collection-automations-button");
    await waitFor(() => expect(button.textContent).toBe("Automations2"));
    expect(button.getAttribute("aria-pressed")).toBe("false");
    // Opening reads the list again: last runs change without the file changing.
    const readsBeforeOpen = bridge.listCollectionAutomations.mock.calls.length;
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(bridge.listCollectionAutomations.mock.calls.length).toBe(readsBeforeOpen + 1));
    const panel = screen.getByTestId("collection-automations-panel");
    expect(panel.getAttribute("aria-label")).toBe("Automations");
    fireEvent.click(within(panel).getByRole("button", { name: "Close automations" }));
    expect(screen.queryByTestId("collection-automations-panel")).toBeNull();

    // Only a change to automations.yaml reads them again while the panel is closed.
    const reads = bridge.listCollectionAutomations.mock.calls.length;
    const queries = bridge.queryCollectionRecords.mock.calls.length;
    act(() => bridge.emitWorkspaceActivity({ workspaceId: "ws-1", paths: ["tasks/Plan.md"] }));
    await waitFor(() => expect(bridge.queryCollectionRecords.mock.calls.length).toBe(queries + 1));
    expect(bridge.listCollectionAutomations.mock.calls.length).toBe(reads);
    act(() => bridge.emitWorkspaceActivity({ workspaceId: "ws-1", paths: ["tasks/automations.yaml"] }));
    await waitFor(() => expect(bridge.listCollectionAutomations.mock.calls.length).toBe(reads + 1));
  });

  it("forgets a notice's ask when the panel closes, so the next open shows the list", async () => {
    const bridge = makeBridge([record("rec-1", "Plan")]);
    const stamp = {
      id: "stamp", name: "Stamp", enabled: true, if: null,
      when: { kind: "record-added" as const, table: null },
      do: [{ kind: "set" as const, values: [{ field: "title", value: { kind: "literal" as const, value: "x" } }], records: null, operation: null }],
    };
    Object.assign(bridge, {
      listCollectionAutomations: vi.fn(async () => ({ status: "read", contentHash: hashFor(0), addsStay: [], automations: [{
        valid: true, automationId: "collection:tasks#stamp", automation: stamp, definitionHash: "0123456789abcdef",
        cannotRun: null, reach: { kind: "checked", steps: [{ verdict: "allowed" }] }, lastRun: null,
      }] })),
      listCollectionAutomationRuns: vi.fn(async () => ({ status: "listed", runs: [], next: null })),
      onAutomationRunsChanged: () => () => undefined,
      listServerAutomationRuns: vi.fn(async () => ({ runs: null })),
      onAutomationHoldsChanged: () => () => undefined,
    });
    vi.stubGlobal("dohcDesktop", bridge);
    const page = (focus: { automationId: string; run: string | null; seq: number } | null) => (
      <CollectionPage
        workspaceId="ws-1"
        collectionPath="tasks"
        activeViewName={null}
        onActiveViewChange={() => undefined}
        onNewRecord={() => undefined}
        onOpenRecord={() => undefined}
        {...SHELL_PROPS}
        automationFocus={focus}
      />
    );
    const { rerender } = render(page({ automationId: "collection:tasks#stamp", run: null, seq: 1 }));
    expect(await screen.findByText("This automation has not run on this computer yet.")).toBeDefined();
    // The shell clears its ask once the page took it.
    rerender(page(null));
    fireEvent.click(screen.getByRole("button", { name: "Close automations" }));
    fireEvent.click(screen.getByTestId("collection-automations-button"));
    expect(await screen.findByTestId("automation-stamp")).toBeDefined();
    expect(screen.queryByText("This automation has not run on this computer yet.")).toBeNull();
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
    // Another workspace's activity, even without path detail, is not ours.
    bridge.emitWorkspaceActivity({ workspaceId: "ws-2" });
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

  it("re-queries when activity refreshes the active view's sort", async () => {
    const view = {
      name: "Table",
      kind: "table" as const,
      groupBy: null,
      sort: [],
      visibleFields: null,
      dateField: null,
    };
    const bridge = makeBridge([record("rec-1", "Plan")], {
      ...SCHEMA,
      views: [view],
    });
    renderPage(bridge);
    await waitFor(() =>
      expect(bridge.queryCollectionRecords).toHaveBeenCalledOnce(),
    );

    await bridge.writeWorkspaceText({
      text: serializeCollectionSchema({
        ...SCHEMA,
        views: [
          {
            ...view,
            sort: [{ field: "title", direction: "desc" }],
          },
        ],
      }),
      expectedContentHash: hashFor(0),
    });
    vi.useFakeTimers();
    bridge.emitWorkspaceActivity({
      workspaceId: "ws-1",
      paths: ["tasks/collection.yaml"],
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(bridge.queryCollectionRecords).toHaveBeenCalledTimes(3);
    expect(bridge.queryCollectionRecords).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      collectionPath: "tasks",
      sort: [{ field: "title", direction: "desc" }],
      resolveRelations: true,
    });
  });

  it.each([false, true])(
    "coalesces settled writes with activity and cancels on unmount (%s)",
    async (unmount) => {
      const records = [record("rec-1", "Plan"), record("rec-2", "Ship")].map(
        (item) => ({
          ...item,
          values: [
            ...item.values,
            {
              field: "done",
              value: false,
              validation: { status: "valid" as const },
              resolvedRelations: [],
            },
          ],
        }),
      );
      const docs = records.map((item) => {
        const doc = new Y.Doc();
        doc.getMap("frontmatter").set("id", item.id);
        return doc;
      });
      const saves: UseEngineDoc["saveState"][] = [{ kind: "saved-here" }, { kind: "saved-here" }];
      docMock.current = (input) => {
        const index = records.findIndex(
          (item) => item.path === (input as { path: string }).path,
        );
        return engineDocState({ available: true, doc: docs[index]!, saveState: saves[index]! });
      };
      const bridge = makeBridge(records, CHECKBOX_SCHEMA);
      const page = renderPage(bridge);
      await screen.findByText("Plan");
      expect(bridge.queryCollectionRecords).toHaveBeenCalledOnce();
      vi.useFakeTimers();

      for (const checkbox of screen.getAllByRole("checkbox")) {
        fireEvent.click(checkbox);
      }
      for (let index = 0; index < records.length; index += 1) {
        expect(docs[index]!.getMap("frontmatter").get("done")).toBe(true);
        saves[index] = { kind: "saving" };
        page.rerender(pageWithHost());
        saves[index] = { kind: "saved-here" };
        page.rerender(pageWithHost());
        await act(() => vi.advanceTimersByTimeAsync(50));
      }
      expect(hasPendingCollectionFieldWrites()).toBe(false);
      bridge.emitWorkspaceActivity({ workspaceId: "ws-1", paths: ["tasks/Plan.md"] });
      expect(bridge.queryCollectionRecords).toHaveBeenCalledOnce();

      if (unmount) page.unmount();
      await act(() => vi.advanceTimersByTimeAsync(250));
      expect(bridge.queryCollectionRecords).toHaveBeenCalledTimes(unmount ? 1 : 2);
    },
  );

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

  it.each([2, 3])("retries the latest of %i rapid toggles after earlier progress without an index refresh", async (count) => {
    const schema: CollectionSchema = {
      ...SCHEMA,
      fields: [...SCHEMA.fields, { name: "tags", type: "multi-select", options: ["alpha", "beta", "gamma", "delta"] }],
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
    fireEvent.click(screen.getByRole("checkbox", { name: "gamma" }));
    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saving" } });
    page.rerender(pageWithHost());
    // The first write settles; the second writer cannot open its session.
    docMock.current = engineDocState({ available: false, doc, saveState: { kind: "saved-here" } });
    page.rerender(pageWithHost());
    expect(doc.getMap("frontmatter").get("tags")).toEqual(["alpha", "beta"]);
    expect(collectionWriteFailures()).toHaveLength(1);
    if (count === 3) fireEvent.click(screen.getByRole("checkbox", { name: "delta" }));
    const latest = collectionWriteFailures().at(-1)!;
    const desired = count === 3 ? ["alpha", "beta", "gamma", "delta"] : ["alpha", "beta", "gamma"];
    expect(latest.change.value).toEqual(desired);
    docMock.current = engineDocState({ available: true, doc });
    act(() => retryCollectionFieldWrite(latest.id));
    expect(doc.getMap("frontmatter").get("tags")).toEqual(desired);
    expect(collectionWriteFailures()).toHaveLength(count === 3 ? 1 : 0);
    expect(collectionWriteFailures().every((failure) => failure.superseded)).toBe(true);
    expect(bridge.queryCollectionRecords).toHaveBeenCalledTimes(1);
  });

  it.each(["retry", "discard"] as const)("keeps an open multi-select consistent after %s of retained input", async (action) => {
    const schema: CollectionSchema = {
      ...SCHEMA,
      fields: [...SCHEMA.fields, { name: "tags", type: "multi-select", options: ["alpha", "beta", "gamma"] }],
    };
    const records: CollectionRecord[] = [{
      ...record("rec-1", "Plan"),
      values: [{ field: "tags", value: ["alpha"], validation: { status: "valid" }, resolvedRelations: [] }],
    }];
    docMock.current = engineDocState({ available: false });
    const bridge = makeBridge(records, schema);
    renderPage(bridge);
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("checkbox", { name: "gamma" }));
    expect(collectionWriteFailures()[0]?.change.value).toEqual(["alpha", "gamma"]);

    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    doc.getMap("frontmatter").set("tags", ["alpha", "beta"]);
    docMock.current = engineDocState({ available: true, doc });
    records[0] = {
      ...records[0]!,
      values: [{ field: "tags", value: ["alpha", "beta"], validation: { status: "valid" }, resolvedRelations: [] }],
    };
    bridge.emitWorkspaceActivity({ workspaceId: "ws-1", paths: ["tasks/Plan.md"] });
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "beta" }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "gamma" }).checked).toBe(true);

    fireEvent.click(screen.getByTestId(`collection-write-${action}`));
    expect(doc.getMap("frontmatter").get("tags")).toEqual(["alpha", "beta"]);
    if (action === "retry") {
      expect(collectionWriteFailures()[0]).toMatchObject({ recoveryOnly: true, change: { value: ["alpha", "gamma"] } });
      expect(screen.getByTestId("collection-write-retry")).toHaveProperty("disabled", true);
    } else {
      expect(collectionWriteFailures()).toEqual([]);
      expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "gamma" }).checked).toBe(false);
      fireEvent.click(screen.getByRole("checkbox", { name: "alpha" }));
      expect(doc.getMap("frontmatter").get("tags")).toEqual(["beta"]);
    }
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

  it("says only what failed when the refusal names nothing a person can act on", async () => {
    const bridge = makeBridge([record("rec-1", "Plan")]);
    bridge.getCollection.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'desktop:get-collection': DaemonRefusalError [INVALID_PARAMS]: invalid-input",
    ));
    renderPage(bridge);

    const failure = await screen.findByTestId("collection-error");
    expect(failure.querySelector("span")?.textContent).toBe("dohc could not load this collection.");
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

const TWO_VIEW_SCHEMA: CollectionSchema = {
  name: "Tasks",
  description: null,
  fields: [{ name: "title", type: "text" }],
  views: [
    {
      name: "All",
      kind: "table",
      groupBy: null,
      sort: [],
      visibleFields: null,
      dateField: null,
    },
    {
      name: "Sorted",
      kind: "table",
      groupBy: null,
      sort: [{ field: "title", direction: "desc" }],
      visibleFields: null,
      dateField: null,
    },
  ],
};

describe("view persistence", () => {
  // The open view is per-user local state the shell stores in the workbench
  // UI state; the page only reflects and reports it.
  it("opens the stored view instead of the schema's first", async () => {
    const bridge = makeBridge([record("rec-1", "Plan")], TWO_VIEW_SCHEMA);
    renderPage(bridge, undefined, undefined, { activeViewName: "Sorted" });

    await waitFor(() =>
      expect(bridge.queryCollectionRecords).toHaveBeenCalledOnce(),
    );
    expect(bridge.queryCollectionRecords).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      collectionPath: "tasks",
      sort: [{ field: "title", direction: "desc" }],
      resolveRelations: true,
    });
  });

  it("falls back to the first view when the stored view is gone", async () => {
    const bridge = makeBridge([record("rec-1", "Plan")], TWO_VIEW_SCHEMA);
    renderPage(bridge, undefined, undefined, { activeViewName: "Gone" });

    await waitFor(() =>
      expect(bridge.queryCollectionRecords).toHaveBeenCalledOnce(),
    );
    expect(bridge.queryCollectionRecords).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      collectionPath: "tasks",
      resolveRelations: true,
    });
  });

  it("reports a view switch so the shell can persist it", async () => {
    const bridge = makeBridge([record("rec-1", "Plan")], TWO_VIEW_SCHEMA);
    const onActiveViewChange = vi.fn();
    renderPage(bridge, undefined, undefined, { onActiveViewChange });
    await screen.findByText("Plan");

    fireEvent.click(screen.getByRole("button", { name: "Sorted" }));
    expect(onActiveViewChange).toHaveBeenCalledExactlyOnceWith("Sorted");
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

  it("lists a button field, offers Button as a new field, and never as a board group", async () => {
    const bridge = makeBridge([selectRecord()], {
      ...SELECT_SCHEMA,
      fields: [...SELECT_SCHEMA.fields, { name: "Mark paid", type: "button" }],
    });
    renderPage(bridge);
    await screen.findByText("Plan");

    fireEvent.click(screen.getByTestId("collection-fields-button"));
    const fields = screen.getByTestId("collection-fields-dialog");
    expect(within(fields).getByText("Mark paid")).toBeDefined();
    expect(within(fields).getAllByText("Button").length).toBeGreaterThan(0);
    const types = within(screen.getByLabelText<HTMLSelectElement>("Field type")).getAllByRole("option");
    expect(types.map((option) => option.getAttribute("value"))).toContain("button");
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.click(screen.getByTestId("collection-views-button"));
    fireEvent.change(screen.getByLabelText("View kind"), {
      target: { value: "board" },
    });
    const groups = within(await screen.findByLabelText("Group by")).getAllByRole("option");
    expect(groups.map((option) => option.getAttribute("value"))).toEqual(["", "title", "status"]);
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
  it.each(["View", "Comment"])("shows no write error in a refused %s share when nobody edited", async () => {
    renderPage(makeBridge([record("rec-1", "Plan")]), undefined, undefined, { readOnly: true });
    await screen.findByText("Plan");
    act(() => setCollectionFieldWriteAccess("ws-1", "This share does not have Edit access."));
    expect(collectionWriteFailures()).toEqual([]);
    expect(screen.queryByTestId("collection-write-error")).toBeNull();
  });

  it("clears the write error when the last failure is discarded while access is refused", async () => {
    docMock.current = engineDocState({ opening: true });
    renderPage(makeBridge([record("rec-1", "Plan")]));
    await screen.findByText("Plan");
    act(() => {
      enqueueCollectionFieldWrite("ws-1", "tasks", { recordId: "rec-1", recordPath: "tasks/Plan.md", field: "title", value: "Changed" });
      setCollectionFieldWriteAccess("ws-1", "This share must be reopened.");
    });
    expect(screen.getByTestId("collection-write-error").textContent).toBe("This share must be reopened.");
    fireEvent.click(screen.getByTestId("collection-write-discard"));
    expect(collectionWriteFailures()).toEqual([]);
    expect(screen.queryByTestId("collection-write-error")).toBeNull();
  });

  it("shows no write error when an applied write saves after access is refused", async () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const page = renderPage(makeBridge([record("rec-1", "Plan")]));
    try {
      await screen.findByText("Plan");
      act(() => enqueueCollectionFieldWrite("ws-1", "tasks", { recordId: "rec-1", recordPath: "tasks/Plan.md", field: "title", value: "Changed" }));
      expect(doc.getMap("frontmatter").get("title")).toBe("Changed");
      act(() => setCollectionFieldWriteAccess("ws-1", "This share must be reopened."));
      docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saving" } });
      page.rerender(pageWithHost());
      docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saved-here" } });
      page.rerender(pageWithHost());
      expect(hasPendingCollectionFieldWrites()).toBe(false);
      expect(collectionWriteFailures()).toEqual([]);
      expect(screen.queryByTestId("collection-write-error")).toBeNull();
    } finally { page.unmount(); doc.destroy(); }
  });

  it("shows current access refusal in the status line and clears a discarded failure after reopening", async () => {
    docMock.current = engineDocState({ opening: true });
    renderPage(makeBridge([record("rec-1", "Plan")]));
    await screen.findByText("Plan");
    act(() => {
      enqueueCollectionFieldWrite("ws-1", "tasks", { recordId: "rec-1", recordPath: "tasks/Plan.md", field: "title", value: "Changed" });
      setCollectionFieldWriteAccess("ws-1", "This share must be reopened.");
    });
    expect(screen.getByTestId("collection-write-error").textContent).toBe("This share must be reopened.");
    act(() => setCollectionFieldWriteAccess("ws-1", "Your access to this share changed."));
    expect(screen.getByTestId("collection-write-error").textContent).toBe("Your access to this share changed.");
    act(() => setCollectionFieldWriteAccess("ws-1", null));
    expect(screen.getByTestId("collection-write-error").textContent).toBe("dohc did not save this change.");
    expect(screen.getByTestId("collection-write-retry")).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByTestId("collection-write-discard"));
    expect(screen.queryByTestId("collection-write-error")).toBeNull();
    expect(collectionWriteFailures()).toEqual([]);
  });

  it("clears a discarded failure and keeps processing later edits", async () => {
    // The session settles without a doc (conflict, deletion, engine off):
    // the head write fails with no detail.
    docMock.current = engineDocState({ available: false });
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

    fireEvent.click(screen.getByRole("checkbox"));
    const error = await screen.findByTestId("collection-write-error");
    expect(error.textContent).toBe("dohc did not save this change.");

    fireEvent.click(screen.getByTestId("collection-write-discard"));
    expect(screen.queryByTestId("collection-write-error")).toBeNull();

    // The failed write released its queue slot: the next change enqueues,
    // clears the stale message, and reaches its record's doc.
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() =>
      expect(doc.getMap("frontmatter").get("done")).toBe(true),
    );
    expect(screen.queryByTestId("collection-write-error")).toBeNull();
  });

  it("surfaces a read-only failure and advances to the next queued write", async () => {
    const firstDoc = new Y.Doc();
    firstDoc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc: firstDoc });
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
    const page = renderPage(bridge);
    await screen.findByText("Plan");

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    expect(firstDoc.getMap("frontmatter").has("done")).toBe(true);

    const nextDoc = new Y.Doc();
    nextDoc.getMap("frontmatter").set("id", "rec-1");
    let writerRender = 0;
    docMock.current = () => {
      writerRender += 1;
      return writerRender === 1
        ? engineDocState({
            available: true,
            doc: firstDoc,
            saveState: { kind: "unknown" }, readOnlyWhileEditing: true,
            saveError: "This workspace is read-only.",
          })
        : engineDocState({ available: true, doc: nextDoc });
    };
    page.rerender(pageWithHost());

    const error = await screen.findByTestId("collection-write-error");
    expect(error.textContent).toBe(
      "dohc did not save this change. This workspace is read-only.",
    );
    await waitFor(() =>
      expect(nextDoc.getMap("frontmatter").has("done")).toBe(true),
    );
  });

  it("reports a head write held file-locked past the window and unblocks the queue", async () => {
    const firstDoc = new Y.Doc();
    firstDoc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc: firstDoc });
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
    const page = renderPage(bridge);
    await screen.findByText("Plan");

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    expect(firstDoc.getMap("frontmatter").has("done")).toBe(true);

    vi.useFakeTimers();
    const nextDoc = new Y.Doc();
    nextDoc.getMap("frontmatter").set("id", "rec-1");
    let writerRender = 0;
    docMock.current = () => {
      writerRender += 1;
      return writerRender === 1
        ? engineDocState({
            available: true,
            doc: firstDoc,
            saveState: { kind: "file-locked", reason: "test failure", issueId: null },
          })
        : engineDocState({ available: true, doc: nextDoc });
    };
    page.rerender(pageWithHost());

    // Inside the window: no line yet, the queue waits on main's retries.
    await vi.advanceTimersByTimeAsync(FILE_LOCKED_REPORT_MS - 1);
    expect(screen.queryByTestId("collection-write-error")).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    const error = await screen.findByTestId("collection-write-error");
    expect(error.textContent).toBe(
      "Another program has Plan.md open, so dohc can't update it on disk. This change is saved and dohc retries until the file is free.",
    );
    // The locked head released its queue slot: the next edit reached its doc.
    await waitFor(() =>
      expect(nextDoc.getMap("frontmatter").get("done")).toBe(true),
    );
  });

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

  it("shows a table, not a board, when the board groups by a button", async () => {
    const parsed = parseCollectionSchema([
      "fields:",
      "  title:",
      "    type: text",
      "  Mark paid:",
      "    type: button",
      "views:",
      "  - name: Board",
      "    kind: board",
      "    groupBy: Mark paid",
    ].join("\n"));
    expect(parsed.schema.views[0]?.groupBy).toBeNull();
    const bridge = makeBridge([record("rec-1", "Plan")], parsed.schema, {
      groups: [{ value: null, records: [record("rec-1", "Plan")] }],
    });
    renderPage(bridge);

    expect(await screen.findByRole("grid")).toBeDefined();
    expect(screen.queryByRole("list")).toBeNull();
    expect(bridge.queryCollectionRecords.mock.calls.map(([params]) => params)).not.toContainEqual(
      expect.objectContaining({ groupBy: expect.anything() }),
    );
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
    const scroller = container.querySelector<HTMLElement>("[role=grid] .overflow-auto")!;
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

  it("stops the drain at the record cap and says how many records show", async () => {
    const bridge = makeBridge([], BOARD_SCHEMA);
    // Two pages cross the cap; a third page exists and must not be asked for.
    const pageSize = (DRAIN_RECORD_LIMIT / 10) * 6;
    const page = (start: number) => {
      const records = Array.from({ length: pageSize }, (_, index) =>
        statusRecord(`rec-${start + index}`, `Task ${start + index}`),
      );
      return { records, groups: [{ value: "Todo", records }] };
    };
    servePages(bridge, [page(0), page(pageSize), page(pageSize * 2)]);
    renderPage(bridge);

    const cap = await screen.findByTestId("collection-drain-cap");
    expect(cap.textContent).toBe(
      `This view shows only the first ${pageSize * 2} records.`,
    );
    expect(bridge.queryCollectionRecords).toHaveBeenCalledTimes(2);
  });

  it("drains every page so a calendar view places all events", async () => {
    const today = localToday();
    const dated = (id: string, title: string): CollectionRecord => ({
      ...record(id, title),
      values: [
        ...record(id, title).values,
        {
          field: "due",
          value: today,
          validation: { status: "valid" },
          resolvedRelations: [],
        },
      ],
    });
    const bridge = makeBridge([], CALENDAR_SCHEMA);
    servePages(bridge, [
      { records: [dated("rec-1", "Plan")], groups: null },
      { records: [dated("rec-2", "Ship")], groups: null },
    ]);
    renderPage(bridge);

    expect(await screen.findByText("Plan")).toBeDefined();
    expect(await screen.findByText("Ship")).toBeDefined();
    expect(bridge.queryCollectionRecords).toHaveBeenCalledTimes(2);
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

describe("CollectionRecordFieldWrite", () => {
  const CHANGE = {
    recordId: "rec-1",
    recordPath: "tasks/Plan.md",
    field: "status",
    value: "done",
  };

  // The writer's three outcomes are distinct callbacks: onSettled (on disk),
  // onHeldDurably (engine holds it through a lock), onFailed (did NOT reach
  // the engine — the queue must retain it). Exactly one fires per write.
  function writerProps() {
    return {
      workspaceId: "ws-1",
      collectionPath: "tasks",
      change: CHANGE,
      onPrepared: vi.fn(),
      onSettled: vi.fn(),
      onHeldDurably: vi.fn(),
      onFailed: vi.fn(),
    };
  }

  it("writes the field on the frontmatter map and settles after the save lands", () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const props = writerProps();
    const view = render(<CollectionRecordFieldWrite {...props} />);

    expect(docMock.inputs[0]).toEqual({
      workspaceId: "ws-1",
      path: "tasks/Plan.md",
      enabled: true,
    });
    expect(doc.getMap("frontmatter").get("status")).toBe("done");
    // The session opens in "saved"; releasing on that snapshot would race
    // the staged local-update flush, so the writer must still be waiting.
    expect(props.onSettled).not.toHaveBeenCalled();

    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saving" } });
    view.rerender(<CollectionRecordFieldWrite {...props} />);
    expect(props.onSettled).not.toHaveBeenCalled();

    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saved-here" } });
    view.rerender(<CollectionRecordFieldWrite {...props} />);
    expect(props.onSettled).toHaveBeenCalledOnce();
    expect(props.onFailed).not.toHaveBeenCalled();
    expect(props.onHeldDurably).not.toHaveBeenCalled();
  });

  it("reports a save error as a failure, never a settle", () => {
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const props = writerProps();
    const view = render(<CollectionRecordFieldWrite {...props} />);
    docMock.current = engineDocState({
      available: true,
      doc,
      saveState: { kind: "error", reason: "test failure", issueId: null },
      saveError: "file too large",
    });
    view.rerender(<CollectionRecordFieldWrite {...props} />);
    expect(props.onFailed).toHaveBeenCalledExactlyOnceWith(
      "dohc did not save this change. file too large",
    );
    expect(props.onSettled).not.toHaveBeenCalled();
  });

  it("reports the locked file as durably held only after the bounded window", () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    doc.getMap("frontmatter").set("id", "rec-1");
    docMock.current = engineDocState({ available: true, doc });
    const props = writerProps();
    const view = render(<CollectionRecordFieldWrite {...props} />);

    docMock.current = engineDocState({
      available: true,
      doc,
      saveState: { kind: "file-locked", reason: "test failure", issueId: null },
    });
    view.rerender(<CollectionRecordFieldWrite {...props} />);
    // Inside the window the writer waits on main's own retries.
    vi.advanceTimersByTime(FILE_LOCKED_REPORT_MS - 1);
    expect(props.onSettled).not.toHaveBeenCalled();
    expect(props.onHeldDurably).not.toHaveBeenCalled();

    // A retry's own saving flip must not restart the window.
    docMock.current = engineDocState({ available: true, doc, saveState: { kind: "saving" } });
    view.rerender(<CollectionRecordFieldWrite {...props} />);
    docMock.current = engineDocState({
      available: true,
      doc,
      saveState: { kind: "file-locked", reason: "test failure", issueId: null },
    });
    view.rerender(<CollectionRecordFieldWrite {...props} />);
    vi.advanceTimersByTime(1);
    expect(props.onHeldDurably).toHaveBeenCalledExactlyOnceWith(
      "Another program has Plan.md open, so dohc can't update it on disk. This change is saved and dohc retries until the file is free.",
    );
    expect(props.onFailed).not.toHaveBeenCalled();
  });

  it("reports a refusal as a failure without touching the doc", () => {
    docMock.current = engineDocState({ available: false });
    const props = writerProps();
    render(<CollectionRecordFieldWrite {...props} />);
    expect(props.onFailed).toHaveBeenCalledExactlyOnceWith(null);
    expect(props.onSettled).not.toHaveBeenCalled();
  });

  it("writes bigints back as numbers when exact, else decimal text", () => {
    expect(frontmatterWriteValue(10n)).toBe(10);
    expect(frontmatterWriteValue(2n ** 63n)).toBe("9223372036854775808");
    expect(frontmatterWriteValue(["a", 3n])).toEqual(["a", 3]);
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

  it("presses once for a held Enter key", async () => {
    const bridge = buttonsWith();
    vi.stubGlobal("dohcDesktop", bridge);
    render(pageWithHost());
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    const repeat = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    button.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    const first = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    button.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(false);
  });

  it("frees the button when its run fails, and files no row of its own beside the failure's notice", async () => {
    const bridge = buttonsWith();
    vi.stubGlobal("dohcDesktop", bridge);
    const onError = vi.fn(), onNotice = vi.fn();
    render(pageWithHost(undefined, undefined, { onError, onNotice }));
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    await waitFor(() => expect(bridge.pressAutomationButton).toHaveBeenCalled());
    await act(async () => undefined);
    expect(button.getAttribute("aria-busy")).toBe("true");
    act(() => bridge.emitRunSettled({ workspaceId: "ws-1", claimId: "atc_press", outcome: "failed", error: "Total is not a number." }));
    expect(button.getAttribute("aria-busy")).toBeNull();
    // Main sends this person the failure's one notice, with Try again, and takes it back once a run succeeds.
    expect(onError).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("settles a run whose end arrived before the press answer", async () => {
    let answer: (result: PressAutomationButtonResult) => void = () => undefined;
    const bridge = buttonsWith({ press: () => new Promise((resolve) => { answer = resolve; }) });
    vi.stubGlobal("dohcDesktop", bridge);
    const onNotice = vi.fn();
    render(pageWithHost(undefined, undefined, { onNotice }));
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    await waitFor(() => expect(bridge.pressAutomationButton).toHaveBeenCalled());
    act(() => bridge.emitRunSettled({ workspaceId: "ws-1", claimId: "atc_press", outcome: "skipped", error: null }));
    await act(async () => answer({ busy: false, claimId: "atc_press", settled: null }));
    expect(onNotice).toHaveBeenCalledWith("Mark paid made no changes to Invoice 12");
    expect(button.getAttribute("aria-busy")).toBeNull();
  });

  it("says when the button already runs for someone else, and keeps it pressable", async () => {
    const bridge = buttonsWith({ press: async () => ({ busy: true, reason: "Running for this record." }) });
    vi.stubGlobal("dohcDesktop", bridge);
    render(pageWithHost());
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-describedby")).not.toBeNull());
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("Running for this record.");
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("frees a shared view's button once the owner's computer has the press, and reports nothing itself", async () => {
    const bridge = buttonsWith({ press: async () => ({ busy: false, relayed: true }) });
    vi.stubGlobal("dohcDesktop", bridge);
    const onNotice = vi.fn(), onError = vi.fn();
    render(pageWithHost(undefined, undefined, { onNotice, onError }));
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    await waitFor(() => expect(bridge.pressAutomationButton).toHaveBeenCalled());
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
    // The owner's computer files the press's one notice if it fails.
    expect(onNotice).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("still reports a run that ends after its Collection closed, through the surface that showed it", async () => {
    const bridge = buttonsWith();
    vi.stubGlobal("dohcDesktop", bridge);
    const onNotice = vi.fn();
    const page = render(pageWithHost(undefined, undefined, { onNotice }));
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    await waitFor(() => expect(bridge.pressAutomationButton).toHaveBeenCalled());
    await act(async () => undefined);
    page.unmount();
    act(() => bridge.emitRunSettled({ workspaceId: "ws-1", claimId: "atc_press", outcome: "done", error: null }));
    expect(onNotice).toHaveBeenCalledWith("Ran Mark paid on Invoice 12");
  });

  it("shows why a run waits even when the wait arrives before the press answer", async () => {
    let answer: (result: PressAutomationButtonResult) => void = () => undefined;
    const bridge = buttonsWith({ press: () => new Promise((resolve) => { answer = resolve; }) });
    vi.stubGlobal("dohcDesktop", bridge);
    render(pageWithHost());
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    await waitFor(() => expect(bridge.pressAutomationButton).toHaveBeenCalled());
    act(() => bridge.emitRunWaiting({ workspaceId: "ws-1", claimId: "atc_press", reason: "held" }));
    await act(async () => answer({ busy: false, claimId: "atc_press", settled: null }));
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent)
      .toBe("Waiting for someone who can edit this Collection to allow a step.");
  });

  it("puts a button's words in the page body, outside the row that moves by transform", async () => {
    const bridge = buttonsWith();
    vi.stubGlobal("dohcDesktop", bridge);
    render(pageWithHost());
    const button = await screen.findByRole("button", { name: "Archive for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-describedby")).not.toBeNull());
    const words = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(words.parentElement).toBe(document.body);
    expect(button.closest("[role=row]")?.contains(words)).toBe(false);
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

  it("retries a press that did not start through the live store after its store was dropped, and a dropped store presses nothing", async () => {
    let fail = true;
    const bridge = buttonsWith({ press: async () => {
      if (fail) throw new Error("The workspace engine is not running.");
      return { busy: false, claimId: "atc_press", settled: null };
    } });
    vi.stubGlobal("dohcDesktop", bridge);
    const onNotice = vi.fn(), onError = vi.fn();
    const page = render(pageWithHost(undefined, undefined, { onNotice, onError }));
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Mark paid did not start.", expect.any(Error), expect.any(Function)));
    const retry = onError.mock.calls[0]![2] as () => void;
    page.unmount();
    const dropped = automationButtonsFor("ws-1", { collectionPath: "tasks" });
    for (let index = 0; index < 25; index += 1) automationButtonsFor("ws-1", { collectionPath: `other-${index}` });
    await dropped.press("Mark paid", { id: "rec-1", label: "Invoice 12" });
    expect(bridge.pressAutomationButton).toHaveBeenCalledTimes(1);
    fail = false;
    await act(async () => retry());
    await waitFor(() => expect(bridge.pressAutomationButton).toHaveBeenCalledTimes(2));
    act(() => bridge.emitRunSettled({ workspaceId: "ws-1", claimId: "atc_press", outcome: "done", error: null }));
    expect(onNotice).toHaveBeenCalledWith("Ran Mark paid on Invoice 12");
  });

  it("changes only the pressed button's view", async () => {
    const bridge = buttonsWith();
    vi.stubGlobal("dohcDesktop", bridge);
    const buttons = automationButtonsFor("ws-1", { collectionPath: "tasks" });
    await buttons.refresh();
    const other = buttons.view("Archive", "rec-1");
    const pressed = buttons.view("Mark paid", "rec-1");
    const pressing = buttons.press("Mark paid", { id: "rec-1", label: "Invoice 12" });
    expect(buttons.view("Archive", "rec-1")).toBe(other);
    expect(buttons.view("Mark paid", "rec-1")).not.toBe(pressed);
    await pressing;
  });

  it("shows the table's buttons as checking while main reads what they do, then shows the answer", async () => {
    const bridge = buttonsWith();
    const answer = deferred<ListAutomationButtonsResult>();
    bridge.listAutomationButtons.mockReturnValueOnce(answer.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    render(pageWithHost());
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("dohc is checking whether you can use this button.");
    expect(screen.queryByRole("button", { name: "Check Mark paid for Invoice 12 again" })).toBeNull();
    await act(async () => answer.resolve({ buttons: [{ field: "Mark paid", table: null, state: READY }] }));
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });

  it("turns a shared document Collection's Button ready when main says the host answered", async () => {
    const checking: AutomationButtonState = { kind: "checking", reason: "dohc is checking whether you can use this button." };
    const bridge = buttonsWith({ buttons: [{ field: "Mark paid", state: checking }] });
    vi.stubGlobal("dohcDesktop", bridge);
    render(pageWithHost());
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(checking.reason));
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // dohc is asking the host, so there is nothing to check again.
    expect(screen.queryByRole("button", { name: "Check Mark paid for Invoice 12 again" })).toBeNull();
    bridge.listAutomationButtons.mockResolvedValue({ buttons: [{ field: "Mark paid", state: READY }] });
    // Nothing in the Collection's folder changed; only the host's answer did.
    act(() => bridge.emitAutomationsChanged("ws-1"));
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    expect(screen.queryByRole("button", { name: "Check Mark paid for Invoice 12 again" })).toBeNull();
  });

  it("changes only the views of buttons with no answer or an unchecked one when a read starts", async () => {
    const bridge = buttonsWith({ buttons: [
      { field: "Mark paid", state: READY },
      { field: "Archive", state: { kind: "unchecked", reason: "dohc cannot check this button now. Try again when its host is available." } },
    ] });
    vi.stubGlobal("dohcDesktop", bridge);
    const buttons = automationButtonsFor("ws-1", { collectionPath: "tasks" });
    await buttons.refresh();
    const unsubscribe = [buttons.subscribe(buttons.key("Mark paid", "rec-1"), () => undefined), buttons.subscribe(buttons.key("Archive", "rec-1"), () => undefined)];
    const ready = buttons.view("Mark paid", "rec-1");
    const unchecked = buttons.view("Archive", "rec-1");
    // A view read once and not followed is still cached.
    expect(buttons.view("Archive", "rec-2").checking).toBe(false);
    expect(unchecked.checking).toBe(false);
    const answer = deferred<ListAutomationButtonsResult>();
    bridge.listAutomationButtons.mockReturnValueOnce(answer.promise);
    const reading = buttons.refresh();
    expect(buttons.view("Mark paid", "rec-1")).toBe(ready);
    expect(buttons.view("Archive", "rec-1")).toMatchObject({ state: unchecked.state, checking: true });
    expect(buttons.view("Archive", "rec-2").checking).toBe(true);
    answer.resolve({ buttons: [{ field: "Mark paid", table: null, state: READY }, { field: "Archive", table: null, state: READY }] });
    await reading;
    expect(buttons.view("Archive", "rec-1")).toMatchObject({ state: READY, checking: false });
    for (const stop of unsubscribe) stop();
  });

  it("offers Button in Fields, and Choose what it does opens the builder on a button nothing uses", async () => {
    const bridge = Object.assign(buttonsWith(), {
      onAutomationRunsChanged: () => () => undefined,
      onAutomationHoldsChanged: () => () => undefined,
      listAutomationTargets: async () => ({ collections: [] }),
      checkCollectionAutomation: async () => ({ diagnostics: [], formulaProblems: [], findProblems: [], cannotRun: null, missingFiles: [] }),
      listAutomationGroups: async () => ({ groups: [] }),
      listAutomationPeople: async () => ({ status: "listed", people: [] }),
      readScheduleHost: async () => ({ kind: "this-computer" }),
      onScheduleHostChanged: () => () => undefined,
      onCloudSessionChanged: () => () => undefined,
    });
    vi.stubGlobal("dohcDesktop", bridge);
    render(pageWithHost());
    fireEvent.click(await screen.findByTestId("collection-fields-button"));
    const dialog = await screen.findByTestId("collection-fields-dialog");
    expect(within(dialog).getByRole("option", { name: "Button" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Choose what it does: Mark paid" })).toBeNull();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Choose what it does: Archive" }));
    // The Fields dialog closes, and the ⚡ panel opens its builder with the button as the trigger.
    await waitFor(() => expect(screen.queryByTestId("collection-fields-dialog")).toBeNull());
    const panel = await screen.findByTestId("collection-automations-panel");
    expect((within(panel).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Archive");
    expect((within(panel).getByRole("combobox", { name: "Trigger" }) as HTMLSelectElement).value).toBe("button");
    expect((within(panel).getByRole("combobox", { name: "Button" }) as HTMLSelectElement).value).toBe("Archive");
  });
});
