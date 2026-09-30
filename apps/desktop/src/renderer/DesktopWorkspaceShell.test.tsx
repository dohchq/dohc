// @vitest-environment jsdom
import {
  ObserverStub,
} from "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { ChatChannelRecord, EngineYDocSaveStateEvent } from "../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import { rendererMarks } from "../performance/rendererMarks";
import { DesktopWorkspaceShell, WORKBENCH_PERSIST_DELAY_MS, type Workspace } from "./DesktopWorkspaceShell";
import { WORKSPACE_ACTIVITY_REFRESH_DELAY_MS, WORKSPACE_ACTIVITY_REFRESH_MAX_WAIT_MS } from "./workspaceActivityCoalescer";
import { OPEN_EDITORS_DEFAULT_HEIGHT, OPEN_EDITORS_MIN_HEIGHT } from "./workbench/workbenchState";
import { documentVersionKey } from "./documentVersionKey";
import { basenameOf } from "./path";
import { deferred } from "../testing/deferred";
import { WORKSPACE, STORED_STATE, storedStateWithTabs, CANONICAL_DM, dmSyncResult, recordDocUpdate, makeBridge, renderShell, holdHistory, shellBootstrapProps, SHARE_VIEW } from "./DesktopWorkspaceShell.testHarness";

// Count inspector and explorer work when the shell renders again.
vi.mock("./documentVersionKey", { spy: true });
vi.mock("./path", { spy: true });

describe("workspace switch performance timeline", () => {
  it("reuses the bootstrap agent-status read for initial history", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);

    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    await waitFor(() => expect(bridge.getSyncStatus).toHaveBeenCalled());
    expect(bridge.getAgentRunStatus).toHaveBeenCalledTimes(1);
  });

  it("records the existing shell readiness commits for a restored file", async () => {
    const previousOrdinal = rendererMarks.readSwitchTimeline().at(-1)?.ordinal ?? 0;
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));

    await screen.findByTestId("view-markdown");
    await waitFor(() => {
      const timeline = rendererMarks
        .readSwitchTimeline()
        .find((entry) => entry.ordinal > previousOrdinal);
      expect(timeline).toMatchObject({
        listingSource: "fresh",
        phases: {
          "switch-start": expect.any(Number),
          "session-admitted": expect.any(Number),
          "files-painted": expect.any(Number),
          "files-revalidated": expect.any(Number),
          "history-ready": expect.any(Number),
          "restored-active-surface-ready": expect.any(Number),
        },
      });
    });
  });
});

describe("direct message workspace picker", () => {
  beforeAll(async () => {
    // Module loading is setup; keep the deadline for the rendered behavior.
    await import("./workbench/ChatsView");
  }, 30_000);

  it("does not offer shared-view workspaces for acceptance", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    bridge.syncDms = vi.fn(async () => ({
      available: true,
      dms: [],
      pending: [
        { shareId: "share-request", granterEmail: "alice@example.com" },
      ],
      declined: [],
      failed: false,
    }));
    const sharedView: Workspace = {
      ...SHARE_VIEW,
      workspaceId: "ws-shared-view",
      rootPath: "/home/sam/dohc/shared-view",
    };

    renderShell(bridge, WORKSPACE, [WORKSPACE, sharedView]);
    await user.click(await screen.findByTestId("chats-dm-request-accept"));

    const options = screen.getAllByTestId("chats-accept-dm-workspace-option");
    expect(options.map((option) => option.dataset.workspaceId)).toEqual([
      WORKSPACE.workspaceId,
    ]);
    expect(screen.queryByText("shared-view")).toBeNull();
  });
});

describe("global letter shortcut ownership", () => {
  function dispatchShortcut(
    key: string,
    init: KeyboardEventInit = {},
    target: Window | Element = window,
  ) {
    const event = new KeyboardEvent("keydown", {
      key,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    fireEvent(target, event);
    return event;
  }

  it("leaves editor Ctrl+B with the editor", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("side-panel");
    const editor = document.createElement("textarea");
    screen.getByTestId("workspace-shell").append(editor);
    editor.addEventListener("keydown", (event) => event.preventDefault(), {
      once: true,
    });

    dispatchShortcut("b", {}, editor);

    expect(screen.getByTestId("side-panel")).toBeTruthy();
    dispatchShortcut("b", {}, editor);
    await waitFor(() => expect(screen.queryByTestId("side-panel")).toBeNull());
    editor.remove();
  });

  it("routes an unclaimed shortcut from an editable target", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("side-panel");
    const editor = document.createElement("textarea");
    screen.getByTestId("workspace-shell").append(editor);

    dispatchShortcut("n", {}, editor);

    expect(await screen.findByRole("textbox", { name: "File name" })).toBeTruthy();
    editor.remove();
  });

  it("does not claim a letter shortcut another handler prevented", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("side-panel");
    const event = new KeyboardEvent("keydown", {
      key: "b",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();

    fireEvent(window, event);

    expect(screen.getByTestId("side-panel")).toBeTruthy();
  });

  it("leaves combined Control+Command chords unclaimed", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("side-panel");

    const event = dispatchShortcut("b", { metaKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByTestId("side-panel")).toBeTruthy();
  });

  it.each([
    ["auto-repeat", { repeat: true }],
    ["composition", { isComposing: true }],
  ] as const)("does not claim a shortcut during %s", async (_name, init) => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("side-panel");

    const event = dispatchShortcut("b", init);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByTestId("side-panel")).toBeTruthy();
  });

  it("routes uppercase N to new file", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("side-panel");

    dispatchShortcut("N");

    expect(await screen.findByRole("textbox", { name: "File name" })).toBeTruthy();
  });

  it("routes uppercase K to the command palette", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("side-panel");

    dispatchShortcut("K");

    expect(await screen.findByTestId("command-palette")).toBeTruthy();
  });

  it("routes uppercase P to quick open", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("side-panel");

    dispatchShortcut("P");

    expect(await screen.findByTestId("quick-open")).toBeTruthy();
  });

  it.each([
    ["Control", { ctrlKey: true, metaKey: false }],
    ["Command", { ctrlKey: false, metaKey: true }],
  ] as const)(
    "leaves unsupported %s+Alt letter chords unclaimed",
    async (_name, modifier) => {
      renderShell(makeBridge(Promise.resolve(STORED_STATE)));
      await screen.findByTestId("side-panel");

      for (const [key, shiftKey] of [
        ["n", false],
        ["k", false],
        ["p", false],
        ["p", true],
        ["w", false],
      ] as const) {
        const event = dispatchShortcut(key, {
          ...modifier,
          altKey: true,
          shiftKey,
        });
        expect(event.defaultPrevented, `${key} shift=${shiftKey}`).toBe(false);
      }
    },
  );

  it("routes uppercase B to the sidebar", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("side-panel");

    dispatchShortcut("B");

    await waitFor(() => expect(screen.queryByTestId("side-panel")).toBeNull());
  });

  it("routes uppercase W to the active tab", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("tab-b.md");

    dispatchShortcut("W");

    await waitFor(() => expect(screen.queryByTestId("tab-b.md")).toBeNull());
  });

  it("routes Ctrl+Shift+P to the command palette when the key is lowercase", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("side-panel");

    dispatchShortcut("p", { shiftKey: true });

    expect(await screen.findByTestId("command-palette")).toBeTruthy();
    expect(screen.queryByTestId("quick-open")).toBeNull();
  });

  it("routes canonical uppercase Ctrl+Shift+P to the command palette", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("side-panel");

    dispatchShortcut("P", { shiftKey: true });

    expect(await screen.findByTestId("command-palette")).toBeTruthy();
    expect(screen.queryByTestId("quick-open")).toBeNull();
  });

  it("leaves unadvertised shifted letter chords unclaimed", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("side-panel");
    await screen.findByTestId("tab-b.md");

    const newFile = dispatchShortcut("N", { shiftKey: true });
    const sidebar = dispatchShortcut("B", { shiftKey: true });
    const closeTab = dispatchShortcut("W", { shiftKey: true });

    expect(newFile.defaultPrevented).toBe(false);
    expect(sidebar.defaultPrevented).toBe(false);
    expect(closeTab.defaultPrevented).toBe(false);
    expect(screen.queryByRole("textbox", { name: "File name" })).toBeNull();
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
  });
});

