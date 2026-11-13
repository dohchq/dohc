// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { Profiler } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type {
  ListWorkspaceFilesResult,
  SwitchWorkspaceVersionResult,
  EngineYDocSaveStateEvent,
  WorkspaceUiState,
} from "../ipc/bridgeContract";
import type { Workspace } from "./DesktopWorkspaceShell";
import { captureOrphanedDraft } from "./orphanedDrafts";
import {
  CollectionFieldWriteHost,
  collectionWriteFailures,
  collectionWritesPaused,
  discardCollectionFieldWrite,
  enqueueCollectionFieldWrite,
  hasPendingCollectionFieldWrites,
} from "./collections/recordFieldWrites";
import { deferred, type Deferred } from "../testing/deferred";
import {
  LAYOUT_READ_WAIT_LIMIT_MS,
  SAVED_TABS_RESTORE_AFTER_WAIT,
  SAVED_TABS_TITLE,
} from "./shell/useSavedTabsReread";
import {
  DesktopWorkspaceShell,
  GlobalRecoveryList,
  WORKSPACE,
  OTHER_WORKSPACE,
  SYNC_STATUS,
  STORED_STATE,
  storedStateWithTabs,
  storedTabs,
  recordDocUpdate,
  makeBridge,
  renderShell,
  enterMarkdownSource,
  holdHistory,
  sourceEditorText,
  shellBootstrapProps,
} from "./DesktopWorkspaceShell.testHarness";

async function openDirtyMarkdown(bridge: ReturnType<typeof makeBridge>): Promise<{
  user: ReturnType<typeof userEvent.setup>;
  editor: HTMLElement;
}> {
  const user = userEvent.setup();
  renderShell(holdHistory(bridge));
  const row = (await screen.findAllByTestId("tree-row")).find(
    (candidate) => candidate.dataset.path === "a.md",
  )!;
  await user.click(row);
  await screen.findByTestId("view-markdown");
  const editor = await enterMarkdownSource(user);
  await user.click(editor);
  await user.paste("Draft!");
  await waitFor(() => expect(screen.queryAllByTestId("tab-dirty").length).toBeGreaterThan(0));
  return { user, editor };
}

