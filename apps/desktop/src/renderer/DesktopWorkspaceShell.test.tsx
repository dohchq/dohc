// @vitest-environment jsdom
import { ObserverStub } from "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EngineYDocSaveStateEvent, SitePackageInfo } from "../ipc/bridgeContract";
import { type Workspace } from "./DesktopWorkspaceShell";
import { WORKSPACE_ACTIVITY_REFRESH_DELAY_MS } from "./workspaceActivityCoalescer";
import { hasPendingEditorDrafts, settlePendingEditorDrafts } from "./pendingEditorDrafts";
import { loadStoredDrafts } from "./orphanedDraftStorage";
import { deferred } from "../testing/deferred";
import { CollectionFieldWriteHost } from "./collections/recordFieldWrites";
import { DesktopWorkspaceShell, HOME_STATE, WORKSPACE, STORED_STATE, storedStateWithTabs, recordDocUpdate, makeBridge, renderShell, shellBootstrapProps, SHARE_VIEW, OTHER_WORKSPACE } from "./DesktopWorkspaceShell.testHarness";
import { useWorkspaceListing } from "./shell/useWorkspaceListing";
vi.mock("./shell/useWorkspaceListing", { spy: true });

// A new page titled Lisbon with "Day one" typed in its body, as its file
// would hold it.
const LISBON = "---\ntitle: Lisbon\n---\n\nDay one\n";
// What recovery holds for the workspace, as a restart brings it back.
function recovered() {
  return loadStoredDrafts(Date.now(), { bindHandles: false })
    .filter((draft) => draft.workspaceId === WORKSPACE.workspaceId)
    .map(({ path, text }) => ({ path, text }));
}

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

  // The queue behind cell edits must outlive the page: the shell renders only
  // a group's ACTIVE tab, so opening a file unmounts CollectionPage. An edit
  // the cell already accepted must still reach its record's live document.
  it("keeps a queued record edit when a file opens while the first save is pending", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles = vi.fn(async () => ({ visibility: { status: "ready" as const, rules: [] },
      files: [
        { path: "tasks/one.md", kind: "file" as const },
        { path: "tasks/two.md", kind: "file" as const },
        { path: "notes.md", kind: "file" as const },
      ],
      folders: ["tasks"],
    }));
    bridge.listCollections = vi.fn(async () => ({
      collections: [{ path: "tasks", objectId: "object-test", status: "valid" as const, reasons: [] }], unclaimedDatasetFolders: [],
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
        listener({ sessionId, workspaceId: WORKSPACE.workspaceId, path: "tasks/one.md", state: { kind: "saved-here" }, seq: 1 });
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

  // A View share takes no writes, so every create or import would end in a
  // refusal. Neither the palette nor the application menu offers one.
  it("offers no create or import command from a read-only shared view", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    const user = userEvent.setup();
    const view = renderShell(bridge, SHARE_VIEW);

    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByTestId("command-palette");
    // The palette renders and lists something, so the misses below are the
    // gate working, not the palette failing to open.
    await within(palette).findByText("New editor group right");
    for (const label of ["New file", "New file…", "New drawing", "New folder", "New collection", "Import files"]) {
      expect(within(palette).queryByText(label)).toBeNull();
    }
    await user.keyboard("{Escape}");

    for (const command of ["new-file", "new-folder", "new-collection", "import-files"] as const) {
      act(() => bridge.emitMenuCommand(command));
    }
    await act(async () => {});
    expect(screen.queryByTestId("new-page")).toBeNull();
    expect(screen.queryByLabelText("New folder name")).toBeNull();
    expect(bridge.createWorkspaceFile).not.toHaveBeenCalled();
    expect(bridge.importWorkspaceFiles).not.toHaveBeenCalled();
    // The Collection dialog stays hidden without Edit, so a New collection the
    // menu let through would open only once a registry update grants Edit.
    const editShare: Workspace = { ...SHARE_VIEW, shareView: { ...SHARE_VIEW.shareView!, access: "edit" } };
    view.rerender(
      <>
        <CollectionFieldWriteHost />
        <DesktopWorkspaceShell workspace={editShare} workspaces={[editShare]} {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />
      </>,
    );
    await act(async () => {});
    expect(screen.queryByTestId("new-collection-dialog")).toBeNull();
  });

});

describe("content search", () => {
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
});

describe("open editors", () => {
  it("holds a quit for a body typed while its page's file is being created", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const created = deferred<{ path: string }>();
    bridge.createWorkspaceFile.mockImplementationOnce(() => created.promise);
    bridge.readWorkspaceText.mockImplementation(() => deferred<never>().promise);
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findAllByTestId("tree-row");
    await user.click(screen.getByLabelText("New file"));
    await user.keyboard("{Enter}Day one");
    await waitFor(() => expect(bridge.createWorkspaceFile).toHaveBeenCalledTimes(1));
    expect(hasPendingEditorDrafts()).toBe(true);

    const settled = settlePendingEditorDrafts();
    await act(async () => created.resolve({ path: "Untitled.md" }));
    await expect(settled).resolves.toBe(true);
    expect(recovered()).toEqual([{ path: "Untitled.md", text: "Day one\n" }]);
  });

  it("closes a new page whose file is being created, and keeps what was typed", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const created = deferred<{ path: string }>();
    bridge.createWorkspaceFile.mockImplementationOnce(() => created.promise);
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findAllByTestId("tree-row");
    await user.click(screen.getByLabelText("New file"));
    await user.keyboard("Lisbon{Enter}Day one");
    await user.click(screen.getAllByLabelText("Close Lisbon")[0]!);
    await act(async () => created.resolve({ path: "Lisbon.md" }));

    await waitFor(() => expect(screen.queryByRole("tab", { name: /Lisbon/ })).toBeNull());
    expect(screen.queryByTestId("new-page")).toBeNull();
    expect(recovered()).toEqual([{ path: "Lisbon.md", text: LISBON }]);
  });
});

