// @vitest-environment jsdom
import {
  openDirtyMarkdown,
} from "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import type { ListWorkspaceFilesPayload, ListWorkspaceFilesResult, ReadWorkspaceTextPayload, SwitchWorkspaceVersionResult, EngineYDocSaveStateEvent } from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";
import { captureOrphanedDraft } from "./orphanedDrafts";
import { CollectionFieldWriteHost, abandonPendingCollectionFieldWrites, collectionWriteFailures, collectionWritesPaused, discardCollectionFieldWrite, enqueueCollectionFieldWrite, hasPendingCollectionFieldWrites } from "./collections/recordFieldWrites";
import { deferred } from "../testing/deferred";
import { GlobalRecoveryList, WORKSPACE, OTHER_WORKSPACE, SYNC_STATUS, STORED_STATE, storedStateWithTabs, isFileOpenStartMark, recordDocUpdate, makeBridge, renderShell, enterMarkdownSource, holdHistory, sourceEditorText, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";

describe("workspace switch admission", () => {
  it("restores B's layout and engine surfaces after one admitted open", async () => {
    let selectedWorkspace = WORKSPACE;
    let admittedWorkspaceId = WORKSPACE.workspaceId;
    const rejectedReads: string[] = [];
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getWorkspaceUiState = vi.fn(async () => {
      if (admittedWorkspaceId !== selectedWorkspace.workspaceId) {
        rejectedReads.push(`ui-state:${selectedWorkspace.workspaceId}`);
        throw new Error("UI state read stopped because this window changed workspaces.");
      }
      return selectedWorkspace.workspaceId === OTHER_WORKSPACE.workspaceId
        ? storedStateWithTabs(["b.md"], "b.md")
        : null;
    });
    bridge.openWorkspace = vi.fn(async () => {
      admittedWorkspaceId = selectedWorkspace.workspaceId;
      return SYNC_STATUS;
    });
    const shell = (workspace: Workspace) => (
      <DesktopWorkspaceShell
        key={workspace.workspaceId}
        workspace={workspace}
        workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />
    );
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(WORKSPACE));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    bridge.getWorkspaceUiState.mockClear();
    bridge.openWorkspace.mockClear();

    selectedWorkspace = OTHER_WORKSPACE;
    view.rerender(shell(OTHER_WORKSPACE));

    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    await screen.findByTestId("tab-b.md");
    await screen.findByTestId("titlebar-chats-sidebar");
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalled());
    await act(async () => {});

    expect(rejectedReads).toEqual([`ui-state:${OTHER_WORKSPACE.workspaceId}`]);
    expect(bridge.getWorkspaceUiState).toHaveBeenCalledTimes(2);
    expect(bridge.openWorkspace).toHaveBeenCalledOnce();
  });
});