describe("workspace switch admission", () => {
  it("reads after the first open and lifts the preparing surface with the saved layout", async () => {
    const open = deferred<typeof SYNC_STATUS>();
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(stored.promise);
    bridge.openWorkspace = vi.fn(() => open.promise);
    // What each commit put on screen, read after React applied it.
    const commits: Array<{
      preparing: boolean;
      tab: boolean;
      sidebarWidth: string | undefined;
      about: boolean;
    }> = [];
    const recordCommit = () =>
      commits.push({
        preparing: screen.queryByTestId("workspace-preparing") !== null,
        tab: screen.queryByTestId("tab-b.md") !== null,
        sidebarWidth: screen.queryByTestId("side-panel")?.style.width,
        about: screen.queryByTestId("about-rail") !== null,
      });
    vi.stubGlobal("dohcDesktop", bridge);
    render(
      <Profiler id="shell" onRender={recordCommit}>
        <DesktopWorkspaceShell
          workspace={WORKSPACE}
          workspaces={[WORKSPACE]}
          {...shellBootstrapProps(bridge)}
          onSwitchWorkspace={() => {}}
        />
      </Profiler>,
    );
    await waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledOnce());
    await act(async () => {});

    expect(screen.getByTestId("workspace-preparing")).toBeTruthy();
    expectNoUiStateTraffic(bridge);

    await act(async () => open.resolve(SYNC_STATUS));
    await waitFor(() =>
      expect(bridge.getWorkspaceUiState).toHaveBeenCalledExactlyOnceWith({
        workspaceId: WORKSPACE.workspaceId,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    expect(screen.getByTestId("workspace-preparing")).toBeTruthy();
    expect(screen.getByTestId("workspace-workbench").hasAttribute("inert")).toBe(true);
    window.dispatchEvent(new Event("beforeunload"));
    expect(bridge.setWorkspaceUiState).not.toHaveBeenCalled();

    await act(async () => {
      stored.resolve(STORED_STATE);
      await stored.promise;
    });
    await waitFor(() => expect(screen.queryByTestId("workspace-preparing")).toBeNull());
    // The first commit without the surface already shows the saved tab,
    // sidebar width and About rail; no commit showed the defaults.
    expect(commits.find((commit) => !commit.preparing)).toEqual({
      preparing: false,
      tab: true,
      sidebarWidth: "320px",
      about: true,
    });
    expect(screen.getByTestId("workspace-workbench").hasAttribute("inert")).toBe(false);
  });

  describe("saved tabs after a failed read", () => {
    const refused = () => new Error("dohc has not finished opening this workspace.");
    const notices = () => screen.getByTestId("notice-center-toggle").getAttribute("aria-label");
    // With no saved layout read, the Explorer opens on Home, as a new workspace does.
    const showFiles = async (user: ReturnType<typeof userEvent.setup>) => {
      const files = await screen.findByTestId("explorer-mode-files");
      if (files.getAttribute("aria-selected") !== "true") await user.click(files);
    };
    const openFile = async (user: ReturnType<typeof userEvent.setup>, path: string) => {
      await showFiles(user);
      await user.click(
        (await screen.findAllByTestId("tree-row")).find((row) => row.dataset.path === path)!,
      );
      await screen.findByTestId(`tab-${path}`);
    };
    // The clock passes the open's limit while the first read waits.
    const waitOutTheOpen = (bridge: ReturnType<typeof makeBridge>) => {
      const now = Date.now.bind(Date);
      bridge.getWorkspaceUiState.mockImplementationOnce(() => {
        vi.spyOn(Date, "now").mockImplementation(() => now() + LAYOUT_READ_WAIT_LIMIT_MS);
        return Promise.reject(refused());
      });
    };

    it("stops waiting for them once a read fails because the window stopped using the workspace", async () => {
      const bridge = makeBridge(Promise.resolve(STORED_STATE));
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        bridge.getWorkspaceUiState
          .mockRejectedValueOnce(refused())
          .mockRejectedValueOnce(
            new Error(
              "Error invoking remote method 'desktop:get-workspace-ui-state': Error [stopped=read]: This workspace is no longer open in this window.",
            ),
          );
        renderShell(bridge);
        await waitFor(() => expect(bridge.getWorkspaceUiState).toHaveBeenCalledTimes(2));
        await act(() => vi.advanceTimersByTimeAsync(LAYOUT_READ_WAIT_LIMIT_MS + 1_000));
        act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId }));

        expect(bridge.getWorkspaceUiState).toHaveBeenCalledTimes(2);
        expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
        expect(notices()).toBe("Notices");
      } finally {
        vi.useRealTimers();
      }
    });

    it("offers Restore tabs once a tab is open, unread again without a toast, and keeps that tab", async () => {
      const second = deferred<WorkspaceUiState | null>();
      const bridge = makeBridge(second.promise);
      waitOutTheOpen(bridge);
      const user = userEvent.setup();
      try {
        renderShell(bridge);
        const toast = await screen.findByTestId("workspace-shell-notice");
        await user.click(within(toast).getByRole("button", { name: "Dismiss workspace notice" }));
        await openFile(user, "a.md");
        await user.click(screen.getByTestId("notice-center-toggle"));
        await user.click(
          within(await screen.findByTestId("notice-center")).getByRole("button", {
            name: "Mark all read",
          }),
        );
        expect(notices()).toBe("Notices");

        await act(async () => {
          second.resolve(STORED_STATE);
          await second.promise;
        });

        const row = (
          await within(screen.getByTestId("notice-center")).findByText(
            SAVED_TABS_RESTORE_AFTER_WAIT,
          )
        ).closest("li")!;
        expect(notices(), "the row offers Restore tabs, so it is unread again").toBe(
          "Notices, 1 unread",
        );
        expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
        expect(screen.queryByTestId("tab-b.md")).toBeNull();
        window.dispatchEvent(new Event("beforeunload"));
        expect(bridge.setWorkspaceUiState, "saving waits for Restore tabs").not.toHaveBeenCalled();
        await user.click(within(row).getByRole("button", { name: "Details" }));
        await user.click(within(row).getByRole("button", { name: "Copy details" }));
        expect(
          (await navigator.clipboard.readText()).split("\n")[0],
          "the action first, so the toast's limit cuts only the reason",
        ).toBe(
          "Notice: Restore tabs brings them back. Until you pick it, tab changes aren't saved. Your saved tabs didn't load within 4 minutes.",
        );

        await user.click(within(row).getByRole("button", { name: "Restore tabs" }));

        expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
        expect(screen.getByTestId("tab-a.md").dataset.active).toBe("true");
        expect(screen.queryByText(SAVED_TABS_TITLE)).toBeNull();
        await waitFor(() =>
          expect(storedTabs(bridge.setWorkspaceUiState.mock.lastCall![0].state)).toEqual([
            "b.md",
            "a.md",
          ]),
        );
      } finally {
        vi.mocked(Date.now).mockRestore();
      }
    });
  });

  it("reads nothing and saves no defaults until a failed open succeeds", async () => {
    const user = userEvent.setup();
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = makeBridge(stored.promise);
    bridge.openWorkspace.mockRejectedValueOnce(new Error("engine refused"));
    renderShell(bridge);
    const failed = await screen.findByTestId("workspace-open-failed");
    await act(async () => {});
    expectNoUiStateTraffic(bridge);

    await user.click(within(failed).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(bridge.getWorkspaceUiState).toHaveBeenCalledExactlyOnceWith({
        workspaceId: WORKSPACE.workspaceId,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    expect(screen.getByTestId("workspace-preparing")).toBeTruthy();

    await act(async () => {
      stored.resolve(STORED_STATE);
      await stored.promise;
    });
    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    expect(screen.queryByTestId("workspace-preparing")).toBeNull();
    expect(bridge.openWorkspace).toHaveBeenCalledTimes(2);
  });

  describe("after the selection moves on", () => {
    // One mounted shell changes workspace, so only the admission gate can stop
    // an obsolete read. Each open waits for the test; GET answers with a tab
    // named for its workspace.
    function heldOpens() {
      const opens: Array<{ workspaceId: string; status: Deferred<typeof SYNC_STATUS> }> = [];
      const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
        openWorkspace: vi.fn((payload: { workspaceId: string }) => {
          const status = deferred<typeof SYNC_STATUS>();
          opens.push({ workspaceId: payload.workspaceId, status });
          return status.promise;
        }),
        getWorkspaceUiState: vi.fn(async (payload: { workspaceId: string }) =>
          storedStateWithTabs([payload.workspaceId === WORKSPACE.workspaceId ? "a.md" : "b.md"]),
        ),
      });
      const shell = (workspace: Workspace) => (
        <DesktopWorkspaceShell
          workspace={workspace}
          workspaces={[WORKSPACE, OTHER_WORKSPACE]}
          {...shellBootstrapProps(bridge)}
          onSwitchWorkspace={() => {}}
        />
      );
      const release = async (index: number) => {
        await act(async () => opens[index]!.status.resolve(SYNC_STATUS));
      };
      vi.stubGlobal("dohcDesktop", bridge);
      return { bridge, opens, shell, release };
    }

    it("keeps B preparing when A's read answers late", async () => {
      const { bridge, opens, shell, release } = heldOpens();
      const reads: Array<Deferred<WorkspaceUiState>> = [];
      bridge.getWorkspaceUiState.mockImplementation(() => {
        const read = deferred<WorkspaceUiState>();
        reads.push(read);
        return read.promise;
      });
      const view = render(shell(WORKSPACE));
      await waitFor(() => expect(opens).toHaveLength(1));
      await release(0);
      await waitFor(() => expect(reads).toHaveLength(1));
      view.rerender(shell(OTHER_WORKSPACE));
      await waitFor(() => expect(opens).toHaveLength(2));
      await release(1);
      await waitFor(() => expect(reads).toHaveLength(2));
      expect(bridge.getWorkspaceUiState).toHaveBeenNthCalledWith(1, {
        workspaceId: WORKSPACE.workspaceId,
      });
      expect(bridge.getWorkspaceUiState).toHaveBeenNthCalledWith(2, {
        workspaceId: OTHER_WORKSPACE.workspaceId,
      });
      await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));

      const [late, current] = reads as [Deferred<WorkspaceUiState>, Deferred<WorkspaceUiState>];
      await act(async () => {
        late.resolve(storedStateWithTabs(["a.md"]));
        await late.promise;
      });
      expect(screen.getByTestId("workspace-preparing")).toBeTruthy();
      expect(screen.queryByTestId("tab-a.md")).toBeNull();

      await act(async () => {
        current.resolve(storedStateWithTabs(["b.md"]));
        await current.promise;
      });
      expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
      expect(screen.queryByTestId("workspace-preparing")).toBeNull();
    });

    it("does not reuse A's first open after A -> B -> A", async () => {
      const { bridge, opens, shell, release } = heldOpens();
      const view = render(shell(WORKSPACE));
      await waitFor(() => expect(opens).toHaveLength(1));
      view.rerender(shell(OTHER_WORKSPACE));
      await waitFor(() => expect(opens).toHaveLength(2));
      view.rerender(shell(WORKSPACE));
      await waitFor(() => expect(opens).toHaveLength(3));
      expect(opens.map((open) => open.workspaceId)).toEqual([
        WORKSPACE.workspaceId,
        OTHER_WORKSPACE.workspaceId,
        WORKSPACE.workspaceId,
      ]);

      await release(0);
      await release(1);
      expect(screen.getByTestId("workspace-preparing")).toBeTruthy();
      expectNoUiStateTraffic(bridge);

      await release(2);
      expect(await screen.findByTestId("tab-a.md")).toBeTruthy();
      expect(bridge.getWorkspaceUiState).toHaveBeenCalledExactlyOnceWith({
        workspaceId: WORKSPACE.workspaceId,
      });
    });
  });
});