describe("collection folders", () => {
  // The table virtualizer reads offsetWidth/offsetHeight, which jsdom reports
  // as 0 — no row would render (CollectionPage.test.tsx precedent).
  const offsetDescriptors = {
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
  };

  beforeEach(() => {
    // Give each collection test the same observer and viewport fixtures.
    vi.stubGlobal("ResizeObserver", ObserverStub);
    vi.stubGlobal("IntersectionObserver", ObserverStub);
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
    for (const [name, descriptor] of Object.entries(offsetDescriptors)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
  });


  it("reserves pending record names and retries the same partial identity", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles = vi.fn(async () => ({ files: [], folders: ["tasks"] }));
    bridge.listCollections = vi.fn(async () => ({ collections: [{ path: "tasks", objectId: "object-test", status: "valid" as const, reasons: [] }] }));
    const pending = deferred<Awaited<ReturnType<typeof bridge.createCollectionRecord>>>();
    bridge.createCollectionRecord.mockImplementationOnce(() => pending.promise);
    renderShell(bridge);
    const user = userEvent.setup();
    const row = await waitFor(() => {
      const row = screen.getAllByTestId("tree-row").find(entry => entry.dataset.path === "tasks");
      expect(row?.dataset.collection).toBe("true");
      return row!;
    });
    await user.click(row);
    const button = await screen.findByRole("button", { name: "New record" }, { timeout: 15_000 });
    await user.click(button);
    await user.click(button);
    expect(bridge.createCollectionRecord.mock.calls[0]![0].name).toBe("Untitled");
    expect(bridge.createCollectionRecord.mock.calls[1]![0].name).toBe("Untitled 2");
    const recordId = "rec_abcdefghijklmnopqrstuvwxyz";
    await act(async () => pending.resolve({
      kind: "partial", created: ["tasks/Untitled.md"], failedStage: "index", reason: "index unavailable",
      retry: { mode: "resume", recordId, instruction: "Try again to finish this record." },
    }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    await user.click(retry);
    expect(bridge.createCollectionRecord.mock.calls[2]![0]).toMatchObject({ name: "Untitled", recordId });
  });

  it("opens a collection folder as its views tab with the settled empty state", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: [{ path: "tasks/one.md", kind: "file" as const }],
      folders: ["tasks"],
    }));
    bridge.listCollections = vi.fn(async () => ({
      collections: [{ path: "tasks", objectId: "object-test", status: "valid" as const, reasons: [] }],
    }));
    renderShell(bridge);
    const user = userEvent.setup();

    // The list must carry the shell's workspace scope, and the row routes to
    // the collection only once that list committed — the row's rendered
    // data-collection affordance is the observable proof, so the click
    // cannot race the commit.
    const row = await waitFor(() => {
      const candidate = screen
        .getAllByTestId("tree-row")
        .find((entry) => entry.dataset.path === "tasks");
      expect(candidate?.dataset.collection).toBe("true");
      return candidate as HTMLElement;
    });
    expect(bridge.listCollections).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
    });
    await user.click(row);

    expect(await screen.findByTestId("tab-dohc://collection/tasks")).toBeTruthy();
    // The surface is a lazy chunk (@dohc/collection-views pulls the table,
    // board, and calendar libraries) plus two bridge round trips; on a
    // loaded worker that cold load can outlast the default wait.
    expect(
      await screen.findByText("No records in this collection yet.", undefined, {
        timeout: 15_000,
      }),
    ).toBeTruthy();
    // The settled empty state is that line plus the New record action.
    // Activation is CollectionPage's own boundary, pinned in its tests.
    expect(screen.getByRole("button", { name: "New record" })).toBeTruthy();
    expect(bridge.getCollection).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      collectionPath: "tasks",
    });
  });

  // The queue behind cell edits must outlive the page: the shell renders only
  // a group's ACTIVE tab, so opening a file unmounts CollectionPage. An edit
  // the cell already accepted must still reach its record's live document.
  it("keeps a queued record edit when a file opens while the first save is pending", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: [
        { path: "tasks/one.md", kind: "file" as const },
        { path: "tasks/two.md", kind: "file" as const },
        { path: "notes.md", kind: "file" as const },
      ],
      folders: ["tasks"],
    }));
    bridge.listCollections = vi.fn(async () => ({
      collections: [{ path: "tasks", objectId: "object-test", status: "valid" as const, reasons: [] }],
    }));
    bridge.getCollection = vi.fn(async () => ({
      path: "tasks",
      objectId: "object-test",
      status: "valid" as const,
      reasons: [],
      schema: {
        name: "Tasks",
        description: null,
        fields: [
          { name: "title", type: "text" as const },
          { name: "done", type: "checkbox" as const },
        ],
        views: [],
      },
      recordCount: 2,
    }));
    const taskRecord = (id: string, title: string, path: string) => ({
      id,
      path,
      conflicted: false,
      values: [
        {
          field: "title",
          value: title,
          validation: { status: "valid" as const },
          resolvedRelations: [],
        },
        {
          field: "done",
          value: false,
          validation: { status: "valid" as const },
          resolvedRelations: [],
        },
      ],
    });
    bridge.queryCollectionRecords = vi.fn(async () => ({
      collection: { path: "tasks", objectId: "object-test", status: "valid" as const, reasons: [] },
      records: [
        taskRecord("rec-1", "One", "tasks/one.md"),
        taskRecord("rec-2", "Two", "tasks/two.md"),
      ],
      groups: null,
      nextCursor: null,
    }));
    const sessionsByPath = new Map<string, string>();
    const updatesBySession = new Map<string, Uint8Array[]>();
    const saveStateListeners = new Set<
      (event: EngineYDocSaveStateEvent) => void
    >();
    const openEngineYDocSession = vi.fn(
      async (payload: { path: string; sessionId: string }) => {
        // Record files get live sessions; notes.md stays a plain editor.
        if (!payload.path.startsWith("tasks/")) return { available: false };
        sessionsByPath.set(payload.path, payload.sessionId);
        return {
          available: true,
          initialUpdate: recordDocUpdate(
            payload.path === "tasks/one.md" ? "rec-1" : "rec-2",
          ),
          lineageGeneration: 1,
        };
      },
    );
    const applyEngineYDocUpdate = vi.fn(
      async (payload: { sessionId: string; update: Uint8Array }) => {
        const applied = updatesBySession.get(payload.sessionId) ?? [];
        applied.push(payload.update);
        updatesBySession.set(payload.sessionId, applied);
        return { accepted: true as const };
      },
    );
    Object.assign(bridge, {
      openEngineYDocSession,
      applyEngineYDocUpdate,
      closeEngineYDocSession: vi.fn(async () => undefined),
      onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
      onEngineYDocOwnerHandoff: () => () => undefined,
      prepareEngineYDocOwnerHandoff: async () => undefined,
      onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
      onEngineYDocSaveState: vi.fn(
        (listener: (event: EngineYDocSaveStateEvent) => void) => {
          saveStateListeners.add(listener);
          return () => saveStateListeners.delete(listener);
        },
      ),
    });
    renderShell(bridge);

    const row = await waitFor(() => {
      const candidate = screen
        .getAllByTestId("tree-row")
        .find((entry) => entry.dataset.path === "tasks");
      expect(candidate?.dataset.collection).toBe("true");
      return candidate as HTMLElement;
    });
    await user.click(row);
    const collectionPage = within(await screen.findByTestId("collection-page"));
    const checkboxes = await collectionPage.findAllByRole(
      "checkbox",
      {},
      { timeout: 15_000 },
    );
    expect(checkboxes).toHaveLength(2);

    // First edit: the record's session opens and the update is delivered, but
    // the save never settles — the head write is still pending.
    await user.click(checkboxes[0]!);
    await waitFor(() => expect(sessionsByPath.has("tasks/one.md")).toBe(true));
    await waitFor(() =>
      expect(
        updatesBySession.get(sessionsByPath.get("tasks/one.md")!)?.length ?? 0,
      ).toBeGreaterThan(0),
    );

    // Second edit queues behind the pending head.
    await user.click(collectionPage.getAllByRole("checkbox")[1]!);

    // Ordinary navigation: open a plain file; the collection page unmounts.
    const fileRow = screen
      .getAllByTestId("tree-row")
      .find((entry) => entry.dataset.path === "notes.md")!;
    await user.click(fileRow);
    await screen.findByTestId("tab-notes.md");
    await waitFor(() =>
      expect(screen.queryByTestId("collection-page")).toBeNull(),
    );

    // The pending head settles only now, after the page is gone.
    act(() => {
      const sessionId = sessionsByPath.get("tasks/one.md")!;
      for (const listener of [...saveStateListeners]) {
        listener({ sessionId, state: "saved", seq: 1 });
      }
    });

    // The second accepted edit still reaches its record's live document.
    await waitFor(() => expect(sessionsByPath.has("tasks/two.md")).toBe(true));
    await waitFor(() => {
      const updates =
        updatesBySession.get(sessionsByPath.get("tasks/two.md")!) ?? [];
      const probe = new Y.Doc();
      for (const update of updates) Y.applyUpdate(probe, update);
      expect(probe.getMap("frontmatter").get("done")).toBe(true);
    });
  }, 40_000);

  it("offers New collection from the palette for an engine-enabled writable workspace", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByTestId("command-palette");
    expect(await within(palette).findByText("New collection")).toBeTruthy();
  });

  // assertWritableWorkspace refuses createWorkspaceFile on the share's
  // presence alone, so New collection from a shared view is a dead click —
  // the palette must not offer what it can never do.
  it("does not offer New collection from a read-only shared view", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    const user = userEvent.setup();
    renderShell(bridge, SHARE_VIEW);

    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByTestId("command-palette");
    // The palette renders and lists something, so the miss below is the
    // gate working, not the palette failing to open.
    await within(palette).findByText("New editor group right");
    expect(within(palette).queryByText("New collection")).toBeNull();
  });
});