describe("collection input during a version switch", () => {
  it.each(["success", "failure"] as const)(
    "retains late input after switch %s without crossing versions",
    async (outcome) => {
      const user = userEvent.setup();
      const bridge = makeBridge(Promise.resolve(null));
      let activeVersionId = "main";
      bridge.listWorkspaceVersions = vi.fn(async () => ({
        versions: [
          { id: "main", name: "Main", kind: "main" as const, createdAtMs: 0, canMergeIntoMain: false },
          { id: "v2", name: "Draft two", kind: "named" as const, createdAtMs: 1, canMergeIntoMain: true },
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
      const change = { recordId: "rec-1", recordPath: "tasks/one.md", field: "status", value: "done" };
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
        expect(screen.getByTestId("collection-write-retry")).toHaveProperty("disabled", outcome === "success");
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
        async (payload: {
          workspaceId: string;
          path: string;
          sessionId: string;
        }) => {
          await openGates.get(payload.path);
          if (
            !openAvailability.available ||
            payload.workspaceId !== admitted.workspaceId
          ) {
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
      onEngineYDocSaveState: vi.fn(
        (listener: (event: EngineYDocSaveStateEvent) => void) => {
          saveListeners.add(listener);
          return () => saveListeners.delete(listener);
        },
      ),
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
      enqueueCollectionFieldWrite(OTHER_WORKSPACE.workspaceId, "tasks", { ...RECORD_EDIT, recordPath: "tasks/two.md" });
    });
    await waitFor(() => expect(harness.bridge.openEngineYDocSession).toHaveBeenCalled());
    harness.bridge.openWorkspace.mockClear();
    vi.useFakeTimers();
    try {
      view.rerender(harness.shell(OTHER_WORKSPACE));
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(collectionWriteFailures().map((failure) => failure.workspaceId)).toEqual([WORKSPACE.workspaceId]);
      expect(hasPendingCollectionFieldWrites()).toBe(true);
      expect(harness.bridge.openWorkspace).not.toHaveBeenCalled();
      act(() => discardCollectionFieldWrite(collectionWriteFailures()[0]!.id));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(harness.bridge.openWorkspace).toHaveBeenCalledWith({ workspaceId: OTHER_WORKSPACE.workspaceId }));
    await act(async () => { oldOpen.resolve(); nextOpen.resolve(); });
    await waitFor(() => expect(harness.bridge.applyEngineYDocUpdate).toHaveBeenCalled());
    act(() => {
      const sessionId = harness.sessions.get("tasks/two.md")!;
      for (const listener of [...harness.saveListeners]) listener({ sessionId, state: "saved", seq: 1 });
    });
    await waitFor(() => expect(hasPendingCollectionFieldWrites()).toBe(false));
    expect(collectionWriteFailures()).toHaveLength(0);
  });

  it("keeps an applied-only stalled save visible until its engine acknowledgement admits B", async () => {
    const harness = admissionHarness();
    const view = render(harness.shell(WORKSPACE));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    act(() => { enqueueCollectionFieldWrite(WORKSPACE.workspaceId, "tasks", RECORD_EDIT); });
    await waitFor(() => expect(harness.bridge.applyEngineYDocUpdate).toHaveBeenCalled());
    harness.bridge.openWorkspace.mockClear();

    vi.useFakeTimers();
    try {
      view.rerender(harness.shell(OTHER_WORKSPACE));
      await act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(collectionWriteFailures()).toEqual([]);
      const blocked = screen.getByTestId("workspace-open-failed");
      expect(blocked.textContent).toContain("dohc has not confirmed this save yet. Keep dohc open until saving finishes.");
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
          listener({ sessionId, state: "saved", seq: 1 });
        }
      });
      expect(harness.bridge.openWorkspace).toHaveBeenCalledExactlyOnceWith({ workspaceId: OTHER_WORKSPACE.workspaceId });
      expect(screen.queryByTestId("workspace-open-failed")).toBeNull();
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds B's open until A's queued collection write settles", async () => {
    const harness = admissionHarness();
    const gate = deferred<void>();
    harness.openGates.set("tasks/one.md", gate.promise);
    const view = render(harness.shell(WORKSPACE));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    act(() => {
      enqueueCollectionFieldWrite(WORKSPACE.workspaceId, "tasks", RECORD_EDIT);
    });
    await waitFor(() =>
      expect(harness.bridge.openEngineYDocSession).toHaveBeenCalled(),
    );
    harness.bridge.openWorkspace.mockClear();

    view.rerender(harness.shell(OTHER_WORKSPACE));
    await act(async () => {});
    expect(harness.bridge.openWorkspace).not.toHaveBeenCalled();

    // A's write lands: the session opens under A's still-current authority,
    // the update stages, and the engine reports the save settled.
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() =>
      expect(harness.bridge.applyEngineYDocUpdate).toHaveBeenCalled(),
    );
    act(() => {
      const sessionId = harness.sessions.get("tasks/one.md")!;
      for (const listener of [...harness.saveListeners]) {
        listener({ sessionId, state: "saved", seq: 1 });
      }
    });
    await waitFor(() =>
      expect(harness.bridge.openWorkspace).toHaveBeenCalledWith({
        workspaceId: OTHER_WORKSPACE.workspaceId,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    expect(collectionWriteFailures()).toEqual([]);
  });

  it("refuses admission over a retained failure until it is resolved", async () => {
    const harness = admissionHarness();
    harness.openAvailability.available = false;
    const view = render(harness.shell(WORKSPACE));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    act(() => {
      enqueueCollectionFieldWrite(WORKSPACE.workspaceId, "tasks", RECORD_EDIT);
    });
    await waitFor(() => expect(collectionWriteFailures()).toHaveLength(1));
    harness.bridge.openWorkspace.mockClear();

    view.rerender(harness.shell(OTHER_WORKSPACE));
    await screen.findByTestId("workspace-open-failed");
    expect(harness.bridge.openWorkspace).not.toHaveBeenCalled();

    // Resolving the failure re-runs admission without another click.
    act(() => {
      discardCollectionFieldWrite(collectionWriteFailures()[0]!.id);
    });
    await waitFor(() =>
      expect(harness.bridge.openWorkspace).toHaveBeenCalledWith({
        workspaceId: OTHER_WORKSPACE.workspaceId,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
  });

  it("blocks admission when A's write fails during the wait", async () => {
    const harness = admissionHarness();
    const gate = deferred<void>();
    harness.openGates.set("tasks/one.md", gate.promise);
    const view = render(harness.shell(WORKSPACE));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    act(() => {
      enqueueCollectionFieldWrite(WORKSPACE.workspaceId, "tasks", RECORD_EDIT);
    });
    await waitFor(() =>
      expect(harness.bridge.openEngineYDocSession).toHaveBeenCalled(),
    );
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
    await waitFor(() =>
      expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(1),
    );
    // The pause covers the pending IPC: a racing cell edit (an editor commit
    // already in flight) is refused and retained, never queued against the
    // path the move is changing.
    expect(collectionWritesPaused(WORKSPACE.workspaceId)).toBe(true);
    let accepted = true;
    act(() => {
      accepted = enqueueCollectionFieldWrite(
        WORKSPACE.workspaceId,
        "tasks",
        RECORD_EDIT,
      );
    });
    expect(accepted).toBe(false);
    expect(collectionWriteFailures()).toHaveLength(1);

    await act(async () => {
      move.resolve();
      await move.promise;
    });
    await waitFor(() =>
      expect(collectionWritesPaused(WORKSPACE.workspaceId)).toBe(false),
    );
    // The retained edit follows the rename, like tabs and set-aside drafts.
    expect(collectionWriteFailures()[0]!.change.recordPath).toBe("renamed.md");
  });

  it("releases the pause when the rename fails and keeps the old path", async () => {
    let rejectMove!: (error: Error) => void;
    const move = new Promise<void>((_resolve, reject) => {
      rejectMove = reject;
    });
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi.fn(() => move),
    });
    await beginRename(bridge);
    await waitFor(() =>
      expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(1),
    );
    expect(collectionWritesPaused(WORKSPACE.workspaceId)).toBe(true);
    act(() => {
      enqueueCollectionFieldWrite(WORKSPACE.workspaceId, "tasks", RECORD_EDIT);
    });

    await act(async () => {
      rejectMove(new Error("rename failed"));
      await move.catch(() => undefined);
    });
    await screen.findByTestId("workspace-shell-error");
    await waitFor(() =>
      expect(collectionWritesPaused(WORKSPACE.workspaceId)).toBe(false),
    );
    // Nothing moved, so the retained edit keeps the path it was accepted on.
    expect(collectionWriteFailures()[0]!.change.recordPath).toBe("a.md");
  });

  it("refuses a rename while a collection write failure is retained", async () => {
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi.fn(async () => undefined),
    });
    // A retained failure with its accepted value, exactly as a stalled-queue
    // abandonment leaves it.
    act(() => {
      enqueueCollectionFieldWrite(WORKSPACE.workspaceId, "tasks", RECORD_EDIT);
      abandonPendingCollectionFieldWrites("This change did not save.");
    });
    expect(collectionWriteFailures()).toHaveLength(1);
    await beginRename(bridge);
    await screen.findByTestId("workspace-shell-error");
    expect(bridge.moveWorkspacePath).not.toHaveBeenCalled();
    expect(collectionWritesPaused(WORKSPACE.workspaceId)).toBe(false);
  });
});

describe("workspace switch-back file listing", () => {
  it("paints a completed cached listing before the forced disk walk replaces it", async () => {
    const revalidation = deferred<ListWorkspaceFilesResult>();
    const bridge = makeBridge(Promise.resolve(null));
    let workspaceACalls = 0;
    bridge.listWorkspaceFiles = vi.fn(
      async (
        payload: ListWorkspaceFilesPayload,
      ): Promise<ListWorkspaceFilesResult> => {
        if (payload.workspaceId === OTHER_WORKSPACE.workspaceId) {
          return {
            files: [{ path: "other.md", kind: "file" }],
            folders: [],
          };
        }
        workspaceACalls += 1;
        if (workspaceACalls === 1) {
          return {
            files: [{ path: "cached.md", kind: "file" }],
            folders: [],
          };
        }
        if (workspaceACalls === 2) {
          return {
            files: [{ path: "cached.md", kind: "file" }],
            folders: [],
            cached: true,
          };
        }
        return revalidation.promise;
      },
    );
    const shell = (workspace: Workspace) => (
      <DesktopWorkspaceShell
        key={workspace.workspaceId}
        workspace={workspace}
        workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />
    );
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(WORKSPACE));
    expect(await screen.findByText("cached.md")).toBeTruthy();

    view.rerender(shell(OTHER_WORKSPACE));
    expect(await screen.findByText("other.md")).toBeTruthy();

    view.rerender(shell(WORKSPACE));
    expect(await screen.findByText("cached.md")).toBeTruthy();
    await waitFor(() => expect(workspaceACalls).toBe(3));
    expect(screen.queryByText("fresh.md")).toBeNull();

    await act(async () => {
      revalidation.resolve({
        files: [{ path: "fresh.md", kind: "file" }],
        folders: [],
      });
      await revalidation.promise;
    });
    expect(await screen.findByText("fresh.md")).toBeTruthy();
    expect(screen.queryByText("cached.md")).toBeNull();

    const workspaceARequests = bridge.listWorkspaceFiles.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.workspaceId === WORKSPACE.workspaceId);
    expect(workspaceARequests).toEqual([
      { workspaceId: WORKSPACE.workspaceId, allowCached: true },
      { workspaceId: WORKSPACE.workspaceId, allowCached: true },
      { workspaceId: WORKSPACE.workspaceId },
    ]);
  });

  it("does not prune a restored tab from the cached paint alone", async () => {
    const revalidation = deferred<ListWorkspaceFilesResult>();
    const bridge = makeBridge(
      Promise.resolve(
        storedStateWithTabs(["survivor.md", "gone.md"], "survivor.md"),
      ),
    );
    bridge.listWorkspaceFiles = vi
      .fn()
      .mockResolvedValueOnce({
        files: [{ path: "survivor.md", kind: "file" as const }],
        folders: [],
        cached: true,
      })
      .mockImplementationOnce(() => revalidation.promise);
    renderShell(bridge);

    expect(
      (await screen.findAllByText("survivor.md")).length,
    ).toBeGreaterThan(0);
    await waitFor(() =>
      expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByTestId("tab-gone.md")).toBeTruthy();

    await act(async () => {
      revalidation.resolve({
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

  it("performs one disk listing when the permitted cache read misses", async () => {
    const walk = deferred<ListWorkspaceFilesResult>();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockImplementation(() => walk.promise);
    renderShell(bridge);

    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledOnce());
    expect(screen.queryByText("cold.md")).toBeNull();
    await act(async () => {
      walk.resolve({
        files: [{ path: "cold.md", kind: "file" }],
        folders: [],
      });
      await walk.promise;
    });
    expect(await screen.findByText("cold.md")).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.listWorkspaceFiles).toHaveBeenCalledOnce();
    expect(bridge.listWorkspaceFiles).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      allowCached: true,
    });
  });
});

// Spurious file-open-start marks: a no-op click on the already-
// active row used to mark anyway — no remount/measure follows, so the stale
// mark corrupts the next open's latency measure.
describe("file-open-start marking", () => {
  it("marks the source fallback and target after a delayed move creates a group", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md", "fallback.md"], "a.md")),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: ["a.md", "fallback.md"].map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    }));
    bridge.readWorkspaceText = vi.fn(async () => ({
      text: "# Doc\n\n",
      truncated: false as const,
      contentHash: "a".repeat(64),
    }));
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    bridge.showWorkbenchMenu.mockResolvedValue("move-tab-to-new-group");
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findByTestId("view-markdown");
    await user.type(await enterMarkdownSource(user), "Draft");
    await waitFor(() => expect(screen.getByTestId("tab-dirty")).toBeTruthy());
    const mark = vi.spyOn(rendererMarks, "mark");

    fireEvent.contextMenu(screen.getByTestId("tab-a.md"));
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledOnce());
    expect(mark.mock.calls.some(([name]) => isFileOpenStartMark(name))).toBe(false);

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });

    const target = await screen.findByRole("region", { name: "Editor group 2" });
    const targetGroupId = target.dataset.editorGroupId!;
    expect(mark).toHaveBeenCalledWith("file-open-start:primary");
    expect(mark).toHaveBeenCalledWith(`file-open-start:${targetGroupId}`);
    mark.mockRestore();
  });

  it("marks both Markdown mounts in an active cross-group move", async () => {
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          {
            id: "left",
            tabs: ["a.md", "fallback.md"],
            activeTab: "a.md",
            size: 0.5,
          },
          { id: "right", tabs: ["b.md"], activeTab: "b.md", size: 0.5 },
        ],
        activeEditorGroup: "left",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: ["a.md", "fallback.md", "b.md"].map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    }));
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(Element.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => false),
    });
    renderShell(bridge);
    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
    );
    const mark = vi.spyOn(rendererMarks, "mark");
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const right = screen.getByRole("region", { name: "Editor group 2" });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => right),
    });
    const source = within(left).getByTestId("tab-a.md");

    fireEvent.pointerDown(source, { button: 0, pointerId: 7, clientX: 10 });
    fireEvent.pointerMove(source, {
      pointerId: 7,
      buttons: 1,
      clientX: 30,
      clientY: 40,
    });
    fireEvent.pointerUp(source, {
      pointerId: 7,
      clientX: 30,
      clientY: 40,
    });

    await waitFor(() =>
      expect(within(right).getByTestId("tab-a.md").dataset.active).toBe("true"),
    );
    expect(mark).toHaveBeenCalledWith("file-open-start:right");
    expect(mark).toHaveBeenCalledWith("file-open-start:left");
    mark.mockRestore();
  });

  it("measures overlapping Markdown opens from each editor group's start", async () => {
    const leftRead = deferred<{
      text: string;
      truncated: false;
      contentHash: string;
    }>();
    const rightRead = deferred<{
      text: string;
      truncated: false;
      contentHash: string;
    }>();
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          {
            id: "left",
            tabs: ["left-old.md"],
            activeTab: "left-old.md",
            size: 0.5,
          },
          {
            id: "right",
            tabs: ["right-old.md"],
            activeTab: "right-old.md",
            size: 0.5,
          },
        ],
        activeEditorGroup: "left",
      }),
    );
    const paths = ["left-old.md", "right-old.md", "left-new.md", "right-new.md"];
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: paths.map((path) => ({ path, kind: "file" as const })),
      folders: [],
    }));
    bridge.readWorkspaceText = vi.fn((payload: ReadWorkspaceTextPayload) => {
      if (payload.relativePath === "left-new.md") return leftRead.promise;
      if (payload.relativePath === "right-new.md") return rightRead.promise;
      return Promise.resolve({
        text: "# Ready\n",
        truncated: false as const,
        contentHash: "a".repeat(64),
      });
    });
    renderShell(bridge);
    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
    );
    const mark = vi.spyOn(rendererMarks, "mark");
    const measureSince = vi.spyOn(rendererMarks, "measureSince");
    const user = userEvent.setup();
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const right = screen.getByRole("region", { name: "Editor group 2" });

    await user.click(
      screen
        .getAllByTestId("tree-row")
        .find((row) => row.dataset.path === "left-new.md")!,
    );
    fireEvent.pointerDown(right);
    await waitFor(() => expect(right.dataset.active).toBe("true"));
    await user.click(
      screen
        .getAllByTestId("tree-row")
        .find((row) => row.dataset.path === "right-new.md")!,
    );

    await act(async () => {
      rightRead.resolve({
        text: "# Right\n",
        truncated: false,
        contentHash: "b".repeat(64),
      });
      await rightRead.promise;
    });
    await waitFor(() =>
      expect(measureSince).toHaveBeenCalledWith(
        "markdown-open",
        "file-open-start:right",
      ),
    );

    await act(async () => {
      leftRead.resolve({
        text: "# Left\n",
        truncated: false,
        contentHash: "c".repeat(64),
      });
      await leftRead.promise;
    });
    await waitFor(() =>
      expect(measureSince).toHaveBeenCalledWith(
        "markdown-open",
        "file-open-start:left",
      ),
    );
    expect(mark).toHaveBeenCalledWith("file-open-start:left");
    expect(mark).toHaveBeenCalledWith("file-open-start:right");
    expect(within(left).getByTestId("tab-left-new.md").dataset.active).toBe(
      "true",
    );
    expect(within(right).getByTestId("tab-right-new.md").dataset.active).toBe(
      "true",
    );
    mark.mockRestore();
    measureSince.mockRestore();
  });

  it("marks before a Markdown split mounts another inspector", async () => {
    const mark = vi.spyOn(rendererMarks, "mark");
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
    renderShell(bridge);

    await screen.findByTestId("view-markdown");
    const openStartCalls = () =>
      mark.mock.calls.filter(([name]) => isFileOpenStartMark(name)).length;
    const before = openStartCalls();

    await userEvent.click(screen.getByTestId("create-editor-group-right"));
    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
    );

    expect(openStartCalls()).toBe(before + 1);
    mark.mockRestore();
  });

  it("marks before a SQLite split loads another first page", async () => {
    const mark = vi.spyOn(rendererMarks, "mark");
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["data.db"], "data.db")),
    );
    bridge.listWorkspaceFiles.mockResolvedValue({
      files: [{ path: "data.db", kind: "file" }],
      folders: [],
    });
    Object.assign(bridge, {
      readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
    });
    renderShell(bridge);

    await screen.findByTestId("view-database");
    const openStartCalls = () =>
      mark.mock.calls.filter(([name]) => isFileOpenStartMark(name)).length;
    const before = openStartCalls();

    await userEvent.click(screen.getByTestId("create-editor-group-right"));
    await waitFor(() =>
      expect(screen.getAllByTestId("view-database")).toHaveLength(2),
    );

    expect(openStartCalls()).toBe(before + 1);
    mark.mockRestore();
  });

  it("focuses an already-mounted Open Editors tab without marking a file open", async () => {
    const mark = vi.spyOn(rendererMarks, "mark");
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          { id: "primary", tabs: ["a.md"], activeTab: "a.md", size: 0.5 },
          { id: "right", tabs: ["b.md"], activeTab: "b.md", size: 0.5 },
        ],
        activeEditorGroup: "right",
      }),
    );
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findByTestId("tab-a.md");
    const openStartCalls = () =>
      mark.mock.calls.filter(([name]) => isFileOpenStartMark(name)).length;
    const before = openStartCalls();
    await user.click(
      within(screen.getAllByTestId("open-editor-group")[0]!).getByTitle("a.md"),
    );

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Editor group 1" }).dataset.active).toBe(
        "true",
      ),
    );
    expect(openStartCalls()).toBe(before);
    mark.mockRestore();
  });

  it("marks on a real open, but not on a no-op click on the already-active file", async () => {
    const mark = vi.spyOn(rendererMarks, "mark");
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    const openStartCalls = () =>
      mark.mock.calls.filter(([name]) => isFileOpenStartMark(name)).length;

    const row = await screen.findByText("a.md");
    await user.click(row);
    await screen.findByTestId("tab-a.md");
    expect(openStartCalls()).toBe(1);

    // Re-clicking the active row is a no-op open: no remount, no mark.
    await user.click(row);
    expect(openStartCalls()).toBe(1);

    // A different file is a real open again.
    await user.click(screen.getByText("b.md"));
    await screen.findByTestId("tab-b.md");
    expect(openStartCalls()).toBe(2);

    mark.mockRestore();
  });

  it("marks when a close hands a non-focused group to another document", async () => {
    const mark = vi.spyOn(rendererMarks, "mark");
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          { id: "left", tabs: ["a.md", "b.md"], activeTab: "b.md", size: 0.5 },
          { id: "right", tabs: ["c.md"], activeTab: "c.md", size: 0.5 },
        ],
        activeEditorGroup: "right",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: ["a.md", "b.md", "c.md"].map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    }));
    renderShell(bridge);

    await screen.findByTestId("tab-c.md");
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const before = mark.mock.calls.filter(
      ([name]) => isFileOpenStartMark(name),
    ).length;
    await userEvent.click(
      within(left).getByRole("button", { name: "Close b.md" }),
    );

    await screen.findByTestId("tab-a.md");
    expect(
      mark.mock.calls.filter(([name]) => isFileOpenStartMark(name)),
    ).toHaveLength(before + 1);
    expect(mark).toHaveBeenCalledWith("file-open-start:left");
    mark.mockRestore();
  });

  it("does not mark when closing a group reveals an already-mounted neighbor", async () => {
    const mark = vi.spyOn(rendererMarks, "mark");
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

    await screen.findByTestId("tab-b.md");
    const left = screen.getByRole("region", { name: "Editor group 1" });
    const before = mark.mock.calls.filter(
      ([name]) => isFileOpenStartMark(name),
    ).length;
    await userEvent.click(
      within(left).getByRole("button", { name: "Close a.md" }),
    );

    await waitFor(() =>
      expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(1),
    );
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
    expect(
      mark.mock.calls.filter(([name]) => isFileOpenStartMark(name)),
    ).toHaveLength(before);
    mark.mockRestore();
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
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "disk full",
    );
  });

  it("keeps the active tab mounted when Ctrl+W cannot flush it", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.writeWorkspaceText = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { user, editor } = await openDirtyMarkdown(bridge);

    await user.keyboard("{Control>}w{/Control}");

    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(editor.isConnected).toBe(true);
  });

  it("keeps every tab when close-all cannot flush the active tab", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md")),
    );
    bridge.writeWorkspaceText = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { user, editor } = await openDirtyMarkdown(bridge);

    await user.click(screen.getByRole("button", { name: "Close all editors" }));

    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
    expect(editor.isConnected).toBe(true);
  });

  it("flushes a captured tab that becomes active while close-all waits", async () => {
    const aSave = deferred<{ status: "written"; contentHash: string }>();
    let rejectBSave!: (cause: Error) => void;
    const bSave = new Promise<{ status: "written"; contentHash: string }>(
      (_resolve, reject) => {
        rejectBSave = reject;
      },
    );
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    bridge.writeWorkspaceText = vi.fn((payload) =>
      payload.relativePath === "a.md" ? aSave.promise : bSave,
    );
    const { user } = await openDirtyMarkdown(bridge);

    await user.click(screen.getByRole("button", { name: "Close all editors" }));
    await waitFor(() =>
      expect(bridge.writeWorkspaceText.mock.calls[0]?.[0].relativePath).toBe("a.md"),
    );

    // This is a later action, but b.md was already in the captured close set.
    // Its newly mounted editor therefore needs its own flush before it closes.
    await user.click(screen.getByTestId("tab-b.md"));
    const bEditor = await enterMarkdownSource(user);
    await user.type(bEditor, "Second draft!");

    await act(async () => {
      aSave.resolve({ status: "written", contentHash: "b".repeat(64) });
      await aSave.promise;
    });
    await waitFor(() =>
      expect(
        bridge.writeWorkspaceText.mock.calls.some(
          ([payload]) => payload.relativePath === "b.md",
        ),
      ).toBe(true),
    );

    await act(async () => {
      rejectBSave(new Error("disk full"));
      await bSave.catch(() => undefined);
    });
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
    expect(bEditor.isConnected).toBe(true);
  });

  it("does not close a tab reopened while close-all waits", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md")),
    );
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
    const bRow = screen
      .getAllByTestId("tree-row")
      .find((row) => row.dataset.path === "b.md")!;
    await user.click(bRow);
    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });
    await waitFor(() => expect(screen.queryByTestId("tab-a.md")).toBeNull());
    expect(screen.getByTestId("tab-b.md").dataset.active).toBe("true");
  });

  it("does not close a requested tab after it moves to another group", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          { id: "left", tabs: ["a.md", "b.md"], activeTab: "a.md", size: 0.5 },
          { id: "right", tabs: ["c.md"], activeTab: "c.md", size: 0.5 },
        ],
        activeEditorGroup: "left",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      files: ["a.md", "b.md", "c.md"].map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    }));
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    bridge.showWorkbenchMenu.mockResolvedValue("move-tab-to-new-group");
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findByTestId("tab-c.md");
    await waitFor(() => expect(screen.getAllByTestId("view-markdown")).toHaveLength(2));
    const left = screen.getByRole("region", { name: "Editor group 1" });
    await user.type(await enterMarkdownSource(user, left), "Draft!");
    await within(screen.getByTestId("tab-a.md")).findByTestId("tab-dirty");
    await user.click(
      within(left).getByRole("button", { name: "Close editor group" }),
    );
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());

    fireEvent.contextMenu(screen.getByTestId("tab-b.md"));
    await waitFor(() => expect(bridge.showWorkbenchMenu).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(3),
    );

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });
    await waitFor(() => expect(screen.queryByTestId("tab-a.md")).toBeNull());
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
    expect(screen.getByTestId("tab-c.md")).toBeTruthy();
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
    bridge.writeWorkspaceText = vi.fn(
      async (payload: { relativePath: string }) => {
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
      },
    );
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

    const firstEditor = firstPath === "a.md"
      ? within(left).getByTestId("markdown-editor").querySelector<HTMLElement>(".cm-content")!
      : within(right).getByTestId("markdown-editor").querySelector<HTMLElement>(".cm-content")!;
    await user.type(firstEditor, " changed again");
    await waitFor(() => expect(screen.getAllByTestId("tab-dirty")).toHaveLength(2));

    const writesBeforeRelease = bridge.writeWorkspaceText.mock.calls.length;
    await act(async () => {
      heldSave.resolve({ status: "written", contentHash: "d".repeat(64) });
      await heldSave.promise;
    });
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "disk full",
    );
    expect(
      bridge.writeWorkspaceText.mock.calls.slice(writesBeforeRelease).at(-1)?.[0],
    ).toMatchObject({ relativePath: firstPath, text: expect.stringContaining(" changed again") });
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
    expect(firstEditor.isConnected).toBe(true);
  });

  it("closes an inactive tab synchronously while the active flush is pending", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md")),
    );
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    const { editor } = await openDirtyMarkdown(bridge);

    fireEvent.click(screen.getByRole("button", { name: "Close all editors" }));
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(1));

    fireEvent.click(
      within(screen.getByTestId("tab-b.md")).getByRole("button", {
        name: "Close b.md",
      }),
    );

    expect(screen.queryByTestId("tab-b.md")).toBeNull();
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(editor.isConnected).toBe(true);
    expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });
    await waitFor(() => expect(screen.queryByTestId("tab-a.md")).toBeNull());
  });

  it("keeps every tab when close-others cannot flush the active tab", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md")),
    );
    bridge.showWorkbenchMenu.mockResolvedValue("close-other-tabs");
    bridge.writeWorkspaceText = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { editor } = await openDirtyMarkdown(bridge);

    fireEvent.contextMenu(screen.getByTestId("tab-b.md"));

    await waitFor(() => expect(bridge.showWorkbenchMenu).toHaveBeenCalled());
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
    expect(editor.isConnected).toBe(true);
  });

  it("waits for a successful flush before closing the active tab", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    const { user } = await openDirtyMarkdown(bridge);

    await user.click(
      within(screen.getByTestId("tab-a.md")).getByRole("button", {
        name: "Close a.md",
      }),
    );
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });
    await waitFor(() => expect(screen.queryByTestId("tab-a.md")).toBeNull());
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
  });
});