// Neither a UI-state read nor a save of the default layout has happened, even
// when the window unloads now.
function expectNoUiStateTraffic(bridge: ReturnType<typeof makeBridge>) {
  window.dispatchEvent(new Event("beforeunload"));
  expect(bridge.getWorkspaceUiState).not.toHaveBeenCalled();
  expect(bridge.setWorkspaceUiState).not.toHaveBeenCalled();
}

describe("collection input during a version switch", () => {
  it.each(["success", "failure"] as const)(
    "retains late input after switch %s without crossing versions",
    async (outcome) => {
      const user = userEvent.setup();
      const bridge = makeBridge(Promise.resolve(null));
      let activeVersionId = "main";
      bridge.listWorkspaceVersions = vi.fn(async () => ({
        versions: [
          {
            id: "main",
            name: "Main",
            kind: "main" as const,
            createdAtMs: 0,
            canMergeIntoMain: false,
          },
          {
            id: "v2",
            name: "Draft two",
            kind: "named" as const,
            createdAtMs: 1,
            canMergeIntoMain: true,
          },
        ],
        activeVersionId,
      }));
      const switching = deferred<SwitchWorkspaceVersionResult>();
      bridge.switchWorkspaceVersion = vi.fn(() => switching.promise);
      renderShell(bridge);
      await user.click(await screen.findByTestId("version-menu-button"));
      const target = (await screen.findAllByTestId("version-item")).find(
        (item) => item.dataset.versionId === "v2",
      );
      await user.click(target!);
      await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalledOnce());
      const change = {
        recordId: "rec-1",
        recordPath: "tasks/one.md",
        field: "status",
        value: "done",
      };
      act(() => {
        expect(enqueueCollectionFieldWrite(WORKSPACE.workspaceId, "tasks", change)).toBe(false);
      });
      await act(async () => {
        if (outcome === "success") {
          activeVersionId = "v2";
          switching.resolve({ activeVersionId, changedFileCount: 1 });
        } else {
          switching.reject(new Error("switch failed"));
        }
        await switching.promise.catch(() => undefined);
      });
      await waitFor(() => {
        expect(screen.getByTestId("collection-write-retry")).toHaveProperty(
          "disabled",
          outcome === "success",
        );
        if (outcome === "success") expect(screen.getByTestId("collection-write-copy")).toBeTruthy();
      });
      expect(collectionWriteFailures()[0]?.change).toEqual(change);
    },
  );
});