describe("content search", () => {
  // Journey 1: queries arrived with their leading characters missing
  // ("MBERDRAFT-8831" for "EMBERDRAFT-8831"). The panel opened, but the input
  // only mounted when a lazy chunk resolved, so everything typed in that gap
  // went to the activity-bar button the user had just clicked.
  it("mounts the focused input in the same commit that opens the panel", () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);

    // No awaits: nothing can resolve a pending import between the click and
    // the first keystroke, which is exactly the user's situation.
    act(() => {
      fireEvent.click(screen.getByTestId("activity-search"));
    });

    const input = screen.getByTestId("search-input");
    expect(document.activeElement).toBe(input);
  });

  it("shows an invocation failure with a retry instead of zero results", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.searchWorkspace
      .mockRejectedValueOnce(new Error("Workspace root vanished."))
      .mockResolvedValueOnce({ status: "accepted" });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-search"));
    await user.type(await screen.findByTestId("search-input"), "apples");

    const error = await screen.findByTestId("workspace-shell-error");
    expect(error.textContent).toContain(
      "dohc could not search this workspace. Workspace root vanished.",
    );
    expect(screen.queryByTestId("search-summary")).toBeNull();
    expect(screen.queryByTestId("search-empty-state")).toBeNull();

    await user.click(screen.getByTestId("workspace-shell-error-retry"));

    expect(bridge.searchWorkspace).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(screen.getByTestId("search-spinner")).toBeTruthy();
  });

  it("clears a failed search banner when a newer search succeeds", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.searchWorkspace
      .mockRejectedValueOnce(new Error("Workspace root vanished."))
      .mockResolvedValueOnce({ status: "accepted" });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-search"));
    const input = await screen.findByTestId("search-input");
    await user.type(input, "apples");
    await screen.findByTestId("workspace-shell-error");

    fireEvent.change(input, { target: { value: "bananas" } });
    await waitFor(() => expect(bridge.searchWorkspace).toHaveBeenCalledTimes(2));
    const newer = bridge.searchWorkspace.mock.calls[1]![0];
    expect(newer.query).toBe("bananas");
    act(() => {
      bridge.emitSearchResults({
        searchId: newer.searchId,
        entries: [],
        done: true,
        limitHit: false,
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("search-summary").textContent).toBe("No results"),
    );
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("clears the activity badge as soon as the query is cleared", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-search"));
    const input = await screen.findByTestId("search-input");

    await user.type(input, "apples");
    await waitFor(() => expect(bridge.searchWorkspace).toHaveBeenCalled());

    const searchPayload = bridge.searchWorkspace.mock.calls.at(-1)![0];
    act(() => {
      bridge.emitSearchResults({
        searchId: searchPayload.searchId,
        entries: [
          {
            path: "a.md",
            line: 1,
            column: 9,
            preview: "I ate 10 apples",
            matchStart: 9,
            matchEnd: 15,
          },
          {
            path: "b.md",
            line: 2,
            column: 4,
            preview: "two apples",
            matchStart: 4,
            matchEnd: 10,
          },
        ],
        done: true,
        limitHit: false,
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("activity-search-count").textContent).toBe("2"),
    );

    await user.clear(input);

    await waitFor(() => {
      expect(screen.queryByTestId("activity-search-count")).toBeNull();
    });
  });

  // The results outlive the panel, so the criteria that produced them
  // must too. A reopened empty input above surviving results named a query
  // the user never sees.
  it("reopens the panel showing the criteria its results belong to", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-search"));
    await user.type(await screen.findByTestId("search-input"), "apples");
    await user.click(screen.getByTestId("search-toggle-case"));
    await waitFor(() => expect(bridge.searchWorkspace).toHaveBeenCalled());

    const searchPayload = bridge.searchWorkspace.mock.calls.at(-1)![0];
    expect(searchPayload.caseSensitive).toBe(true);
    act(() => {
      bridge.emitSearchResults({
        searchId: searchPayload.searchId,
        entries: [
          {
            path: "a.md",
            line: 1,
            column: 9,
            preview: "I ate 10 apples",
            matchStart: 9,
            matchEnd: 15,
          },
        ],
        done: true,
        limitHit: false,
      });
    });
    await screen.findByTestId("search-result-row");

    // Clicking the active rail item collapses the panel: SearchView unmounts.
    await user.click(screen.getByTestId("activity-search"));
    expect(screen.queryByTestId("search-input")).toBeNull();
    await user.click(screen.getByTestId("activity-search"));

    const reopened = await screen.findByTestId("search-input");
    expect((reopened as HTMLInputElement).value).toBe("apples");
    expect(screen.getByTestId("search-toggle-case").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getAllByTestId("search-result-row")).toHaveLength(1);
  });

  // The filter boxes are collapsed by default, so a surviving glob would
  // narrow the visible results from behind a closed disclosure.
  it("reopens the filter boxes when the surviving criteria carry a glob", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-search"));
    await user.type(await screen.findByTestId("search-input"), "apples");
    await user.click(screen.getByTestId("search-filter-toggle"));
    await user.type(await screen.findByTestId("search-include"), "*.md");
    await waitFor(() =>
      expect(bridge.searchWorkspace.mock.calls.at(-1)![0].includeGlob).toBe("*.md"),
    );

    await user.click(screen.getByTestId("activity-search"));
    expect(screen.queryByTestId("search-input")).toBeNull();
    await user.click(screen.getByTestId("activity-search"));

    const reopenedInclude = await screen.findByTestId("search-include");
    expect((reopenedInclude as HTMLInputElement).value).toBe("*.md");
    expect(screen.getByTestId("search-exclude")).toBeTruthy();
  });
});