describe("explorer destructive change flush boundaries", () => {
  it("does not rename a file when the active draft flush fails", async () => {
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi.fn(async () => undefined),
    });
    bridge.writeWorkspaceText = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { user, editor } = await openDirtyMarkdown(bridge);
    const row = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "a.md",
    )!;

    await user.click(row);
    await user.keyboard("{F2}");
    const input = await screen.findByTestId("tree-edit-input");
    await user.clear(input);
    await user.type(input, "renamed.md{Enter}");

    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    expect(bridge.moveWorkspacePath).not.toHaveBeenCalled();
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "disk full",
    );
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(editor.isConnected).toBe(true);
  });

  it("does not move a file when the active draft flush fails", async () => {
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi.fn(async () => undefined),
    });
    bridge.listWorkspaceFiles.mockResolvedValue({
      files: [
        { path: "a.md", kind: "file" as const },
        { path: "docs/b.md", kind: "file" as const },
      ],
      folders: ["docs"],
    });
    bridge.writeWorkspaceText = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { editor } = await openDirtyMarkdown(bridge);
    const rows = await screen.findAllByTestId("tree-row");
    const source = rows.find((row) => row.dataset.path === "a.md")!;
    const target = rows.find((row) => row.dataset.path === "docs")!;
    const dataTransfer = {
      effectAllowed: "move",
      dropEffect: "move",
      files: [],
      types: [],
      setData: vi.fn(),
    };

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    expect(bridge.moveWorkspacePath).not.toHaveBeenCalled();
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "disk full",
    );
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(editor.isConnected).toBe(true);
  });

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
    await user.click(await screen.findByTestId("confirm-delete"));

    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    expect(bridge.deleteWorkspacePath).not.toHaveBeenCalled();
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "disk full",
    );
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(editor.isConnected).toBe(true);
  });

  it("rechecks the active editor before deleting its folder", async () => {
    const aSave = deferred<{ status: "written"; contentHash: string }>();
    let rejectBSave!: (cause: Error) => void;
    const bSave = new Promise<{ status: "written"; contentHash: string }>(
      (_resolve, reject) => {
        rejectBSave = reject;
      },
    );
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      deleteWorkspacePath: vi.fn(async () => undefined),
    });
    bridge.listWorkspaceFiles.mockResolvedValue({
      files: [
        { path: "a.md", kind: "file" as const },
        { path: "docs/b.md", kind: "file" as const },
      ],
      folders: ["docs"],
    });
    bridge.writeWorkspaceText = vi.fn((payload) =>
      payload.relativePath === "a.md" ? aSave.promise : bSave,
    );
    const { user } = await openDirtyMarkdown(bridge);
    const docs = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "docs",
    )!;

    await user.click(docs);
    await user.keyboard("{Delete}");
    await user.click(await screen.findByTestId("confirm-delete"));
    await waitFor(() =>
      expect(bridge.writeWorkspaceText.mock.calls[0]?.[0].relativePath).toBe("a.md"),
    );

    const bRow = screen
      .getAllByTestId("tree-row")
      .find((candidate) => candidate.dataset.path === "docs/b.md")!;
    await user.click(bRow);
    const bEditor = await enterMarkdownSource(user);
    await user.type(bEditor, "Second draft!");

    await act(async () => {
      aSave.resolve({ status: "written", contentHash: "b".repeat(64) });
      await aSave.promise;
    });
    await waitFor(() =>
      expect(
        bridge.writeWorkspaceText.mock.calls.some(
          ([payload]) => payload.relativePath === "docs/b.md",
        ),
      ).toBe(true),
    );
    await act(async () => {
      rejectBSave(new Error("disk full"));
      await bSave.catch(() => undefined);
    });

    expect(bridge.deleteWorkspacePath).not.toHaveBeenCalled();
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "disk full",
    );
    expect(screen.getByTestId("tab-docs/b.md")).toBeTruthy();
    expect(bEditor.isConnected).toBe(true);
  });

  it("waits for a successful flush before renaming the file", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi.fn(async () => undefined),
    });
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    const { user } = await openDirtyMarkdown(bridge);
    const row = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "a.md",
    )!;

    await user.click(row);
    await user.keyboard("{F2}");
    const input = await screen.findByTestId("tree-edit-input");
    await user.clear(input);
    await user.type(input, "renamed.md{Enter}");

    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalled());
    expect(bridge.moveWorkspacePath).not.toHaveBeenCalled();

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });
    await waitFor(() =>
      expect(bridge.moveWorkspacePath).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        fromPath: "a.md",
        toPath: "renamed.md",
      }),
    );
  });

  it("keeps a late queued rename conflict on the renamed tab", async () => {
    const move = deferred<void>();
    const lateWrite = deferred<{
      status: "conflict";
      currentContentHash: null;
    }>();
    let writes = 0;
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi.fn(() => move.promise),
    });
    bridge.writeWorkspaceText = vi.fn(() => {
      writes += 1;
      return writes === 1
        ? Promise.resolve({ status: "written" as const, contentHash: "b".repeat(64) })
        : lateWrite.promise;
    });
    const { user, editor } = await openDirtyMarkdown(bridge);
    const row = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "a.md",
    )!;

    await user.click(row);
    await user.keyboard("{F2}");
    const input = await screen.findByTestId("tree-edit-input");
    await user.clear(input);
    await user.type(input, "renamed.md{Enter}");
    await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(1));
    expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await user.click(editor);
    await user.type(editor, " Late");
    const lateDraft = sourceEditorText(editor);
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(2));
    expect(bridge.writeWorkspaceText.mock.calls[1]?.[0]).toEqual({
      workspaceId: WORKSPACE.workspaceId,
      relativePath: "a.md",
      text: lateDraft,
      expectedContentHash: "b".repeat(64),
    });

    // Main releases the queued write only after the exclusive rename. The
    // shell must now join that late obligation before projecting the path;
    // otherwise recovery can arrive after the one-shot path remap.
    await act(async () => {
      move.resolve(undefined);
      await move.promise;
    });
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(screen.queryByTestId("tab-renamed.md")).toBeNull();
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();

    await act(async () => {
      lateWrite.resolve({ status: "conflict", currentContentHash: null });
      await lateWrite.promise;
    });
    await screen.findByTestId("tab-renamed.md");
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(lateDraft),
    );
    expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(2);
  });

  it("keeps a late queued delete conflict in global recovery", async () => {
    const deletion = deferred<void>();
    const lateWrite = deferred<{
      status: "conflict";
      currentContentHash: null;
    }>();
    let writes = 0;
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      deleteWorkspacePath: vi.fn(() => deletion.promise),
    });
    bridge.writeWorkspaceText = vi.fn(() => {
      writes += 1;
      return writes === 1
        ? Promise.resolve({ status: "written" as const, contentHash: "b".repeat(64) })
        : lateWrite.promise;
    });
    const { user, editor } = await openDirtyMarkdown(bridge);
    const row = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "a.md",
    )!;

    await user.click(row);
    await user.keyboard("{Delete}");
    await user.click(await screen.findByTestId("confirm-delete"));
    await waitFor(() => expect(bridge.deleteWorkspacePath).toHaveBeenCalledTimes(1));
    expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await user.click(editor);
    await user.type(editor, " Late");
    const lateDraft = sourceEditorText(editor);
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(2));
    expect(bridge.writeWorkspaceText.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ relativePath: "a.md", text: lateDraft }),
    );

    await act(async () => {
      deletion.resolve(undefined);
      await deletion.promise;
    });
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    await act(async () => {
      lateWrite.resolve({ status: "conflict", currentContentHash: null });
      await lateWrite.promise;
    });
    await waitFor(() => expect(screen.queryByTestId("tab-a.md")).toBeNull());

    const recovery = render(<GlobalRecoveryList />);
    const recoveryRow = await within(recovery.container).findByTestId(
      "recovery-list-row",
    );
    await user.click(within(recoveryRow).getByTestId("recovery-list-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(lateDraft),
    );
    // Removing the tab awaited draft settlement; recovery now holds the late text.
    expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(2);
  });

  it("resumes a late queued write when the rename fails", async () => {
    let rejectMove!: (error: Error) => void;
    const move = new Promise<void>((_resolve, reject) => {
      rejectMove = reject;
    });
    const lateWrite = deferred<{
      status: "written";
      contentHash: string;
    }>();
    let writes = 0;
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi.fn(() => move),
    });
    bridge.writeWorkspaceText = vi.fn(() => {
      writes += 1;
      return writes === 1
        ? Promise.resolve({ status: "written" as const, contentHash: "b".repeat(64) })
        : lateWrite.promise;
    });
    const { user, editor } = await openDirtyMarkdown(bridge);
    const row = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "a.md",
    )!;

    await user.click(row);
    await user.keyboard("{F2}");
    const input = await screen.findByTestId("tree-edit-input");
    await user.clear(input);
    await user.type(input, "renamed.md{Enter}");
    await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(1));

    await user.click(editor);
    await user.type(editor, " Late");
    const lateDraft = sourceEditorText(editor);
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(2));

    // Start a second Explorer flush while the write and rename are held.
    // The rename settlement must add recovery semantics when it joins this
    // promise, even though the create operation started it without them.
    await user.click(screen.getByLabelText("New file"));
    await user.type(await screen.findByLabelText("New file name"), "spare.md{Enter}");
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();

    await act(async () => {
      rejectMove(new Error("rename failed"));
      await move.catch(() => undefined);
    });
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "rename failed",
    );
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
    expect(editor.isConnected).toBe(true);

    await act(async () => {
      lateWrite.resolve({ status: "written", contentHash: "c".repeat(64) });
      await lateWrite.promise;
    });
    expect(bridge.writeWorkspaceText.mock.calls[1]?.[0]).toEqual({
      workspaceId: WORKSPACE.workspaceId,
      relativePath: "a.md",
      text: lateDraft,
      expectedContentHash: "b".repeat(64),
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("markdown-save-state").getAttribute("data-state"),
      ).toBe("saved"),
    );
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
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
      makeBridge(
        Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md")),
      ),
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
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(lateADraft),
    );
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
      makeBridge(
        Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md")),
      ),
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
    await user.click(await screen.findByTestId("confirm-delete"));
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
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(lateADraft),
    );
    expect(bridge.writeWorkspaceText.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ relativePath: "b.md", text: lateBDraft }),
    );
  });

  it("captures an ordinary post-rename I/O failure before remapping recovery", async () => {
    const move = deferred<void>();
    let rejectLateWrite!: (error: Error) => void;
    const lateWrite = new Promise<never>((_resolve, reject) => {
      rejectLateWrite = reject;
    });
    let writes = 0;
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi.fn(() => move.promise),
    });
    bridge.writeWorkspaceText = vi.fn(() => {
      writes += 1;
      if (writes === 1) {
        return Promise.resolve({
          status: "written" as const,
          contentHash: "b".repeat(64),
        });
      }
      if (writes === 2) return lateWrite;
      return Promise.reject(new Error("disk unavailable"));
    });
    const { user, editor } = await openDirtyMarkdown(bridge);
    const row = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "a.md",
    )!;

    await user.click(row);
    await user.keyboard("{F2}");
    const input = await screen.findByTestId("tree-edit-input");
    await user.clear(input);
    await user.type(input, "renamed.md{Enter}");
    await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(1));

    await user.click(editor);
    await user.type(editor, " Late");
    const lateDraft = sourceEditorText(editor);
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(2));

    await act(async () => {
      move.resolve(undefined);
      await move.promise;
      rejectLateWrite(new Error("disk unavailable"));
      await lateWrite.catch(() => undefined);
    });
    await screen.findByTestId("tab-renamed.md");
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(lateDraft),
    );
    expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(3);
  });
});