describe("workspace admission over collection writes", () => {
  // Models main's authority the way engineYDocSessionIpc holds it: a record
  // session opens only for the workspace `openWorkspace` last admitted. If
  // the shell admits B while A's accepted write is still queued, the write's
  // open lands after the revocation and fails — exactly the data loss the
  // admission gate exists to prevent.
  function admissionHarness() {
    const admitted = { workspaceId: WORKSPACE.workspaceId };
    const openGates = new Map<string, Promise<void>>();
    const sessions = new Map<string, string>();
    const saveListeners = new Set<(event: EngineYDocSaveStateEvent) => void>();
    const openAvailability = { available: true };
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      openWorkspace: vi.fn(async (payload: { workspaceId: string }) => {
        admitted.workspaceId = payload.workspaceId;
        return SYNC_STATUS;
      }),
      openEngineYDocSession: vi.fn(
        async (payload: { workspaceId: string; path: string; sessionId: string }) => {
          await openGates.get(payload.path);
          if (!openAvailability.available || payload.workspaceId !== admitted.workspaceId) {
            return { available: false };
          }
          sessions.set(payload.path, payload.sessionId);
          return {
            available: true,
            initialUpdate: recordDocUpdate(RECORD_EDIT.recordId),
            lineageGeneration: 1,
          };
        },
      ),
      applyEngineYDocUpdate: vi.fn(async () => ({ accepted: true as const })),
      closeEngineYDocSession: vi.fn(async () => undefined),
      onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
      onEngineYDocOwnerHandoff: () => () => undefined,
      prepareEngineYDocOwnerHandoff: async () => undefined,
      onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
      onEngineYDocSaveState: vi.fn((listener: (event: EngineYDocSaveStateEvent) => void) => {
        saveListeners.add(listener);
        return () => saveListeners.delete(listener);
      }),
    });
    const shell = (workspace: Workspace) => (
      <>
        <CollectionFieldWriteHost />
        <DesktopWorkspaceShell
          key={workspace.workspaceId}
          workspace={workspace}
          workspaces={[WORKSPACE, OTHER_WORKSPACE]}
          {...shellBootstrapProps(bridge)}
          onSwitchWorkspace={() => {}}
        />
      </>
    );
    vi.stubGlobal("dohcDesktop", bridge);
    return { bridge, openGates, sessions, saveListeners, openAvailability, shell };
  }

  const RECORD_EDIT = {
    recordId: "rec-1",
    recordPath: "tasks/one.md",
    field: "done",
    value: true,
  };

  it("keeps the destination workspace's queued edit when the previous workspace times out", async () => {
    const harness = admissionHarness();
    const oldOpen = deferred<void>();
    const nextOpen = deferred<void>();
    harness.openGates.set("tasks/one.md", oldOpen.promise);
    harness.openGates.set("tasks/two.md", nextOpen.promise);
    const view = render(harness.shell(WORKSPACE));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    act(() => {
      enqueueCollectionFieldWrite(WORKSPACE.workspaceId, "tasks", RECORD_EDIT);
      enqueueCollectionFieldWrite(OTHER_WORKSPACE.workspaceId, "tasks", {
        ...RECORD_EDIT,
        recordPath: "tasks/two.md",
      });
    });
    await waitFor(() => expect(harness.bridge.openEngineYDocSession).toHaveBeenCalled());
    harness.bridge.openWorkspace.mockClear();
    vi.useFakeTimers();
    try {
      view.rerender(harness.shell(OTHER_WORKSPACE));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(collectionWriteFailures().map((failure) => failure.workspaceId)).toEqual([
        WORKSPACE.workspaceId,
      ]);
      expect(hasPendingCollectionFieldWrites()).toBe(true);
      expect(harness.bridge.openWorkspace).not.toHaveBeenCalled();
      act(() => discardCollectionFieldWrite(collectionWriteFailures()[0]!.id));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() =>
      expect(harness.bridge.openWorkspace).toHaveBeenCalledWith({
        workspaceId: OTHER_WORKSPACE.workspaceId,
      }),
    );
    await act(async () => {
      oldOpen.resolve();
      nextOpen.resolve();
    });
    await waitFor(() => expect(harness.bridge.applyEngineYDocUpdate).toHaveBeenCalled());
    act(() => {
      const sessionId = harness.sessions.get("tasks/two.md")!;
      for (const listener of [...harness.saveListeners])
        listener({
          sessionId,
          workspaceId: "ws-1",
          path: "notes/a.md",
          state: { kind: "saved-here" },
          seq: 1,
        });
    });
    await waitFor(() => expect(hasPendingCollectionFieldWrites()).toBe(false));
    expect(collectionWriteFailures()).toHaveLength(0);
  });

  it("keeps an applied-only stalled save visible until its engine acknowledgement admits B", async () => {
    const harness = admissionHarness();
    const view = render(harness.shell(WORKSPACE));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    act(() => {
      enqueueCollectionFieldWrite(WORKSPACE.workspaceId, "tasks", RECORD_EDIT);
    });
    await waitFor(() => expect(harness.bridge.applyEngineYDocUpdate).toHaveBeenCalled());
    harness.bridge.openWorkspace.mockClear();

    vi.useFakeTimers();
    try {
      view.rerender(harness.shell(OTHER_WORKSPACE));
      await act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(collectionWriteFailures()).toEqual([]);
      const blocked = screen.getByTestId("workspace-open-failed");
      expect(blocked.textContent).toContain(
        "dohc has not confirmed this save yet. Keep dohc open until saving finishes.",
      );
      expect(screen.queryByTestId("collection-write-retry")).toBeNull();
      expect(screen.queryByTestId("collection-write-discard")).toBeNull();
      expect(screen.queryByTestId("workspace-preparing")).toBeNull();

      await act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(screen.getByTestId("workspace-open-failed")).toBe(blocked);
      expect(screen.queryByTestId("workspace-preparing")).toBeNull();
      expect(harness.bridge.openWorkspace).not.toHaveBeenCalled();

      await act(async () => {
        const sessionId = harness.sessions.get("tasks/one.md")!;
        for (const listener of [...harness.saveListeners]) {
          listener({
            sessionId,
            workspaceId: "ws-1",
            path: "notes/a.md",
            state: { kind: "saved-here" },
            seq: 1,
          });
        }
      });
      expect(harness.bridge.openWorkspace).toHaveBeenCalledExactlyOnceWith({
        workspaceId: OTHER_WORKSPACE.workspaceId,
      });
      expect(screen.queryByTestId("workspace-open-failed")).toBeNull();
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks admission when A's write fails during the wait", async () => {
    const harness = admissionHarness();
    const gate = deferred<void>();
    harness.openGates.set("tasks/one.md", gate.promise);
    const view = render(harness.shell(WORKSPACE));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    act(() => {
      enqueueCollectionFieldWrite(WORKSPACE.workspaceId, "tasks", RECORD_EDIT);
    });
    await waitFor(() => expect(harness.bridge.openEngineYDocSession).toHaveBeenCalled());
    harness.bridge.openWorkspace.mockClear();

    view.rerender(harness.shell(OTHER_WORKSPACE));
    await act(async () => {});
    expect(harness.bridge.openWorkspace).not.toHaveBeenCalled();

    // The write's session open settles without a session: the write is
    // retained, and admission must stop on it instead of proceeding.
    harness.openAvailability.available = false;
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(collectionWriteFailures()).toHaveLength(1));
    await screen.findByTestId("workspace-open-failed");
    expect(harness.bridge.openWorkspace).not.toHaveBeenCalled();

    act(() => {
      discardCollectionFieldWrite(collectionWriteFailures()[0]!.id);
    });
    await waitFor(() =>
      expect(harness.bridge.openWorkspace).toHaveBeenCalledWith({
        workspaceId: OTHER_WORKSPACE.workspaceId,
      }),
    );
  });
});