describe("settings entry points", () => {
  it("reports a save that fails after settings closed in the workspace open by then", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const save = deferred<Awaited<ReturnType<typeof bridge.setUserSettings>>>();
    bridge.setUserSettings.mockImplementationOnce(() => save.promise);
    const user = userEvent.setup();
    const view = renderShell(bridge, WORKSPACE, [WORKSPACE, OTHER_WORKSPACE]);

    await user.click(await screen.findByTestId("activity-settings"));
    await user.type(await screen.findByTestId("general-preferred-name-input"), "Sam");
    await user.click(document.querySelector<HTMLElement>('[data-dohc-modal="true"]')!);
    await waitFor(() => expect(screen.queryByTestId("settings-dialog")).toBeNull());
    const change = bridge.setUserSettings.mock.lastCall![0];
    // The root mounts a new shell for the workspace switched to.
    view.rerender(
      <>
        <CollectionFieldWriteHost />
        <DesktopWorkspaceShell key={OTHER_WORKSPACE.workspaceId} workspace={OTHER_WORKSPACE} workspaces={[WORKSPACE, OTHER_WORKSPACE]}
          {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />
      </>,
    );
    await screen.findByTestId("activity-settings");
    await act(async () => save.reject(new Error("The settings file is read-only.")));

    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("The settings file is read-only.");
    bridge.setUserSettings.mockClear();
    await user.click(within(toast).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.setUserSettings).toHaveBeenCalledExactlyOnceWith(change));
  });
});

const SITE: SitePackageInfo = {
  root: "app",
  title: "App",
  kind: "static",
  confidence: "high",
  entryPath: "app/index.html",
  configPath: null,
  packagePath: null,
  packageManager: null,
  scripts: {},
  configuredScripts: {},
  configuredPreviewMode: null,
  configuredBuildOutput: null,
  buildOutputs: [],
  sourceFiles: ["app/index.html"],
  shareManifest: { ok: false, reason: "no-runnable-artifact" },
  diagnostics: [],
  authority: { kind: "workspace" },
};

describe("customize", () => {
  it("keeps a listed app's files out of Home's Pages before its folder is read", async () => {
    const bridge = makeBridge(Promise.resolve(HOME_STATE));
    bridge.listSites.mockResolvedValue({ sites: [{ ...SITE, root: "trip", title: "Trip" }] });
    bridge.listWorkspaceFiles.mockResolvedValue({
      visibility: { status: "ready", rules: [] },
      files: [{ path: "notes.md", kind: "file" }, { path: "trip/README.md", kind: "file" }, { path: "trip/index.html", kind: "file" }],
      folders: ["trip"],
    });
    renderShell(bridge);

    await screen.findByTestId("sites-row");
    const pages = screen.getByTestId("explorer-pages");
    expect(pages.querySelector('[data-path="notes.md"]')).not.toBeNull();
    expect(pages.querySelector('[data-path="trip"]')).toBeNull();
    expect(pages.querySelector('[data-path="trip/README.md"]')).toBeNull();
  });
});