describe("file tree drag preview", () => {
  it("marks no-op drops before release", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);

    const rows = await screen.findAllByTestId("tree-row");
    const rowA = rows.find((row) => row.getAttribute("data-path") === "a.md")!;
    const rowB = rows.find((row) => row.getAttribute("data-path") === "b.md")!;
    const dataTransfer = {
      effectAllowed: "move",
      dropEffect: "move",
      files: [],
      types: [],
      setData: vi.fn(),
    };

    fireEvent.dragStart(rowA, { dataTransfer });
    fireEvent.dragOver(rowB, { dataTransfer });

    expect(rowB.dataset.dropState).toBe("blocked");
    expect(within(rowB).queryByTestId("tree-drop-label")).toBeNull();
    expect(dataTransfer.dropEffect).toBe("none");
  });

  it("highlights a hovered folder and its visible contents", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockResolvedValue({
      files: [
        { path: "docs/a.md", kind: "file" as const },
        { path: "docs/b.md", kind: "file" as const },
        { path: "loose.md", kind: "file" as const },
      ],
      folders: ["docs"],
    });
    const user = userEvent.setup();
    renderShell(bridge);

    const folder = await screen.findByText("docs");
    await user.click(folder);

    const rows = await screen.findAllByTestId("tree-row");
    const source = rows.find((row) => row.getAttribute("data-path") === "loose.md")!;
    const docs = rows.find((row) => row.getAttribute("data-path") === "docs")!;
    const childA = rows.find((row) => row.getAttribute("data-path") === "docs/a.md")!;
    const childB = rows.find((row) => row.getAttribute("data-path") === "docs/b.md")!;
    const dataTransfer = {
      effectAllowed: "move",
      dropEffect: "move",
      files: [],
      types: [],
      setData: vi.fn(),
    };

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(docs, { dataTransfer });

    expect(docs.dataset.dropState).toBe("move");
    expect(childA.dataset.dropState).toBe("move");
    expect(childB.dataset.dropState).toBe("move");
    expect(within(docs).queryByTestId("tree-drop-label")).toBeNull();
  });
});

describe("graph view", () => {
  it("highlights the focused document in a full graph from another editor group", async () => {
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          { id: "left", tabs: ["a.md"], activeTab: "a.md", size: 0.5 },
          { id: "right", tabs: ["b.md"], activeTab: "b.md", size: 0.5 },
        ],
        activeEditorGroup: "left",
      }),
    );
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-graph"));
    await user.click(await screen.findByTestId("graph-open-tab"));
    await user.click(screen.getByTestId("tab-b.md"));

    const pageGraph = (await screen.findAllByTestId("graph-view")).find(
      (view) => view.dataset.variant === "page",
    )!;
    const graphNodes = await within(pageGraph).findAllByTestId("graph-node");
    expect(
      graphNodes.find((node) => node.dataset.path === "b.md")?.dataset.active,
    ).toBe("true");
    expect(
      graphNodes.find((node) => node.dataset.path === "a.md")?.dataset.active,
    ).toBe("false");
  });

  it("opens as a side panel first, then opens the full graph in an editor tab", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    await screen.findByTestId("view-markdown");

    await user.click(screen.getByTestId("activity-graph"));

    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
    expect(screen.getByTestId("view-markdown")).toBeTruthy();
    await waitFor(() => {
      expect(
        screen
          .getAllByTestId("graph-view")
          .some((view) => view.getAttribute("data-variant") === "panel"),
      ).toBe(true);
    });

    await user.click(screen.getByTestId("graph-open-tab"));

    const graphTab = await screen.findByTestId("tab-dohc://graph");
    expect(graphTab.dataset.active).toBe("true");
    await waitFor(() => {
      expect(
        screen
          .getAllByTestId("graph-view")
          .some((view) => view.getAttribute("data-variant") === "page"),
      ).toBe(true);
    });
  });
});