describe("explorer operations over collection writes", () => {
  const RECORD_EDIT = {
    recordId: "rec-a",
    recordPath: "a.md",
    field: "done",
    value: true,
  };

  async function beginRename(bridge: ReturnType<typeof makeBridge>) {
    const user = userEvent.setup();
    renderShell(bridge);
    const row = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "a.md",
    )!;
    await user.click(row);
    await user.keyboard("{F2}");
    const input = await screen.findByTestId("tree-edit-input");
    await user.clear(input);
    await user.type(input, "renamed.md{Enter}");
    return user;
  }

  it("pauses cell edits across a rename and projects the retained edit", async () => {
    const move = deferred<void>();
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi.fn(() => move.promise),
    });
    await beginRename(bridge);
    await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(1));
    // The pause covers the pending IPC: a racing cell edit (an editor commit
    // already in flight) is refused and retained, never queued against the
    // path the move is changing.
    expect(collectionWritesPaused(WORKSPACE.workspaceId)).toBe(true);
    let accepted = true;
    act(() => {
      accepted = enqueueCollectionFieldWrite(WORKSPACE.workspaceId, "tasks", RECORD_EDIT);
    });
    expect(accepted).toBe(false);
    expect(collectionWriteFailures()).toHaveLength(1);

    await act(async () => {
      move.resolve();
      await move.promise;
    });
    await waitFor(() => expect(collectionWritesPaused(WORKSPACE.workspaceId)).toBe(false));
    // The retained edit follows the rename, like tabs and set-aside drafts.
    expect(collectionWriteFailures()[0]!.change.recordPath).toBe("renamed.md");
  });
});

describe("workspace switch-back file listing", () => {
  it("does not prune a restored tab from the cached paint alone", async () => {
    const revalidation = deferred<ListWorkspaceFilesResult>();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["survivor.md", "gone.md"], "survivor.md")),
    );
    bridge.listWorkspaceFiles = vi
      .fn()
      .mockResolvedValueOnce({
        visibility: { status: "ready" as const, rules: [] },
        files: [{ path: "survivor.md", kind: "file" as const }],
        folders: [],
        cached: true,
      })
      .mockImplementationOnce(() => revalidation.promise);
    renderShell(bridge);

    expect((await screen.findAllByText("survivor.md")).length).toBeGreaterThan(0);
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("tab-gone.md")).toBeTruthy();

    await act(async () => {
      revalidation.resolve({
        visibility: { status: "ready" as const, rules: [] },
        files: [{ path: "survivor.md", kind: "file" }],
        folders: [],
      });
      await revalidation.promise;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("tab-gone.md")).toBeNull();
    });
    expect(screen.getByTestId("tab-survivor.md")).toBeTruthy();
  });
});