// #567 / #579 review: set-aside draft recovery at the shell seams. The drafts
// live in a module store keyed by workspace + path; the shell owns the two
// integrations under test — path remapping on explorer renames, and the
// distinction between recovery (dot, no save promise) and savable-dirty
// (dot and the version-switch save-first prompt).
describe("set-aside draft recovery", () => {
  // Most tests capture a draft before the shell mounts, and the draft store
  // reads the platform from the bridge. `renderShell` replaces this stub.
  beforeEach(() => {
    vi.stubGlobal("dohcDesktop", { platform: "linux" });
  });

  it("keeps the notice reachable when the open file is renamed mid-notice", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
    Object.assign(bridge, {
      moveWorkspacePath: vi.fn(async () => undefined),
    });
    captureOrphanedDraft(WORKSPACE.workspaceId, "a.md", "Kept!");
    renderShell(bridge);

    // The notice is up on the open document.
    await screen.findByTestId("view-markdown");
    await screen.findByTestId("orphaned-draft-notice");

    // Rename a.md through the explorer (F2 flow — the same seam every rename
    // takes). The tab remaps to the new path.
    const row = (await screen.findAllByTestId("tree-row")).find((candidate) =>
      candidate.textContent?.includes("a.md"),
    );
    expect(row).toBeTruthy();
    await user.click(row!);
    await user.keyboard("{F2}");
    const input = await screen.findByTestId("tree-edit-input");
    await user.clear(input);
    await user.type(input, "renamed.md{Enter}");
    await screen.findByTestId("tab-renamed.md");

    expect(await screen.findByTestId("orphaned-draft-notice"), "remap wiring: drop the remapOrphanedDraftPaths call from onExplorerPathsChanged. The store still keys by a.md, the tab is renamed.md, and the recovery text is unreachable from the UI.").toBeTruthy();
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Kept!"),
    );
  });

  it("marks the tab with recovery but lets a version switch proceed without a save promise", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
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
      expect(bridge.switchWorkspaceVersion, "lift: lift the recovery-derived state from MarkdownView's onSaveStateChange (the round-1 behavior). The save-first dialog then appears and the switch below never runs.").toHaveBeenCalled(),
    );
    expect(screen.queryByTestId("version-switch-save-confirm")).toBeNull();
    // The notice survives the switch — recovery needed no save.
    expect(screen.getByTestId("orphaned-draft-notice")).toBeTruthy();
  });

  it("treats a deleted live document as terminal instead of save-first dirty", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
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
    const doc = markdownToYDoc("# Doc\n");
    let sessionId = "";
    const saveStateListeners = new Set<
      (event: EngineYDocSaveStateEvent) => void
    >();
    Object.assign(bridge, {
      openEngineYDocSession: vi.fn(async (payload: { sessionId: string }) => {
        sessionId = payload.sessionId;
        return {
          available: true,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          lineageGeneration: 1,
        };
      }),
      applyEngineYDocUpdate: vi.fn(async () => ({ accepted: true as const })),
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
    await screen.findByTestId("markdown-source-toggle");

    await user.type(screen.getByTestId("page-title"), " changed");
    await screen.findByTestId("tab-dirty");
    act(() => {
      for (const listener of [...saveStateListeners]) {
        listener({ sessionId, state: "deleted", seq: 1 });
      }
    });
    await screen.findByTestId("deleted-while-editing-notice");

    await user.click(await screen.findByTestId("version-menu-button"));
    const item = (await screen.findAllByTestId("version-item")).find(
      (candidate) => candidate.dataset.versionId === "v2",
    );
    await user.click(item!);

    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    expect(screen.queryByTestId("version-switch-save-confirm")).toBeNull();
  });

  // Only the mounted inspector can report savable-dirty, but
  // recovery is knowable for every tab — an inactive tab must keep its
  // marker or the user forgets the draft exists.
  it("marks an inactive tab that holds a set-aside draft", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md", "b.md"], "a.md")),
    );
    captureOrphanedDraft(WORKSPACE.workspaceId, "b.md", "Kept!");
    renderShell(bridge);

    const inactive = await screen.findByTestId("tab-b.md");
    expect(within(inactive).getByTestId("tab-dirty"), "per-tab set: key the marker off the active tab only. The inactive b.md loses its marker while its draft still exists.").toBeTruthy();
    const active = screen.getByTestId("tab-a.md");
    expect(within(active).queryByTestId("tab-dirty")).toBeNull();
  });

  // The global recovery list labels rows with the NAME the
  // UI shows for the workspace, not its UUID — the shell registers it.
  it("registers the workspace's display name for the global recovery list", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    captureOrphanedDraft(WORKSPACE.workspaceId, "a.md", "Kept!");
    renderShell(bridge);
    await screen.findByTestId("file-tree");

    // The same global list the close dialog embeds.
    render(<GlobalRecoveryList />);
    expect(screen.getByTestId("recovery-list-workspace").textContent, "label wiring: drop the shell's noteWorkspaceLabel effect — the row falls back to the raw workspace id.").toBe(
      "personal",
    );
  });

  // A switch can fail after its IPC started — main settles
  // and closes live Y.Doc sessions before it sets the active version, so
  // "the version never moved" does not mean "nothing happened". The reopen
  // must fire, or the editor keeps a session main already closed and later
  // edits vanish into swallowed IPC rejections.
  it("reopens the document when a switch fails after its IPC started", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
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
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      throw new Error("switch failed mid-way");
    });
    const openEngineYDocSession = vi.fn(async () => ({ available: false }));
    // Subscribed before every open — a bridge missing this
    // degrades to not-engine-backed instead of ever attempting the open, so
    // this mock needs it even though this test never emits through it.
    const onEngineYDocSaveState = vi.fn(() => () => undefined);
    const onEngineYDocLineageReplacement = vi.fn(() => () => undefined);
    Object.assign(bridge, {
      openEngineYDocSession,
      onEngineYDocSaveState,
      onEngineYDocLineageReplacement,
    });
    renderShell(bridge);
    await screen.findByTestId("view-markdown");
    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledTimes(1));

    // No pending draft, so the switch starts at once — and fails inside.
    await user.click(await screen.findByTestId("version-menu-button"));
    const item = (await screen.findAllByTestId("version-item")).find(
      (candidate) => candidate.dataset.versionId === "v2",
    );
    await user.click(item!);
    await waitFor(() =>
      expect(bridge.switchWorkspaceVersion).toHaveBeenCalled(),
    );

    await waitFor(() => expect(openEngineYDocSession, "switch-issued key: suppress the announce whenever the version did not move, regardless of where the failure happened. The reopen below never comes and the closed-session write path is live.").toHaveBeenCalledTimes(2));
  });

  // A successful switch announces before its selector
  // refresh, and announcing again after that refresh fails would bump the
  // version epoch a second time — the same-version reopen moves whatever the
  // user typed in between into set-aside recovery — a notice the user then
  // has to answer.
  //
  // What this test pins is the OUTCOME: one switch, one reopen. It does not
  // pin the `announced` guard that also enforces it — removing that guard
  // still passes.
  //
  // An earlier round claimed that was because a successful switch re-keys this
  // panel. That was wrong: `<VersionMenu>` is mounted without a key
  // (DesktopWorkspaceShell.tsx), so it is not re-keyed, exactly as
  // WorkspaceVersions.tsx:105-115 intends. What actually absorbs the second
  // announcement is not established — measured on the mutated build, the
  // catch path's recovery read does run (four listWorkspaceVersions calls) and
  // the reopen count still stays at two.
  //
  // So: unpinned, and reachable under an order these tests do not produce —
  // two liveness checks sit between the recovery read and the announcement,
  // and passing them is a scheduling order, not a structural barrier. The
  // guard stays because it makes the outcome hold regardless of that order.
  it("reopens once when a successful switch's selector refresh fails", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
    let switched = false;
    let refreshFailed = false;
    const recovery = deferred();
    bridge.listWorkspaceVersions = vi.fn(async () => {
      // The switch's OWN refresh fails; the catch path's recovery read then
      // succeeds and reports the version the switch already announced. That
      // is the shape that announces twice.
      if (switched && !refreshFailed) {
        refreshFailed = true;
        throw new Error("selector refresh failed");
      }
      if (switched) await recovery.promise;
      return {
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
        activeVersionId: switched ? "v2" : "main",
      };
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "v2", changedFileCount: 0 };
    });
    const openEngineYDocSession = vi.fn(async () => ({ available: false }));
    // Subscribed before every open — a bridge missing this
    // degrades to not-engine-backed instead of ever attempting the open, so
    // this mock needs it even though this test never emits through it.
    const onEngineYDocSaveState = vi.fn(() => () => undefined);
    const onEngineYDocLineageReplacement = vi.fn(() => () => undefined);
    Object.assign(bridge, {
      openEngineYDocSession,
      onEngineYDocSaveState,
      onEngineYDocLineageReplacement,
    });
    try {
      renderShell(bridge);
      await screen.findByTestId("view-markdown");
      await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledTimes(1));

      await user.click(await screen.findByTestId("version-menu-button"));
      const item = (await screen.findAllByTestId("version-item")).find(
        (candidate) => candidate.dataset.versionId === "v2",
      );
      await user.click(item!);
      await waitFor(() =>
        expect(bridge.switchWorkspaceVersion).toHaveBeenCalled(),
      );

      // The switch landed, so the reopen it announced is the right one.
      await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledTimes(2));
      await waitFor(() => {
        expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
          "selector refresh failed",
        );
        expect(
          (screen.getByTestId("version-menu-button") as HTMLButtonElement).disabled,
        ).toBe(true);
      });
    } finally {
      await act(async () => {
        recovery.resolve();
        await recovery.promise;
      });
    }
    // Recovery has finished when the selector leaves its busy state.
    await waitFor(() => {
      expect(
        (screen.getByTestId("version-menu-button") as HTMLButtonElement).disabled,
      ).toBe(false);
      expect(screen.getByTestId("version-menu-active").textContent).toBe("Draft two");
    });
    expect(openEngineYDocSession).toHaveBeenCalledTimes(2);
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
    expect(rows, "notice-center surface: drop the set-aside section from NoticeCenter. The draft exists, the close warning demands action, and no reachable surface offers it.").toHaveLength(1);
    const row = rows[0];
    expect(row.textContent).toContain("deleted/gone.md");
    expect(row.textContent).not.toContain("private/notes.md");
    // A workspace-scoped list needs no workspace label —
    // only the global close dialog carries them.
    expect(within(row).queryByTestId("recovery-list-workspace")).toBeNull();
    await user.click(screen.getByTestId("recovery-list-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Kept!"),
    );
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("notice-set-aside-edits")).toBeNull(),
    );

    // ...and with nothing left, the surface says so rather than implying a
    // draft that is not there.
    expect(screen.getByTestId("notice-center").textContent).toContain(
      "All clear",
    );
  });

  // The store no longer dies on reload, quit, update-restart or crash —
  // a set-aside edit is written on capture and restored at launch. The #579
  // lifetime disclosure ("they live only in this window") became false with
  // it, and a false claim about durability is worse than none. The close
  // warning is what names the drafts storage could not keep, at the moment
  // that matters.
  it("makes no claim that set-aside edits die with the window", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    captureOrphanedDraft(WORKSPACE.workspaceId, "notes/a.md", "Kept!");
    renderShell(bridge);
    await screen.findByTestId("file-tree");

    await user.click(await screen.findByTestId("notice-center-toggle"));
    const section = await screen.findByTestId("notice-set-aside-edits");
    expect(section.textContent, "stale disclosure: put the sentence back. The panel then tells the user an edit that survives the next launch is about to be lost.").not.toContain("live only in this window");
    // ...and it names both ways out, so the warning offers what it demands.
    expect(section.textContent).toContain("Copy an edit to keep its text");
    expect(section.textContent).toContain("Dismiss deletes it for good");
  });

  // Dropping the blanket disclosure was right for the rows that now
  // survive a quit, and it left the rows that still do not — a secret path
  // plaintext storage refuses, a write the quota refused — looking
  // exactly like the durable ones. The lifetime moved onto the row.
  it("marks the set-aside edits that still die with the window", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    captureOrphanedDraft(WORKSPACE.workspaceId, "notes/a.md", "Persisted");
    captureOrphanedDraft(WORKSPACE.workspaceId, ".env", "API_KEY=shh");
    renderShell(bridge);
    await screen.findByTestId("file-tree");

    await user.click(await screen.findByTestId("notice-center-toggle"));
    await screen.findByTestId("notice-set-aside-edits");
    const marked = screen
      .getAllByTestId("recovery-list-row")
      .filter(
        (row) => within(row).queryByTestId("recovery-list-window-only") !== null,
      );
    expect(marked, "row lifetime: render the marker for every row, or for none. Either way the panel stops telling the two apart, and the user cannot see which edit the next quit destroys.").toHaveLength(1);
    expect(marked[0].textContent).toContain(".env");
    expect(marked[0].textContent).toContain("Only in this window");
  });

  // A failed save-first flush aborts the switch, the
  // workspace never leaves its version, and the recovery announcement must
  // not fire — announcing a version change reopens the live document and
  // sets the still-editable draft aside on the same version.
  it("does not set the draft aside when a failed switch never left the version", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
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
    await user.type(
      await enterMarkdownSource(user),
      "Draft!",
    );
    await screen.findByTestId("tab-dirty");

    await user.click(await screen.findByTestId("version-menu-button"));
    const item = (await screen.findAllByTestId("version-item")).find(
      (candidate) => candidate.dataset.versionId === "v2",
    );
    await user.click(item!);
    await user.click(await screen.findByTestId("version-switch-save-continue"));

    // The flush failed, the switch never started, the version never changed.
    await waitFor(() =>
      expect(bridge.writeWorkspaceText).toHaveBeenCalled(),
    );
    expect(bridge.switchWorkspaceVersion).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state"), "failed-switch announce: announce the unchanged version from performSwitch's catch. The bookkeeping reopen then sets the draft aside on the same version — the notice appears and the editor loses the text the user could just keep editing.").toBeNull(),
    );
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    expect(
      screen
        .getByTestId("markdown-editor")
        .querySelector<HTMLElement>(".cm-content")?.textContent,
    ).toContain("Draft!");
  });
});