describe("workbench resize commits", () => {
  it("keeps four pointer-rate previews local and arms persistence once per drag", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          { id: "left", tabs: ["a.md"], activeTab: "a.md", size: 0.5 },
          { id: "right", tabs: ["b.md"], activeTab: "b.md", size: 0.5 },
        ],
        activeEditorGroup: "left",
      }),
    );
    renderShell(bridge);

    const sidebar = await screen.findByTestId("side-panel");
    const chats = await screen.findByTestId("chats-panel");
    const openEditors = await screen.findByTestId("open-editors-list");
    const editorLayout = await screen.findByTestId("editor-group-layout");
    await screen.findByTestId("editor-group-left");
    Object.defineProperty(chats, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ right: 1_000 }),
    });
    Object.defineProperty(editorLayout, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 1_000 }),
    });

    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const persistenceArms = () =>
      timeoutSpy.mock.calls.filter(
        ([, delay]) => delay === WORKBENCH_PERSIST_DELAY_MS,
      ).length;
    try {
      const sidebarHandle = screen.getByTestId("sidebar-resize");
      timeoutSpy.mockClear();
      fireEvent.pointerDown(sidebarHandle, {
        button: 0,
        buttons: 1,
        pointerId: 1,
      });
      for (const clientX of [360, 400, 440]) {
        fireEvent.pointerMove(sidebarHandle, {
          buttons: 1,
          clientX,
          pointerId: 1,
        });
      }
      expect(sidebar.style.width).toBe("440px");
      expect(persistenceArms()).toBe(0);
      fireEvent.pointerUp(sidebarHandle, { pointerId: 1 });
      expect(sidebar.style.width).toBe("440px");
      expect(persistenceArms()).toBe(1);

      const chatsHandle = screen.getByTestId("chats-panel-resize");
      timeoutSpy.mockClear();
      fireEvent.pointerDown(chatsHandle, {
        button: 0,
        buttons: 1,
        pointerId: 2,
      });
      for (const clientX of [620, 560, 500]) {
        fireEvent.pointerMove(chatsHandle, {
          buttons: 1,
          clientX,
          pointerId: 2,
        });
      }
      expect(chats.style.width).toBe("500px");
      expect(persistenceArms()).toBe(0);
      fireEvent.pointerCancel(chatsHandle, { pointerId: 2 });
      expect(chats.style.width).toBe("500px");
      expect(persistenceArms()).toBe(1);

      const openEditorsHandle = screen.getByTestId("open-editors-resize");
      timeoutSpy.mockClear();
      fireEvent.pointerDown(openEditorsHandle, {
        button: 0,
        buttons: 1,
        clientY: OPEN_EDITORS_DEFAULT_HEIGHT,
        pointerId: 3,
      });
      for (const clientY of [150, 180, 200]) {
        fireEvent.pointerMove(openEditorsHandle, {
          buttons: 1,
          clientY,
          pointerId: 3,
        });
      }
      expect(openEditors.style.maxHeight).toBe("200px");
      expect(persistenceArms()).toBe(0);
      fireEvent(window, new Event("blur"));
      expect(openEditors.style.maxHeight).toBe("200px");
      expect(persistenceArms()).toBe(1);

      const groupHandle = screen.getByTestId("editor-group-resize-left-right");
      timeoutSpy.mockClear();
      fireEvent.pointerDown(groupHandle, {
        button: 0,
        buttons: 1,
        clientX: 500,
        pointerId: 4,
      });
      for (const clientX of [550, 600, 650]) {
        fireEvent.pointerMove(groupHandle, {
          buttons: 1,
          clientX,
          pointerId: 4,
        });
      }
      expect(screen.getByTestId("editor-group-left").style.flexGrow).toBe("0.65");
      expect(persistenceArms()).toBe(0);
      fireEvent.lostPointerCapture(groupHandle, { pointerId: 4 });
      expect(screen.getByTestId("editor-group-left").style.flexGrow).toBe("0.65");
      expect(persistenceArms()).toBe(1);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("open editors", () => {
  it("highlights the full open editors and files header bars on hover", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);

    await screen.findAllByTestId("tree-row");
    expect(screen.getByTestId("open-editors-header").className).toContain(
      "hover:bg-hover",
    );
    expect(screen.getByTestId("explorer-files-header").className).toContain(
      "hover:bg-hover",
    );
    expect(screen.getByTestId("open-editors-toggle").className).not.toContain(
      "hover:bg-hover",
    );
    expect(screen.getByTestId("explorer-files-toggle").className).not.toContain(
      "hover:bg-hover",
    );
  });

  it("collapses and restores the file tree section", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    expect(await screen.findAllByTestId("tree-row")).toHaveLength(2);
    await user.click(screen.getByTestId("explorer-files-toggle"));

    expect(screen.queryAllByTestId("tree-row")).toHaveLength(0);
    expect(screen.getByTestId("explorer-files-toggle").getAttribute("aria-expanded")).toBe(
      "false",
    );

    await user.click(screen.getByTestId("explorer-files-toggle"));
    expect(await screen.findAllByTestId("tree-row")).toHaveLength(2);
  });

  it("surfaces open-editor title actions for untitled files and close-all", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findAllByTestId("tree-row");
    await user.click(screen.getByLabelText("New untitled text file"));

    expect(bridge.createWorkspaceFile).toHaveBeenCalledWith({
      workspaceId: "ws-shell-test",
      relativePath: "Untitled.txt",
      initialText: "",
    });
    expect(await screen.findByTestId("tab-Untitled.txt")).toBeTruthy();

    await user.click(screen.getByLabelText("Close all editors"));
    await waitFor(() => expect(screen.queryByTestId("tab-Untitled.txt")).toBeNull());
    expect(screen.queryAllByTestId("open-editor-row")).toHaveLength(0);
  });

  it("numbers untitled text files after case-insensitive file and folder matches", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockResolvedValue({
      files: [{ path: "untitled.txt", kind: "file" as const }],
      folders: ["UNTITLED 2.TXT"],
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findAllByTestId("tree-row");
    await user.click(screen.getByLabelText("New untitled text file"));

    expect(bridge.createWorkspaceFile).toHaveBeenCalledWith({
      workspaceId: "ws-shell-test",
      relativePath: "Untitled 3.txt",
      initialText: "",
    });
  });

  it("surfaces file title actions for create, refresh, and collapse folders", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findAllByTestId("tree-row");
    await user.click(screen.getByLabelText("New file"));
    expect(await screen.findByLabelText("New file name")).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.click(screen.getByLabelText("New folder"));
    expect(await screen.findByLabelText("New folder name")).toBeTruthy();
    await user.keyboard("{Escape}");

    const refreshCount = bridge.listWorkspaceFiles.mock.calls.length;
    await user.click(screen.getByLabelText("Refresh explorer"));
    await waitFor(() =>
      expect(bridge.listWorkspaceFiles.mock.calls.length).toBeGreaterThan(refreshCount),
    );
    expect(bridge.listWorkspaceFiles, "an explicit refresh must not opt into the activity cache.").toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE.workspaceId,
    });
  });

  it("creates files and folders from the files title actions at the focused tree context", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockResolvedValue({
      files: [{ path: "docs/a.md", kind: "file" as const }],
      folders: ["docs"],
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("docs"));
    await user.click(screen.getByLabelText("New file"));
    await user.keyboard("notes.md{Enter}");

    await waitFor(() =>
      expect(bridge.createWorkspaceFile).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        relativePath: "docs/notes.md",
        initialText: "",
      }),
    );

    await user.click(await screen.findByText("a.md"));
    await user.click(screen.getByLabelText("New folder"));
    await user.keyboard("assets{Enter}");

    await waitFor(() =>
      expect(bridge.createWorkspaceFolder).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        relativePath: "docs/assets",
      }),
    );
  });

  it("collapses all expanded folders from the files title action", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockResolvedValue({
      files: [{ path: "docs/a.md", kind: "file" as const }],
      folders: ["docs"],
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("docs"));
    await screen.findByText("a.md");
    await user.click(screen.getByLabelText("Collapse folders in explorer"));

    await waitFor(() => expect(screen.queryByText("a.md")).toBeNull());
  });

  it("mirrors tabs in the explorer and supports activate and close", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    const treeRows = await screen.findAllByTestId("tree-row");
    const rowA = treeRows.find((row) => row.getAttribute("data-path") === "a.md")!;
    const rowB = treeRows.find((row) => row.getAttribute("data-path") === "b.md")!;

    await user.click(rowA);
    await user.click(rowB);
    await screen.findByTestId("tab-b.md");

    const editorRows = () => screen.getAllByTestId("open-editor-row");
    const openA = () =>
      editorRows().find((row) => row.getAttribute("data-path") === "a.md")!;
    const openB = () =>
      editorRows().find((row) => row.getAttribute("data-path") === "b.md")!;

    expect(openA()).toBeTruthy();
    expect(openB().getAttribute("data-active")).toBe("true");

    await user.click(within(openA()).getByText("a.md"));
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
    expect(openA().getAttribute("data-active")).toBe("true");

    await user.click(within(openA()).getByLabelText("Close a.md"));
    await waitFor(() => expect(screen.queryByTestId("tab-a.md")).toBeNull());
    expect(editorRows().map((row) => row.getAttribute("data-path"))).toEqual(["b.md"]);
  });

  it("caps the open editors list height so it scrolls instead of growing unbounded", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    const treeRows = await screen.findAllByTestId("tree-row");
    const rowA = treeRows.find((row) => row.getAttribute("data-path") === "a.md")!;
    await user.click(rowA);
    await screen.findByTestId("tab-a.md");

    // The list is bounded and scrolls internally (VS Code-style Open Editors)
    // instead of growing without limit as more editors open. The scroll-to-
    // active behavior needs real layout and is covered by the desktop e2e
    // spec (workspace-open-editors.spec.ts).
    const list = screen.getByTestId("open-editors-list");
    expect(list.style.maxHeight).toBe(`${OPEN_EDITORS_DEFAULT_HEIGHT}px`);
    expect(list.className).toContain("overflow-y-auto");
  });

  it("resizes the open editors section by dragging its bottom edge", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    const treeRows = await screen.findAllByTestId("tree-row");
    const rowA = treeRows.find((row) => row.getAttribute("data-path") === "a.md")!;
    await user.click(rowA);
    await screen.findByTestId("tab-a.md");

    const list = screen.getByTestId("open-editors-list");
    const handle = screen.getByTestId("open-editors-resize");
    // A non-left press must not start a resize.
    fireEvent.pointerDown(handle, {
      button: 2,
      buttons: 2,
      clientY: 200,
      pointerId: 1,
    });
    fireEvent.pointerMove(handle, { buttons: 2, clientY: 500, pointerId: 1 });
    expect(list.style.maxHeight).toBe(`${OPEN_EDITORS_DEFAULT_HEIGHT}px`);

    fireEvent.pointerDown(handle, {
      button: 0,
      buttons: 1,
      clientY: 200,
      pointerId: 1,
    });
    // The one-item list is shorter than its cap; a zero-delta move must
    // preserve the saved cap.
    fireEvent.pointerMove(handle, { buttons: 1, clientY: 200, pointerId: 1 });
    expect(list.style.maxHeight).toBe(`${OPEN_EDITORS_DEFAULT_HEIGHT}px`);

    fireEvent.pointerMove(handle, { buttons: 1, clientY: 374, pointerId: 1 });
    await waitFor(() => {
      expect(list.style.maxHeight).toBe("300px");
    });

    // Dragging far above the list clamps at the minimum height.
    fireEvent.pointerMove(handle, { buttons: 1, clientY: 0, pointerId: 1 });
    await waitFor(() => {
      expect(list.style.maxHeight).toBe(`${OPEN_EDITORS_MIN_HEIGHT}px`);
    });
  });

  it("clamps the rendered open editors height to the viewport", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const original = window.innerHeight;
    try {
      const user = userEvent.setup();
      renderShell(makeBridge(Promise.resolve(null)));

      const treeRows = await screen.findAllByTestId("tree-row");
      const rowA = treeRows.find((row) => row.getAttribute("data-path") === "a.md")!;
      await user.click(rowA);
      await screen.findByTestId("tab-a.md");

      const list = screen.getByTestId("open-editors-list");
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        writable: true,
        value: 150,
      });
      fireEvent(window, new Event("resize"));
      await waitFor(() => expect(list.style.maxHeight).toBe("90px"));

      const handle = screen.getByTestId("open-editors-resize");
      fireEvent.pointerDown(handle, {
        button: 0,
        buttons: 1,
        clientY: 100,
        pointerId: 1,
      });
      fireEvent.pointerMove(handle, { buttons: 1, clientY: 200, pointerId: 1 });
      expect(list.style.maxHeight).toBe("90px");

      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        writable: true,
        value: 768,
      });
      fireEvent(window, new Event("resize"));
      await waitFor(() => expect(list.style.maxHeight).toBe("190px"));
    } finally {
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        writable: true,
        value: original,
      });
      window.dispatchEvent(new Event("resize"));
    }
  });
});