describe("dirty tab close boundaries", () => {
  it("keeps the active tab mounted when its flush fails", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.writeWorkspaceText = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { user, editor } = await openDirtyMarkdown(bridge);

    await user.click(
      within(screen.getByTestId("tab-a.md")).getByRole("button", {
        name: "Close a.md",
      }),
    );

    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(editor.isConnected).toBe(true);
    expect(editor.textContent).toContain("Draft!");
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain("disk full");
  });

  it("does not close a tab reopened while close-all waits", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md")));
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    const { user } = await openDirtyMarkdown(bridge);

    await user.click(screen.getByRole("button", { name: "Close all editors" }));
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());

    // Remove the original b.md tab, then open the same path as a new tab while
    // close-all still waits for a.md. The later tab is not part of that click.
    fireEvent.click(
      within(screen.getByTestId("tab-b.md")).getByRole("button", {
        name: "Close b.md",
      }),
    );
    expect(screen.queryByTestId("tab-b.md")).toBeNull();
    const bRow = screen.getAllByTestId("tree-row").find((row) => row.dataset.path === "b.md")!;
    await user.click(bRow);
    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });
    await waitFor(() => expect(screen.queryByTestId("tab-a.md")).toBeNull());
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");
  });

  it("flushes an editor again when it changes while another close-all save waits", async () => {
    const heldSave = deferred<{ status: "written"; contentHash: string }>();
    let firstPath: string | null = null;
    let heldPath: string | null = null;
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
    holdHistory(bridge);
    bridge.writeWorkspaceText = vi.fn(async (payload: { relativePath: string }) => {
      if (firstPath === null) {
        firstPath = payload.relativePath;
        return { status: "written" as const, contentHash: "b".repeat(64) };
      }
      if (payload.relativePath !== firstPath && heldPath === null) {
        heldPath = payload.relativePath;
        return heldSave.promise;
      }
      if (payload.relativePath === firstPath) throw new Error("disk full");
      return { status: "written" as const, contentHash: "c".repeat(64) };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findByTestId("tab-b.md");
    await waitFor(() => expect(screen.getAllByTestId("view-markdown")).toHaveLength(2));
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const right = screen.getByRole("region", { name: "Editor group 2" });
    // On a slow machine the 800 ms autosave can save a draft before close-all
    // starts or retry one while it waits. The test does not count those writes.
    await user.type(await enterMarkdownSource(user, left), "Left draft");
    await user.type(await enterMarkdownSource(user, right), "Right draft");

    await user.click(screen.getByRole("button", { name: "Close all editors" }));
    await waitFor(() => expect(heldPath).not.toBeNull());
    await waitFor(() => expect(screen.getAllByTestId("tab-dirty")).toHaveLength(1));

    const firstEditor =
      firstPath === "a.md"
        ? within(left).getByTestId("markdown-editor").querySelector<HTMLElement>(".cm-content")!
        : within(right).getByTestId("markdown-editor").querySelector<HTMLElement>(".cm-content")!;
    await user.type(firstEditor, " changed again");
    await waitFor(() => expect(screen.getAllByTestId("tab-dirty")).toHaveLength(2));

    const writesBeforeRelease = bridge.writeWorkspaceText.mock.calls.length;
    await act(async () => {
      heldSave.resolve({ status: "written", contentHash: "d".repeat(64) });
      await heldSave.promise;
    });
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain("disk full");
    expect(
      bridge.writeWorkspaceText.mock.calls.slice(writesBeforeRelease).at(-1)?.[0],
    ).toMatchObject({ relativePath: firstPath, text: expect.stringContaining(" changed again") });
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
    expect(firstEditor.isConnected).toBe(true);
  });
});