describe("workbench render cost", () => {
  it.each(["policy path", "path-less batch"])("withholds visibility through a %s refresh and rejects a pre-event answer", async mode => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);
    const visibility = () => vi.mocked(useWorkspaceListing).mock.results.at(-1)!.value.visibility.status;
    await waitFor(() => expect(visibility()).toBe("ready"));
    await waitFor(() => expect(bridge.workspaceActivitySubscriberCount()).toBe(2));
    const old = deferred<Awaited<ReturnType<typeof bridge.listWorkspaceFiles>>>();
    const fresh = deferred<Awaited<ReturnType<typeof bridge.listWorkspaceFiles>>>();
    const initial = await bridge.listWorkspaceFiles({ workspaceId: WORKSPACE.workspaceId });
    bridge.listWorkspaceFiles.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    vi.useFakeTimers();
    try {
      act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId, paths: ["notes.md"] }));
      await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS); });
      act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId,
        ...(mode === "policy path" ? { paths: [".dohc/visibility.toml"], pathSetChanged: false } : {}) }));
      expect(visibility()).toBe("unavailable");
      await act(async () => { old.resolve(initial); });
      expect(visibility()).toBe("unavailable");
      await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS); });
      await act(async () => { fresh.resolve(initial); });
      expect(visibility()).toBe("ready");
    } finally { vi.useRealTimers(); }
  });
});

describe("a chat page archive refused for live editing", () => {
  const PAGE = "Bookmarks/Chats/Team-update--thread-team.md";
  const TITLE = `dohc can't archive "${PAGE}" while it has live editing on`;
  const bookmark = {
    bookmarkId: "bookmark-team", targetKind: "thread" as const, targetId: "thread-team", threadId: "thread-team",
    mode: "live" as const, destinationPath: PAGE, state: "active" as const, projectionState: "ready" as const,
    generation: 1, createdAtMs: 1, updatedAtMs: 1,
  };
  function chatsBridge() {
    const bridge = Object.assign(
      makeBridge(Promise.resolve({ ...storedStateWithTabs([], null), activeView: "chats" })),
      {
        listChatChannels: vi.fn(async () => ({
          channels: [{ id: "channel-team", name: "team", slug: "team", kind: "channel" as const,
            createdAtMs: 1, updatedAtMs: 1, threadCount: 1, unreadCount: 0, wireId: "channel-team" }],
          fileThreads: [],
        })),
        listChatChannelShares: vi.fn(async () => ({
          joined: [{ channelWireId: "channel-team", joined: null }],
          sessionKey: "session-a",
          relay: { state: "answered" as const, granted: [], received: [], removed: [] },
        })),
        listChannelThreads: vi.fn(async () => ({
          threads: [{
            id: "thread-team", title: "Team update", createdAtMs: 1, updatedAtMs: 1, channelId: "channel-team",
            messageCount: 1, lastReadSequence: 1, unreadCount: 0,
            openingMessage: { presentation: { group: "fixture", hue: null, self: false }, id: "message-team",
              authorKind: "human" as const, authorDisplayName: "Alice", bodySnippet: "A settled update",
              createdAtMs: 1, reactions: [] },
          }],
          viewerAuthorId: "you",
        })),
        listChatBookmarks: vi.fn(async () => ({ bookmarks: [bookmark] })),
        archiveChatBookmark: vi.fn(async (_input: { workspaceId: string; bookmarkId: string }) =>
          ({ bookmark: { ...bookmark, state: "archived" as const } })),
      },
    );
    bridge.archiveChatBookmark.mockRejectedValueOnce(Object.assign(new Error([TITLE,
      "In Live documents, stop live editing for this page, then archive it again."].join(String.fromCharCode(10))), { name: "LivePageOwnedError" }));
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({ nextCursor: null,
      documents: [{ path: "other.md", objectId: "object-other", status: "ready" as const, canResume: false },
        { path: PAGE, objectId: "object-page", status: "ready" as const, canResume: false }] }));
    return bridge;
  }
  async function refuse(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByTestId("chats-channel"));
    const saved = await screen.findByTestId("chats-post-bookmark");
    await waitFor(() => expect(saved.getAttribute("aria-pressed")).toBe("true"));
    await user.click(saved);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(TITLE)).toBeTruthy();
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
    return { saved, toast };
  }
  async function expectNoRefusal(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(within(await screen.findByTestId("notice-center")).queryByText(TITLE)).toBeNull();
  }

  it("opens Live documents at the page's row, and Try again after closing it archives the page and clears the notice", async () => {
    const user = userEvent.setup();
    const bridge = chatsBridge();
    renderShell(bridge);
    const { toast } = await refuse(user);
    await user.click(within(toast).getByRole("button", { name: "Open Live documents" }));
    const dialog = await screen.findByTestId("live-documents-dialog");
    await within(dialog).findByRole("button", { name: `Stop live editing for ${PAGE}` });
    expect(within(dialog).getByTestId(`live-document-row-${PAGE}`).getAttribute("aria-current")).toBe("true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("live-documents-dialog")).toBeNull());
    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.archiveChatBookmark).toHaveBeenCalledTimes(2));
    await expectNoRefusal(user);
  });
});