describe("native workbench context menus", () => {
  it("moves the selected tab into a new group", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md")),
    );
    bridge.showWorkbenchMenu.mockResolvedValue("move-tab-to-new-group");
    renderShell(bridge);
    await screen.findByTestId("tab-a.md");

    fireEvent.contextMenu(screen.getByTestId("tab-a.md"));

    const right = await screen.findByRole("region", { name: "Editor group 2" });
    expect(within(right).getByTestId("tab-a.md")).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Editor group 1" })).getByTestId(
        "tab-b.md",
      ),
    ).toBeTruthy();
  });

  it("routes tab context menu commands through existing tab actions", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.showWorkbenchMenu.mockResolvedValue("close-other-tabs");
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    await user.click(screen.getByText("b.md"));
    await screen.findByTestId("tab-b.md");

    fireEvent.contextMenu(screen.getByTestId("tab-a.md"));

    await waitFor(() => {
      expect(bridge.showWorkbenchMenu).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        context: "tab",
        path: "a.md",
        groupId: "primary",
        canCloseEditorGroup: false,
      });
    });
    await waitFor(() => expect(screen.queryByTestId("tab-b.md")).toBeNull());
    expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
  });

  it("keeps the last editor group when the native menu returns close-editor-group", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md")),
    );
    bridge.showWorkbenchMenu.mockResolvedValue("close-editor-group");
    renderShell(bridge);
    await screen.findByTestId("tab-a.md");

    fireEvent.contextMenu(screen.getByTestId("tab-a.md"));

    await waitFor(() => expect(bridge.showWorkbenchMenu).toHaveBeenCalled());
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
    expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(1);
  });

  it("opens the native editor context menu from the inspector area", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    fireEvent.contextMenu(await screen.findByTestId("view-markdown"));

    await waitFor(() => {
      expect(bridge.showWorkbenchMenu).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
        context: "editor",
        path: "a.md",
        groupId: "primary",
      });
    });
  });
});

describe("settings entry points", () => {
  it("opens settings from the activity bar", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("activity-settings"));
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
  });

  it("opens settings from the command palette and menu command", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText("Settings"),
    );
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
    await user.click(screen.getByLabelText("Close settings"));

    act(() => bridge.emitMenuCommand("settings"));
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
  });

  it("opens appearance settings from a section command and Ctrl+comma", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText(
        "Settings: Open Appearance",
      ),
    );
    expect(await screen.findByTestId("settings-section-appearance")).toBeTruthy();
    await user.click(screen.getByLabelText("Close settings"));

    await user.keyboard("{Control>},{/Control}");
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
  });
});

describe("customize", () => {
  it("opens the sidebar's settings from its menu, and Add an app here… opens Apps", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByRole("button", { name: "Sidebar actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Customize…" }));
    const row = await screen.findByTestId("settings-row-sidebar");
    expect(row.dataset.highlighted).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(row));
    await user.click(screen.getByLabelText("Close settings"));

    await user.click(screen.getByRole("button", { name: "Sidebar actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Add an app here…" }));
    // The rail marks Apps at once; its view loads on its own clock.
    expect(screen.getByTestId("activity-sites").getAttribute("aria-current")).toBe("page");
  });

  it("hands a Chats setting to the person's agent in the agent's chat", async () => {
    const agentChannel: ChatChannelRecord = {
      id: "channel-agent", name: "Agent", slug: "agent", kind: "agent",
      createdAtMs: 1, updatedAtMs: 1, threadCount: 0, unreadCount: 0,
    };
    // Share answers unlock the channel's composer; without them it fails closed.
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      listChatChannelShares: vi.fn(async () => ({
        joined: [], sessionKey: null,
        relay: { state: "answered" as const, granted: [], received: [] },
      })),
    });
    bridge.listChatChannels = vi.fn(async () => ({ channels: [agentChannel], fileThreads: [] }));
    const user = userEvent.setup();
    vi.stubGlobal("dohcDesktop", bridge);
    render(<DesktopWorkspaceShell
      workspace={WORKSPACE}
      workspaces={[WORKSPACE]}
      {...shellBootstrapProps(bridge)}
      userSettings={{ source: "stored", settings: {
        ...DEFAULT_USER_SETTINGS,
        profile: { agentName: "Nova" },
        runner: { ...DEFAULT_USER_SETTINGS.runner, enabled: true, command: "node agent.mjs" },
      } }}
      onSwitchWorkspace={() => {}}
    />);

    await user.click(await screen.findByTestId("titlebar-chats-sidebar"));
    await user.click(await screen.findByRole("button", { name: "Chats actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Customize…" }));
    const row = await screen.findByTestId("settings-row-your-color");
    expect(row.dataset.highlighted).toBe("true");
    await user.click(await within(row).findByRole("button", { name: "Ask my agent" }));

    await waitFor(() => expect(screen.queryByTestId("settings-dialog")).toBeNull());
    expect(await screen.findByTestId(`tab-dohc://chats/channel/${encodeURIComponent(agentChannel.id)}`)).toBeTruthy();
    const composer = await screen.findByTestId<HTMLTextAreaElement>("chats-new-thread-composer");
    await waitFor(() => expect(composer.value).toBe([
      'Change my dohc chat colors settings. They are the "appearance.yourColor" and "appearance.yourAgentColor" keys in my dohc settings file, /state/dohc-settings.json.',
      "dohc applies the file when it is saved.",
      "What I want: ",
    ].join("\n")));
    expect(document.activeElement).toBe(composer);
    expect(composer.selectionStart).toBe(composer.value.length);
  });
});

describe("drawing entry point", () => {
  it("creates and opens an empty engine-claimable drawing from the command palette", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText(
        "New drawing",
      ),
    );

    await waitFor(() =>
      expect(bridge.createWorkspaceFile).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        relativePath: "Untitled.excalidraw",
        initialText: "",
      }),
    );
    expect(
      (await screen.findAllByText("Untitled.excalidraw")).length,
    ).toBeGreaterThan(0);
  });

  it("numbers drawings after case-insensitive file and folder matches", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockResolvedValue({
      files: [{ path: "UNTITLED 2.EXCALIDRAW", kind: "file" as const }],
      folders: ["untitled.excalidraw"],
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findAllByTestId("tree-row");
    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText(
        "New drawing",
      ),
    );

    await waitFor(() =>
      expect(bridge.createWorkspaceFile).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        relativePath: "Untitled 3.excalidraw",
        initialText: "",
      }),
    );
  });

  it("opens a new drawing only in the focused editor group", async () => {
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          { id: "left", tabs: ["a.md"], activeTab: "a.md", size: 0.5 },
          { id: "right", tabs: ["b.md"], activeTab: "b.md", size: 0.5 },
        ],
        activeEditorGroup: "right",
      }),
    );
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findByTestId("tab-a.md");
    await screen.findByTestId("tab-b.md");
    const left = await screen.findByRole("region", { name: "Editor group 1" });
    const right = await screen.findByRole("region", { name: "Editor group 2" });
    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText(
        "New drawing",
      ),
    );

    expect(await within(right).findByTestId("tab-Untitled.excalidraw")).toBeTruthy();
    expect(within(left).queryByTestId("tab-Untitled.excalidraw")).toBeNull();
    expect(within(left).getByTestId("tab-a.md")).toBeTruthy();
  });
});