describe("explorer destructive change flush boundaries", () => {
  it("does not delete a file when the active draft flush fails", async () => {
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      deleteWorkspacePath: vi.fn(async () => undefined),
    });
    bridge.writeWorkspaceText = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { user, editor } = await openDirtyMarkdown(bridge);
    const row = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "a.md",
    )!;

    await user.click(row);
    await user.keyboard("{Delete}");

    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    expect(bridge.deleteWorkspacePath).not.toHaveBeenCalled();
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain("disk full");
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(editor.isConnected).toBe(true);
  });

  it("settles every editor registered during a held rename", async () => {
    const move = deferred<void>();
    const lateA = deferred<{
      status: "conflict";
      currentContentHash: null;
    }>();
    const lateB = deferred<{
      status: "written";
      contentHash: string;
    }>();
    let writes = 0;
    const bridge = Object.assign(
      makeBridge(Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md"))),
      { moveWorkspacePath: vi.fn(() => move.promise) },
    );
    bridge.writeWorkspaceText = vi.fn(() => {
      writes += 1;
      if (writes === 1) {
        return Promise.resolve({
          status: "written" as const,
          contentHash: "b".repeat(64),
        });
      }
      return writes === 2 ? lateA.promise : lateB.promise;
    });
    const { user, editor: editorA } = await openDirtyMarkdown(bridge);
    const row = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "a.md",
    )!;

    await user.click(row);
    await user.keyboard("{F2}");
    const input = await screen.findByTestId("tree-edit-input");
    await user.clear(input);
    await user.type(input, "renamed.md{Enter}");
    await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(1));

    await user.click(editorA);
    await user.type(editorA, " Late A");
    const lateADraft = sourceEditorText(editorA);
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(2));

    await user.click(screen.getByTestId("tab-b.md"));
    const editorB = await enterMarkdownSource(user);
    await user.type(editorB, "Late B");
    const lateBDraft = sourceEditorText(editorB);
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(3));

    await act(async () => {
      move.resolve(undefined);
      await move.promise;
      lateB.resolve({ status: "written", contentHash: "c".repeat(64) });
      await lateB.promise;
    });
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(screen.queryByTestId("tab-renamed.md")).toBeNull();

    await act(async () => {
      lateA.resolve({ status: "conflict", currentContentHash: null });
      await lateA.promise;
    });
    await screen.findByTestId("tab-renamed.md");
    await user.click(screen.getByTestId("tab-renamed.md"));
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(lateADraft));
    expect(bridge.writeWorkspaceText.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ relativePath: "b.md", text: lateBDraft }),
    );
  });

  it("settles every editor registered during a held delete", async () => {
    const deletion = deferred<void>();
    const lateA = deferred<{
      status: "conflict";
      currentContentHash: null;
    }>();
    const lateB = deferred<{
      status: "written";
      contentHash: string;
    }>();
    let writes = 0;
    const bridge = Object.assign(
      makeBridge(Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md"))),
      { deleteWorkspacePath: vi.fn(() => deletion.promise) },
    );
    bridge.writeWorkspaceText = vi.fn(() => {
      writes += 1;
      if (writes === 1) {
        return Promise.resolve({
          status: "written" as const,
          contentHash: "b".repeat(64),
        });
      }
      return writes === 2 ? lateA.promise : lateB.promise;
    });
    const { user, editor: editorA } = await openDirtyMarkdown(bridge);
    const row = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "a.md",
    )!;

    await user.click(row);
    await user.keyboard("{Delete}");
    await waitFor(() => expect(bridge.deleteWorkspacePath).toHaveBeenCalledTimes(1));

    await user.click(editorA);
    await user.type(editorA, " Late A");
    const lateADraft = sourceEditorText(editorA);
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(2));

    await user.click(screen.getByTestId("tab-b.md"));
    const editorB = await enterMarkdownSource(user);
    await user.type(editorB, "Late B");
    const lateBDraft = sourceEditorText(editorB);
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(3));

    await act(async () => {
      deletion.resolve(undefined);
      await deletion.promise;
      lateB.resolve({ status: "written", contentHash: "c".repeat(64) });
      await lateB.promise;
    });
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();

    await act(async () => {
      lateA.resolve({ status: "conflict", currentContentHash: null });
      await lateA.promise;
    });
    await waitFor(() => expect(screen.queryByTestId("tab-a.md")).toBeNull());
    const recovery = render(<GlobalRecoveryList />);
    const rows = await within(recovery.container).findAllByTestId("recovery-list-row");
    const rowA = rows.find((candidate) => candidate.textContent?.includes("a.md"))!;
    await user.click(within(rowA).getByTestId("recovery-list-copy"));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(lateADraft));
    expect(bridge.writeWorkspaceText.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ relativePath: "b.md", text: lateBDraft }),
    );
  });
});