// D2#2/#5/#6/#8: the shell stops re-rendering the world. The probes are real
// functions the memoized surfaces call once per render (see the vi.mock spies
// at the top), so a zero delta IS the bailout — and breaking any stabilization
// (an inline arrow back in the Explorer prop set, a dropped memo, a dropped
// suspendPolling plumb) makes these fail.
describe("workbench render cost", () => {
  it("a shell re-render with unchanged props re-renders neither tree rows nor the inspector", async () => {
    const bridge = holdHistory(makeBridge(Promise.resolve(STORED_STATE)));
    vi.stubGlobal("dohcDesktop", bridge);
    // A fresh element per render with identical prop values: rerendering the
    // same element reference lets React skip the subtree outright, which
    // would pass without re-rendering the shell at all.
    const workspaces = [WORKSPACE];
    const onSwitchWorkspace = () => {};
    const bootstrapProps = shellBootstrapProps(bridge);
    const shellElement = () => (
      <DesktopWorkspaceShell
        workspace={WORKSPACE}
        workspaces={workspaces}
        {...bootstrapProps}
        onSwitchWorkspace={onSwitchWorkspace}
      />
    );
    const view = render(shellElement());
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    await screen.findByTestId("markdown-editor");
    expect(screen.getAllByTestId("tree-row").length).toBeGreaterThan(0);

    // The deltas are measured across one synchronous re-render, so a read
    // still in flight cannot inflate them: nothing async can interleave
    // between the capture, the rerender, and the assertions.
    const keyCalls = vi.mocked(documentVersionKey).mock.calls.length;
    const leafCalls = vi.mocked(basenameOf).mock.calls.length;
    view.rerender(shellElement());
    expect(vi.mocked(documentVersionKey).mock.calls.length).toBe(keyCalls);
    expect(vi.mocked(basenameOf).mock.calls.length).toBe(leafCalls);
  });

  it("caps a sustained activity burst and keeps its trailing refresh", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    await screen.findAllByTestId("tree-row");

    vi.useFakeTimers();
    try {
      const listings = bridge.listWorkspaceFiles.mock.calls.length;
      const statusReads = bridge.getSyncStatus.mock.calls.length;
      const eventIntervalMs = 100;
      const burstDurationMs = WORKSPACE_ACTIVITY_REFRESH_MAX_WAIT_MS * 2.5;
      for (let elapsed = 0; elapsed < burstDurationMs; elapsed += eventIntervalMs) {
        act(() => bridge.emitWorkspaceActivity());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(eventIntervalMs);
        });
      }
      // Events never go quiet for the 200ms trailing delay. The 1s cap still
      // refreshes at t=1000 and t=2000, then leaves one trailing pass armed.
      expect(bridge.listWorkspaceFiles.mock.calls.length).toBe(listings + 2);
      expect(bridge.getSyncStatus.mock.calls.length).toBe(statusReads + 2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS);
      });
      expect(bridge.listWorkspaceFiles.mock.calls.length).toBe(listings + 3);
      expect(bridge.getSyncStatus.mock.calls.length).toBe(statusReads + 3);

      // The window re-arms: a later lone event still refreshes.
      act(() => bridge.emitWorkspaceActivity());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS);
      });
      expect(bridge.listWorkspaceFiles.mock.calls.length).toBe(listings + 4);
      expect(bridge.getSyncStatus.mock.calls.length).toBe(statusReads + 4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips only an all-hidden file window and still refreshes every history lane", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    await screen.findAllByTestId("tree-row");

    vi.useFakeTimers();
    try {
      const listings = bridge.listWorkspaceFiles.mock.calls.length;
      const moments = bridge.listEngineMoments.mock.calls.length;
      const statuses = bridge.getSyncStatus.mock.calls.length;
      const agents = bridge.getAgentRunStatus.mock.calls.length;
      const tryStates = bridge.getTryInVersionState.mock.calls.length;

      act(() =>
        bridge.emitWorkspaceActivity({
          workspaceId: WORKSPACE.workspaceId,
          paths: [".dohc/engine/index", "pkg/node_modules/cache.bin"],
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS);
      });

      expect(bridge.listWorkspaceFiles, "refreshing files for every path-rich event makes the hidden engine and dependency churn pay for a disk walk it cannot change.").toHaveBeenCalledTimes(listings);
      // Path alone cannot prove history harmless. A deleted or retired path
      // may be absent from the current tree and still change these surfaces.
      expect(bridge.listEngineMoments).toHaveBeenCalledTimes(moments + 1);
      expect(bridge.getSyncStatus).toHaveBeenCalledTimes(statuses + 1);
      expect(bridge.getAgentRunStatus).toHaveBeenCalledTimes(agents + 1);
      expect(bridge.getTryInVersionState).toHaveBeenCalledTimes(tryStates + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a mixed path-rich window through main's complete-listing cache", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );

    await waitFor(() => expect(bridge.workspaceActivitySubscriberCount()).toBe(1));

    vi.useFakeTimers();
    try {
      const listings = bridge.listWorkspaceFiles.mock.calls.length;
      const statusReads = bridge.getSyncStatus.mock.calls.length;
      act(() => {
        bridge.emitWorkspaceActivity({
          workspaceId: WORKSPACE.workspaceId,
          paths: [".git/objects/ignored"],
        });
        bridge.emitWorkspaceActivity({
          workspaceId: WORKSPACE.workspaceId,
          paths: ["notes/created.md"],
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS);
      });

      expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(listings + 1);
      expect(bridge.listWorkspaceFiles).toHaveBeenLastCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        allowCached: true,
      });
      expect(bridge.getSyncStatus).toHaveBeenCalledTimes(statusReads + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes files for a non-reserved .GIT prefix on Linux", async () => {
    const bridge = makeBridge(Promise.resolve(null), "linux");
    renderShell(bridge);
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );

    await waitFor(() => expect(bridge.workspaceActivitySubscriberCount()).toBe(1));

    vi.useFakeTimers();
    try {
      const listings = bridge.listWorkspaceFiles.mock.calls.length;
      act(() =>
        bridge.emitWorkspaceActivity({
          workspaceId: WORKSPACE.workspaceId,
          paths: [".GIT-not-reserved/file.md"],
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS);
      });

      expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(listings + 1);
      expect(bridge.listWorkspaceFiles).toHaveBeenLastCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        allowCached: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores reserved .GIT activity paths on Linux", async () => {
    const bridge = makeBridge(Promise.resolve(null), "linux");
    renderShell(bridge);
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );

    await waitFor(() => expect(bridge.workspaceActivitySubscriberCount()).toBe(1));

    vi.useFakeTimers();
    try {
      const listings = bridge.listWorkspaceFiles.mock.calls.length;
      act(() =>
        bridge.emitWorkspaceActivity({
          workspaceId: WORKSPACE.workspaceId,
          paths: [".GIT/file.md"],
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS);
      });

      expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(listings);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes any pathless event in a mixed window force the full refresh", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    await waitFor(() => expect(bridge.workspaceActivitySubscriberCount()).toBe(1));

    vi.useFakeTimers();
    try {
      const listings = bridge.listWorkspaceFiles.mock.calls.length;
      const statusReads = bridge.getSyncStatus.mock.calls.length;
      act(() => {
        bridge.emitWorkspaceActivity({
          workspaceId: WORKSPACE.workspaceId,
          paths: ["notes/changed.md"],
        });
        bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId });
        bridge.emitWorkspaceActivity({
          workspaceId: WORKSPACE.workspaceId,
          paths: [".dohc/engine/index"],
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS);
      });

      expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(listings + 1);
      expect(bridge.listWorkspaceFiles, "once broad, a later scoped event must not downgrade the window to a cacheable request.").toHaveBeenLastCalledWith({
        workspaceId: WORKSPACE.workspaceId,
      });
      expect(bridge.getSyncStatus).toHaveBeenCalledTimes(statusReads + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a mismatched workspace payload as a full refresh", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);
    await screen.findAllByTestId("tree-row");

    await waitFor(() => expect(bridge.workspaceActivitySubscriberCount()).toBe(1));

    vi.useFakeTimers();
    try {
      const listings = bridge.listWorkspaceFiles.mock.calls.length;
      act(() =>
        bridge.emitWorkspaceActivity({
          workspaceId: "ws-other",
          paths: [".dohc/engine/index"],
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS);
      });

      vi.useRealTimers();
      await waitFor(
        () =>
          expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(listings + 1),
      );
      expect(bridge.listWorkspaceFiles).toHaveBeenLastCalledWith({
        workspaceId: WORKSPACE.workspaceId,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not skip an all-hidden window before the first listing commits", async () => {
    const pending = deferred<{
      files: { path: string; kind: "file" }[];
      folders: string[];
    }>();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles = vi.fn(() => pending.promise);
    renderShell(bridge);
    await waitFor(
      () => {
        expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(1);
        expect(bridge.workspaceActivitySubscriberCount()).toBe(1);
      },
    );

    vi.useFakeTimers();
    try {
      act(() =>
        bridge.emitWorkspaceActivity({
          workspaceId: WORKSPACE.workspaceId,
          paths: [".dohc/engine/index"],
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS);
      });

      expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2);
      expect(bridge.listWorkspaceFiles).toHaveBeenLastCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        allowCached: true,
      });
    } finally {
      await act(async () => {
        pending.resolve({
          files: [{ path: "a.md", kind: "file" }],
          folders: [],
        });
        await pending.promise;
      });
      vi.useRealTimers();
    }
  });

  it("suspends the navigator's polling while a Chats tab is live", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs([], null)),
    );
    renderShell(bridge);
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    await screen.findByTestId("chats-view");

    // Alone, the panel navigator answers activity itself: one DM sync.
    // (Both chats instances call syncDms synchronously from the activity
    // listener, so the counts need no settling wait.)
    const alone = bridge.syncDms.mock.calls.length;
    act(() => bridge.emitWorkspaceActivity());
    expect(bridge.syncDms.mock.calls.length).toBe(alone + 1);

    // The Home page refreshes its feed; the suspended navigator does not
    // perform another DM sync.
    await user.click(await screen.findByTestId("chats-open-tab"));
    await screen.findByTestId("chats-personal-feed");
    expect(screen.getAllByTestId("chats-view")).toHaveLength(1);
    const paired = bridge.syncDms.mock.calls.length;
    const feedReads = bridge.listPersonalChatFeed.mock.calls.length;
    act(() => bridge.emitWorkspaceActivity());
    expect(bridge.syncDms.mock.calls.length).toBe(paired);
    expect(bridge.listPersonalChatFeed.mock.calls.length).toBe(feedReads + 1);
  });

  it("does not sync DMs from the suspended navigator when an open channel thread refreshes", async () => {
    const user = userEvent.setup();
    const bridge = Object.assign(
      makeBridge(Promise.resolve(storedStateWithTabs([], null))),
      {
        listChatChannels: vi.fn(async () => ({
          channels: [
            {
              id: "channel-team",
              name: "team",
              slug: "team",
              kind: "channel" as const,
              createdAtMs: 1,
              updatedAtMs: 1,
              threadCount: 1,
              unreadCount: 0,
              wireId: "channel-team",
            },
          ],
          fileThreads: [],
        })),
        listChatChannelShares: vi.fn(async () => ({
          joined: [{ channelWireId: "channel-team", joined: null }],
          sessionKey: "session-a",
          relay: {
            state: "answered" as const,
            granted: [],
            received: [],
            removed: [],
          },
        })),
        listChannelThreads: vi.fn(async () => ({
          threads: [
            {
              id: "thread-team",
              title: "Team update",
              createdAtMs: 1,
              updatedAtMs: 1,
              channelId: "channel-team",
              messageCount: 1,
              lastReadSequence: 1,
              unreadCount: 0,
              openingMessage: {
                id: "message-team",
                authorKind: "human" as const,
                authorDisplayName: "Alice",
                bodySnippet: "A settled update",
                createdAtMs: 1,
                reactions: [],
              },
            },
          ],
          viewerAuthorId: "you",
        })),
        listChatMessages: vi.fn(async () => ({
          messages: [
            {
              id: "message-team",
              threadId: "thread-team",
              authorKind: "human" as const,
              authorDisplayName: "Alice",
              body: "A settled update",
              createdAtMs: 1,
            },
          ],
        })),
        listChatReactions: vi.fn(async () => ({
          reactions: [],
          viewerAuthorId: "you",
        })),
        listChatThreadDecisions: vi.fn(async () => ({ decisions: [] })),
        listChatThreadAttachments: vi.fn(async () => ({ attachments: [] })),
        chatRunRecordsForThread: vi.fn(async () => ({ runs: {} })),
        chatDispatchStateForThread: vi.fn(async () => ({
          liveRun: false,
          pendingCount: 0,
          paused: false,
        })),
        markChatThreadRead: vi.fn(async () => ({
          lastReadSequence: 1,
          revision: 1,
        })),
      },
    );
    renderShell(bridge);

    await user.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    expect(screen.getByTestId("chats-new-thread-composer")).toBeTruthy();
    await user.click(await screen.findByTestId("chats-post-card"));
    await screen.findByTestId("chats-thread-view");
    await waitFor(() => expect(bridge.markChatThreadRead).toHaveBeenCalled());
    await waitFor(() => expect(bridge.syncDms).toHaveBeenCalled());
    bridge.markChatThreadRead.mockClear();
    bridge.syncDms.mockClear();

    for (let pass = 1; pass <= 3; pass += 1) {
      act(() => bridge.emitWorkspaceActivity());
      await waitFor(() =>
        expect(bridge.markChatThreadRead).toHaveBeenCalledTimes(pass),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(bridge.syncDms).not.toHaveBeenCalled();
    }
  });

  it("clears the DM unread pill when the panel's own read lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let unreadCount = 1;
      const markRead = deferred<void>();
      const bridge = Object.assign(
        makeBridge(Promise.resolve(storedStateWithTabs([], null))),
        {
          syncDms: vi.fn(async () =>
            dmSyncResult([{ ...CANONICAL_DM, unreadCount }]),
          ),
          listChatMessages: vi.fn(async () => ({
            messages: [
              {
                id: "dm-message",
                threadId: CANONICAL_DM.threadId!,
                authorKind: "human" as const,
                authorDisplayName: "Alice",
                body: "Read me",
                createdAtMs: 1,
              },
            ],
          })),
          listChatReactions: vi.fn(async () => ({
            reactions: [],
            viewerAuthorId: "you",
          })),
          markChatThreadRead: vi.fn(async () => {
            await markRead.promise;
            unreadCount = 0;
            return { lastReadSequence: 1, revision: 1 };
          }),
        },
      );
      renderShell(bridge);

      expect((await screen.findByTestId("chats-dm-unread")).textContent).toBe(
        "1",
      );
      // The panel is a navigator: the DM opens in the Chats tab, whose page
      // performs the read. The panel's pill follows that read.
      await user.click(screen.getByTestId("chats-dm-item"));
      await screen.findByTestId("chats-dm-view");
      await waitFor(() => expect(bridge.markChatThreadRead).toHaveBeenCalled());
      expect(screen.getByTestId(`tab-dohc://chats/dm/${encodeURIComponent(CANONICAL_DM.channelId)}`)).toBeTruthy();

      await act(async () => {
        markRead.resolve();
        await markRead.promise;
      });
      await waitFor(() =>
        expect(screen.queryByTestId("chats-dm-unread")).toBeNull(),
      );
      // The page sits at the DM, so the one overview root is the panel's.
      expect(screen.getByTestId("chats-view").dataset.variant).toBe("panel");
      expect(screen.getByTestId(`tab-dohc://chats/dm/${encodeURIComponent(CANONICAL_DM.channelId)}`)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