// #567 / #579 review: set-aside draft recovery at the shell seams. The drafts
// live in a module store keyed by workspace + path; the shell owns the two
// integrations under test — path remapping on explorer renames, and the
// distinction between recovery (dot, no save promise) and savable-dirty
// (dot and the version-switch save-first prompt).
describe("set-aside draft recovery", () => {
  it.each(["EBUSY"])(
    "reports a %s draft read failure in Notices and retries discovery",
    async (code) => {
      const user = userEvent.setup();
      const bridge = makeBridge(Promise.resolve(null));
      const record = {
        recordId: "a".repeat(64),
        path: "deleted/gone.md",
        objectId: "object",
        text: "Unseen typing",
        updateBase64: "AAA=",
      };
      bridge.listLiveDraftRecovery
        .mockRejectedValueOnce(Object.assign(new Error("temporary read failure"), { code }))
        .mockResolvedValue([record]);
      renderShell(bridge);
      const toast = await screen.findByTestId("workspace-shell-error");
      expect(toast.textContent).toContain("dohc could not read set-aside edits.");
      await user.click(await screen.findByTestId("notice-center-toggle"));
      const notices = screen.getByTestId("notice-center");
      expect(notices.textContent).toContain("dohc could not read set-aside edits.");
      await user.click(within(notices).getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(bridge.listLiveDraftRecovery).toHaveBeenCalledTimes(2));
      await user.click(screen.getByTestId("notice-center-toggle"));
      await screen.findByTestId("notice-set-aside-edits");
      expect(bridge.listLiveDraftRecovery).toHaveBeenCalledTimes(2);
      await user.click(screen.getByTestId("recovery-list-copy"));
      await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(record.text));
    },
  );

  it("shows main drafts on open and exposes each survivor through Notices Copy and Dismiss", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("crypto", webcrypto);
    const bridge = makeBridge(Promise.resolve(null));
    const first = {
      recordId: "a".repeat(64),
      path: "deleted/gone.md",
      objectId: "object",
      text: "First main copy",
      updateBase64: "AAA=",
    };
    const second = {
      ...first,
      recordId: "b".repeat(64),
      text: "Unseen main copy",
      updateBase64: "AAE=",
    };
    bridge.listLiveDraftRecovery.mockResolvedValue([first]);
    bridge.discardLiveDraftRecovery.mockResolvedValueOnce([second]).mockResolvedValueOnce([]);
    renderShell(bridge);
    await screen.findByTestId("file-tree");
    await user.click(await screen.findByTestId("notice-center-toggle"));
    await screen.findByTestId("notice-set-aside-edits");
    await user.click(screen.getByTestId("recovery-list-copy"));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(first.text));
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() => expect(bridge.discardLiveDraftRecovery).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getAllByTestId("recovery-list-row")).toHaveLength(1));
    await user.click(screen.getByTestId("recovery-list-copy"));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(second.text));
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() => expect(screen.queryByTestId("notice-set-aside-edits")).toBeNull());
    expect(bridge.listLiveDraftRecovery).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE.workspaceId,
    });
    expect(bridge.discardLiveDraftRecovery.mock.calls.map(([input]) => input.recordId)).toEqual([
      first.recordId,
      second.recordId,
    ]);
  });

  // Most tests capture a draft before the shell mounts, and the draft store
  // reads the platform from the bridge. `renderShell` replaces this stub.
  beforeEach(() => {
    vi.stubGlobal("dohcDesktop", { platform: "linux" });
  });

  it("marks the tab with recovery but lets a version switch proceed without a save promise", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(["a.md"], "a.md")));
    bridge.listWorkspaceVersions = vi.fn(async () => ({
      versions: [
        {
          id: "main",
          name: "Main",
          kind: "main" as const,
          createdAtMs: 0,
          canMergeIntoMain: false,
        },
        {
          id: "v2",
          name: "Draft two",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: "main",
    }));
    captureOrphanedDraft(WORKSPACE.workspaceId, "a.md", "Kept!");
    renderShell(bridge);

    // The recovery marks the tab: an unsaved edit exists, and hiding that
    // would be the engine-Saved lie one level up.
    await screen.findByTestId("view-markdown");
    await screen.findByTestId("tab-dirty");

    // But it is not savable-dirty: switching versions must not prompt
    // "dohc will save them" about a draft the flush cannot write — the store
    // outlives the switch, so the switch just proceeds.
    await user.click(await screen.findByTestId("version-menu-button"));
    const item = (await screen.findAllByTestId("version-item")).find(
      (candidate) => candidate.dataset.versionId === "v2",
    );
    await user.click(item!);
    await waitFor(() =>
      expect(
        bridge.switchWorkspaceVersion,
        "lift: lift the recovery-derived state from MarkdownView's onSaveStateChange (the round-1 behavior). The save-first dialog then appears and the switch below never runs.",
      ).toHaveBeenCalled(),
    );
    expect(screen.queryByTestId("version-switch-save-confirm")).toBeNull();
    // The notice survives the switch — recovery needed no save.
    expect(screen.getByTestId("orphaned-draft-notice")).toBeTruthy();
  });

  // A deleted file's tab is gone, so no inspector will ever
  // render its notice again — the notice center is the path-independent
  // surface where the draft stays reachable, Copy/Dismiss included.
  it("keeps a deleted path's set-aside draft reachable from the notice center", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    // The path is in no listing and no tab: only the store knows it.
    captureOrphanedDraft(WORKSPACE.workspaceId, "deleted/gone.md", "Kept!");
    // Another workspace's draft must NOT leak into this workspace's notice
    // center — the close guard is the global surface.
    captureOrphanedDraft("ws-somewhere-else", "private/notes.md", "Theirs");
    renderShell(bridge);
    await screen.findByTestId("file-tree");

    await user.click(await screen.findByTestId("notice-center-toggle"));
    await screen.findByTestId("notice-set-aside-edits");
    const rows = screen.getAllByTestId("recovery-list-row");
    expect(
      rows,
      "notice-center surface: drop the set-aside section from NoticeCenter. The draft exists, the close warning demands action, and no reachable surface offers it.",
    ).toHaveLength(1);
    const row = rows[0];
    expect(row.textContent).toContain("deleted/gone.md");
    expect(row.textContent).not.toContain("private/notes.md");
    // A workspace-scoped list needs no workspace label —
    // only the global close dialog carries them.
    expect(within(row).queryByTestId("recovery-list-workspace")).toBeNull();
    await user.click(screen.getByTestId("recovery-list-copy"));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("Kept!"));
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() => expect(screen.queryByTestId("notice-set-aside-edits")).toBeNull());

    // ...and with nothing left, the surface says so rather than implying a
    // draft that is not there.
    expect(screen.getByTestId("notice-center").textContent).toContain("All clear");
  });

  // A failed save-first flush aborts the switch, the
  // workspace never leaves its version, and the recovery announcement must
  // not fire — announcing a version change reopens the live document and
  // sets the still-editable draft aside on the same version.
  it("does not set the draft aside when a failed switch never left the version", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(["a.md"], "a.md")));
    bridge.listWorkspaceVersions = vi.fn(async () => ({
      versions: [
        {
          id: "main",
          name: "Main",
          kind: "main" as const,
          createdAtMs: 0,
          canMergeIntoMain: false,
        },
        {
          id: "v2",
          name: "Draft two",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: "main",
    }));
    // The save-first flush fails: the autosave write rejects.
    bridge.writeWorkspaceText = vi.fn(async () => {
      throw new Error("disk full");
    });
    renderShell(bridge);

    await screen.findByTestId("view-markdown");
    await user.type(await enterMarkdownSource(user), "Draft!");
    await screen.findByTestId("tab-dirty");

    await user.click(await screen.findByTestId("version-menu-button"));
    const item = (await screen.findAllByTestId("version-item")).find(
      (candidate) => candidate.dataset.versionId === "v2",
    );
    await user.click(item!);
    await user.click(await screen.findByTestId("version-switch-save-continue"));

    // The flush failed, the switch never started, the version never changed.
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    expect(bridge.switchWorkspaceVersion).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(
        screen.queryByTestId("markdown-open-state"),
        "failed-switch announce: announce the unchanged version from performSwitch's catch. The bookkeeping reopen then sets the draft aside on the same version — the notice appears and the editor loses the text the user could just keep editing.",
      ).toBeNull(),
    );
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    expect(
      screen.getByTestId("markdown-editor").querySelector<HTMLElement>(".cm-content")?.textContent,
    ).toContain("Draft!");
  });
});
