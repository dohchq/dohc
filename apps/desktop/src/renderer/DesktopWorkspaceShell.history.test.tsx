// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SetWorkspaceUiStatePayload } from "../ipc/bridgeContract";
import type { EngineMomentRecord, ListHistoryResult, ReadEngineMomentResult, WorkspaceUiState } from "../ipc/bridgeContract";
import { DEFAULT_WORKSPACE_SETTINGS, type WorkspaceSettingsResult } from "../workspaces/workspaceSettings";
import { rendererMarks } from "../performance/rendererMarks";
import { momentDiffTabPath, versionCompareTabPath } from "./workbench/workbenchState";
import { deferred } from "../testing/deferred";
import { historyPageFields, timelineCursor, timelinePage, type TimelinePage } from "../testing/historyPageFixture";
import type { Workspace } from "./DesktopWorkspaceShell";
import { textEditorContent } from "./FileInspector.editor-fixture";
import { DesktopWorkspaceShell, WORKSPACE, OTHER_WORKSPACE, SYNC_STATUS, STORED_STATE, storedStateWithTabs, storedTabs, makeBridge, renderShell, shellBootstrapProps, SHARE_STATUS, SHARE_VIEW, makeShareBridge, settleShareView } from "./DesktopWorkspaceShell.testHarness";

describe("history page", () => {
  it("shows a failed file read in a toast and Notices while history stays available", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const failedStatus = { ...SYNC_STATUS, fileObservationFailure: "read-failed" as const };
    bridge.openWorkspace = vi.fn(async () => failedStatus);
    bridge.getSyncStatus = vi.fn(async () => failedStatus);
    renderShell(bridge);
    const message = "dohc could not read file changes for this workspace.";
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(message);
    expect(within(toast).getByRole("button", { name: /Copy/ })).toBeTruthy();
    expect(toast.textContent).not.toContain("Restart");
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByRole("dialog", { name: "Notices" }).textContent).toContain(message);
    await userEvent.click(within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", { name: "Try again" }));
    expect(bridge.retryFileObservation).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId });
    expect(screen.queryByTestId("notice-history-recording-unavailable")).toBeNull();
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalled());
    expect(screen.queryByTestId("history-off-placeholder")).toBeNull();
    bridge.getSyncStatus.mockResolvedValue(SYNC_STATUS);
    act(() => bridge.emitWorkspaceActivity());
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Notices" }).textContent).not.toContain(message));
  });
  // The recorder failed to build. Without the status override the shell
  // mounts the engine timeline, whose every listHistory call can only
  // error. Main's status gates the surface, and the engine fetch must never
  // fire.
  it("lets the status failure gate the history surface", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const failedStatus = {
      ...SYNC_STATUS,
      historyRecordingUnavailable: true,
    };
    bridge.openWorkspace = vi.fn(async () => failedStatus);
    bridge.getSyncStatus = vi.fn(async () => failedStatus);
    const user = userEvent.setup();
    renderShell(bridge);

    // Wait for the shell's engine surfaces to mount before anything is
    // asserted, so the pins below cannot pass vacuously.
    await screen.findByTestId("titlebar-about-sidebar");

    await user.click(screen.getByTestId("activity-history"));
    const placeholder = await screen.findByTestId("history-off-placeholder");
    expect(placeholder.textContent).toContain(
      "dohc could not start recording history for this workspace.",
    );

    // Activity pushes take the no-engine refresh path too — the pin that
    // kills the recurring listHistory error loop. The residual this
    // used to name — one engine fetch firing before the first status lands —
    // is closed by the test below.
    const statusCalls = bridge.getSyncStatus.mock.calls.length;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() =>
      expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(statusCalls),
    );
    expect(bridge.listHistory).not.toHaveBeenCalled();
  });

  it("never asks a refused store for engine moments", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const refusedStatus = {
      ...SYNC_STATUS,
      historyCaptureFailed: true as const,
      engineStoreRefused: "foreign-database" as const,
    };
    bridge.openWorkspace = vi.fn(async () => refusedStatus);
    bridge.getSyncStatus = vi.fn(async () => refusedStatus);
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findByTestId("titlebar-about-sidebar");
    await user.click(screen.getByTestId("activity-history"));
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.getSyncStatus).toHaveBeenCalled());

    expect(bridge.listHistory).not.toHaveBeenCalled();
  });

  // The window before main's capture decision. The refresh runs
  // on any workspace's activity event, so it is not bounded by this
  // workspace's open resolving — and in that window `statusSaysNoRecorder`
  // reads a missing or default status as a recorder, so the engine branch
  // asked for moments main was about to refuse. The rail could not state the
  // answer either: it does not have one yet.
  it("asks for no history before main's capture decision lands", async () => {
    const FAILED_HISTORY_STATUS = {
      ...SYNC_STATUS,
      historyRecordingUnavailable: true,
    };
    const decision = deferred<typeof FAILED_HISTORY_STATUS>();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(() => decision.promise);
    // Main's answer while the build runs: the entry exists, and its recorder
    // fields are still the defaults it registered before awaiting the build.
    let decided = false;
    bridge.getSyncStatus = vi.fn(async () =>
      decided ? FAILED_HISTORY_STATUS : SYNC_STATUS,
    );
    bridge.listHistory = vi.fn(async (): Promise<never> => {
      throw new Error("Engine history is not enabled for this workspace.");
    });
    const user = userEvent.setup();
    renderShell(bridge);

    // The premise: the renderer's own read said engine-ON, and the decision
    // has not landed.
    await screen.findByTestId("titlebar-about-sidebar");
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    await user.click(screen.getByTestId("activity-history"));

    await act(async () => {
      bridge.emitWorkspaceActivity();
      await Promise.resolve();
    });
    expect(bridge.listHistory).not.toHaveBeenCalled();
    // And the rail claims nothing while it knows nothing: a placeholder here
    // would name a cause main has not established.
    expect(screen.queryByTestId("history-off-placeholder")).toBeNull();
    expect(screen.queryByTestId("history-load-failed")).toBeNull();

    // The decision lands, and it is the failure. Now the rail may speak.
    await act(async () => {
      decided = true;
      decision.resolve(FAILED_HISTORY_STATUS);
      await decision.promise;
    });
    const placeholder = await screen.findByTestId("history-off-placeholder");
    expect(placeholder.textContent).toContain(
      "dohc could not start recording history for this workspace.",
    );
    expect(bridge.listHistory).not.toHaveBeenCalled();
  });

  // The other half of that branch: a healthy workspace's history must still
  // load. Without this, holding the rail in its load state forever keeps the
  // test above green.
  it("loads history once main's capture decision says a recorder exists", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalled());
    expect(screen.queryByTestId("history-off-placeholder")).toBeNull();
  });

  // The recorder failed to build. Nothing records, and the cause is a
  // failure.
  it("names the failure, not Settings, when main says the recorder could not be built", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const failedStatus = {
      ...SYNC_STATUS,
      historyRecordingUnavailable: true,
    };
    bridge.openWorkspace = vi.fn(async () => failedStatus);
    bridge.getSyncStatus = vi.fn(async () => failedStatus);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    const placeholder = await screen.findByTestId("history-off-placeholder");
    await waitFor(() =>
      expect(placeholder.textContent).toContain(
        "dohc could not start recording history for this workspace.",
      ),
    );
  });

  // A shared view records nothing, but it reads the history its share
  // imported, an ended share included. The status is the one main really
  // produces for a shared view (historyShareView, no recorder).
  it.each([["View", "view", false], ["Edit", "edit", false], ["ended View", "view", true]] as const)(
    "lists a %s share's imported history and refreshes it on activity", async (_name, access, ended) => {
      const bridge = makeBridge(Promise.resolve(null));
      const shareStatus = { ...SYNC_STATUS, historyShareView: true };
      bridge.openWorkspace = vi.fn(async () => shareStatus);
      bridge.getSyncStatus = vi.fn(async () => shareStatus);
      bridge.listHistory = vi.fn(async () => historyPage([historyMoment("m-1", "Agent revised this line")]));
      bridge.getTryInVersionState = vi.fn(async () => { throw new Error("A shared view has no versions."); });
      const user = userEvent.setup();
      renderShell(bridge, {
        ...WORKSPACE,
        shareView: { shareId: "share-1", granterEmail: "granter@dohc.test", access, ...(ended ? { ended: true } : {}) },
      });

      await user.click(screen.getByTestId("activity-history"));
      expect(await screen.findByTestId("engine-moment-open")).toBeTruthy();
      expect(screen.queryByTestId("history-off-placeholder")).toBeNull();
      expect(bridge.listHistory).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE.workspaceId }));
      const reads = bridge.listHistory.mock.calls.length;
      await act(async () => {
        bridge.emitWorkspaceActivity();
        await Promise.resolve();
      });
      await waitFor(() => expect(bridge.listHistory.mock.calls.length).toBeGreaterThan(reads));
      // It has no versions, so the refresh asks for no try run.
      expect(bridge.getTryInVersionState).not.toHaveBeenCalled();
      expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    });

  // The one cause a shared view's history can be off for: its store is
  // refused. The line names that cause and its recovery, never a missing recorder.
  it("names a shared view's refused store instead of reading its history", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const shareStatus = { ...SYNC_STATUS, historyShareView: true, historyCaptureFailed: true as const, engineStoreRefused: "foreign-database" as const };
    bridge.openWorkspace = vi.fn(async () => shareStatus);
    bridge.getSyncStatus = vi.fn(async () => shareStatus);
    const user = userEvent.setup();
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: { shareId: "share-1", granterEmail: "granter@dohc.test", access: "view" },
    });

    await user.click(screen.getByTestId("activity-history"));
    const placeholder = await screen.findByTestId("history-off-placeholder");
    await waitFor(() => expect(placeholder.textContent).toContain("dohc cannot read this workspace's data store."));
    expect(placeholder.textContent).not.toContain("records no history");
    await act(async () => {
      bridge.emitWorkspaceActivity();
      await Promise.resolve();
    });
    expect(bridge.listHistory).not.toHaveBeenCalled();
  });


  function historyMoment(id: string, summary: string): EngineMomentRecord {
    return {
      id,
      versionId: "main",
      path: "notes/plan.md",
      recordedAtMs: 100,
      operation: "write",
      origin: "local-file",
      momentOrder: 1,
      summary,
    };
  }

  function historyPage(
    moments: EngineMomentRecord[],
    versionId = "main",
    workspaceId = WORKSPACE.workspaceId,
  ): TimelinePage {
    return timelinePage(moments.map((moment) => ({ kind: "file", moment })), { workspaceId, versionId });
  }

  // DesktopRoot keys the shell by workspace, so a switch remounts it. A history
  // answer A asked for before the switch can land after B is on screen, and it
  // must never paint there. The E2E switch spec covers this only as a smoke
  // test against the real app; here A's answer is held until B has painted.
  it("keeps a history answer workspace A asked for out of workspace B", async () => {
    const A_CONTROL = "A_CONTROL wrote the A plan";
    const A_STALE = "A_STALE answered after the switch";
    const B_ONLY = "B_ONLY wrote the B note";
    const heldA = deferred<TimelinePage>();
    let selected = WORKSPACE.workspaceId;
    let holdA = false;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(async () => {
      if (selected === OTHER_WORKSPACE.workspaceId) {
        return historyPage([historyMoment("m-b", B_ONLY)], "main", OTHER_WORKSPACE.workspaceId);
      }
      return holdA ? heldA.promise : historyPage([historyMoment("m-a", A_CONTROL)]);
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
    const user = userEvent.setup();
    const view = render(shell(WORKSPACE));

    // A's answers paint in A: the control that makes the absence below mean
    // something.
    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText(A_CONTROL)).toBeTruthy();

    // A asks again, and that answer is held.
    holdA = true;
    const readsBeforeHold = bridge.listHistory.mock.calls.length;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() =>
      expect(bridge.listHistory.mock.calls.length).toBeGreaterThan(readsBeforeHold),
    );
    const heldRead = bridge.listHistory.mock.calls.length;
    expect(bridge.listHistory).toHaveBeenNthCalledWith(
      heldRead,
      expect.objectContaining({ workspaceId: WORKSPACE.workspaceId }),
    );

    // Switch to B the way DesktopRoot does, and wait for B's own history.
    selected = OTHER_WORKSPACE.workspaceId;
    view.rerender(shell(OTHER_WORKSPACE));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText(B_ONLY)).toBeTruthy();
    expect(screen.queryByText(A_CONTROL)).toBeNull();

    // Only now does A's held answer land, and the renderer consumes it.
    await act(async () => {
      heldA.resolve(historyPage([historyMoment("m-a-stale", A_STALE)]));
      await heldA.promise;
    });
    await act(async () => {});

    expect(screen.queryByText(A_STALE)).toBeNull();
    expect(screen.queryByText(A_CONTROL)).toBeNull();
    expect(screen.getByText(B_ONLY)).toBeTruthy();
    expect(screen.getAllByTestId("engine-moment-open")).toHaveLength(1);
  });

  it("uses the admitted rename label in the row, search and diff header", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const renamed: EngineMomentRecord = { id: "rename", versionId: "main", path: "notes/b.md", recordedAtMs: 100,
      operation: "rename", origin: "local-file", momentOrder: 1 };
    bridge.listHistory = vi.fn(async () => historyPage([renamed]));
    bridge.readEngineMoment = vi.fn(async () => ({ moment: { ...renamed, beforeText: "body", afterText: "body" } }));
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId("titlebar-about-sidebar");
    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText("Renamed to b.md")).toBeTruthy();
    await user.type(screen.getByTestId("engine-history-search"), "Renamed to");
    await user.click(screen.getByTestId("engine-moment-open"));
    expect((await screen.findByTestId("engine-diff-summary")).textContent).toBe("Renamed to b.md");
  });

  it("finds a moment by an author its shortened source label leaves out", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(async () => historyPage([
      {...historyMoment("many", "Revised the plan"), authorLabels: ["You", "trip-agent", "ana@example.com", "ben@example.com"]},
      historyMoment("other", "Wrote the outline"),
    ]));
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId("titlebar-about-sidebar");
    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText("Wrote the outline")).toBeTruthy();
    expect(screen.getByText("You, trip-agent, ana@example.com and 1 more")).toBeTruthy();
    await user.type(screen.getByTestId("engine-history-search"), "ben@example.com");
    await waitFor(() => expect(screen.queryByText("Wrote the outline")).toBeNull());
    expect(screen.getByText("Revised the plan")).toBeTruthy();
  });

  it("keeps earlier History reachable when the bounded policy scan returns no rows", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn()
      .mockResolvedValueOnce({ ...historyPage([]), nextCursor: timelineCursor(80) })
      .mockResolvedValue(historyPage([historyMoment("older", "Older admitted edit")]));
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId("titlebar-about-sidebar");
    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("engine-history-load-more"));
    expect(await screen.findByText("Older admitted edit")).toBeTruthy();
    expect(screen.queryByText("No changes yet")).toBeNull();
    expect(bridge.listHistory).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: timelineCursor(80) }));
  });

  // History's first page can be all Collection changes, or miss a moment that
  // arrived with an old date. The open file still re-reads when the engine
  // records a newer file moment.
  it("re-reads the open file for a new file moment that History's first page does not show", async () => {
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(["b.md"], "b.md")));
    bridge.listWorkspaceFiles = vi.fn(async () => ({ visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "b.md", kind: "file" as const }], folders: [] }));
    const collectionChange = { kind: "collection" as const, datasetId: "00000000-0000-4000-8000-000000000001", name: "Guests", sortAtMs: 200, change: {
      revision: 1, operation: "records.create", callerReference: null, recordedAtMs: 200, approvedRevisionHash: "a".repeat(64), changesetBytes: 1, attachmentCount: 0,
    } };
    bridge.listHistory = vi.fn(async () => timelinePage([collectionChange], { workspaceId: WORKSPACE.workspaceId }));
    let latestMomentOrder = 3;
    bridge.listEngineMoments = vi.fn(async () => ({
      moments: [], nextCursor: null, latestMomentOrder, activeVersionId: "main", ...historyPageFields,
    }));
    renderShell(bridge);
    await settleShareView();
    await waitFor(() => expect(bridge.readWorkspaceText).toHaveBeenCalledWith(expect.objectContaining({ relativePath: "b.md" })));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId, limit: 1 }));
    await act(async () => {});
    const reads = bridge.readWorkspaceText.mock.calls.length;

    // Activity with no new file moment re-reads nothing.
    const asked = bridge.listEngineMoments.mock.calls.length;
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(bridge.listEngineMoments.mock.calls.length).toBeGreaterThan(asked));
    await act(async () => {});
    expect(bridge.readWorkspaceText.mock.calls.length).toBe(reads);

    latestMomentOrder = 4;
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(bridge.readWorkspaceText.mock.calls.length).toBeGreaterThan(reads));
  });

  // History can answer while the read of the newest file moment does not.
  // That read retries `updating` by itself, and a failure says so in Notices
  // with a Try again that reads again.
  function freshnessShell() {
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(["b.md"], "b.md")));
    bridge.listWorkspaceFiles = vi.fn(async () => ({ visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "b.md", kind: "file" as const }], folders: [] }));
    const state = { latestMomentOrder: 3, queued: [] as Array<"updating" | Error> };
    bridge.listEngineMoments = vi.fn(async () => {
      const next = state.queued.shift();
      if (next instanceof Error) throw next;
      return next === "updating" ? { status: "updating" as const }
        : { moments: [], nextCursor: null, latestMomentOrder: state.latestMomentOrder, activeVersionId: "main", ...historyPageFields };
    });
    renderShell(bridge);
    return { bridge, state };
  }
  async function settledReads(bridge: ReturnType<typeof makeBridge>) {
    await settleShareView();
    await waitFor(() => expect(bridge.readWorkspaceText).toHaveBeenCalledWith(expect.objectContaining({ relativePath: "b.md" })));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalled());
    await act(async () => {});
    return bridge.readWorkspaceText.mock.calls.length;
  }

  it("re-reads the open file once an updating newest-moment read answers, with no new activity", async () => {
    const { bridge, state } = freshnessShell();
    const reads = await settledReads(bridge);
    state.latestMomentOrder = 4;
    state.queued.push("updating");
    const asked = bridge.listEngineMoments.mock.calls.length;
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(bridge.listEngineMoments.mock.calls.length).toBe(asked + 2));
    await waitFor(() => expect(bridge.readWorkspaceText.mock.calls.length).toBeGreaterThan(reads));
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
  });

  // A large first open keeps capture working past the ladder. That is not a
  // failure: nothing is said, and the activity capture sends when it settles
  // reads again.
  it("says nothing while capture outlasts the newest-moment ladder, then re-reads once capture settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { bridge, state } = freshnessShell();
      const reads = await settledReads(bridge);
      state.latestMomentOrder = 4;
      state.queued.push("updating", "updating", "updating", "updating", "updating");
      const asked = bridge.listEngineMoments.mock.calls.length;
      act(() => bridge.emitWorkspaceActivity());
      await waitFor(() => expect(bridge.listEngineMoments.mock.calls.length).toBe(asked + 1));
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(bridge.listEngineMoments.mock.calls.length).toBe(asked + 5);
      await act(async () => {});
      expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
      expect(bridge.readWorkspaceText.mock.calls.length).toBe(reads);
      await userEvent.click(screen.getByTestId("notice-center-toggle"));
      expect(screen.getByRole("dialog", { name: "Notices" }).textContent)
        .not.toContain("dohc could not check whether open files changed.");
      await userEvent.click(screen.getByTestId("notice-center-toggle"));

      // Capture settles: the engine's wake arrives as workspace activity.
      act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId, pathSetChanged: false }));
      await waitFor(() => expect(bridge.readWorkspaceText.mock.calls.length).toBeGreaterThan(reads));
      expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still says so when capture has failed and the newest-moment read stays updating", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { bridge, state } = freshnessShell();
      const reads = await settledReads(bridge);
      bridge.getSyncStatus.mockResolvedValue({ ...SYNC_STATUS, historyCaptureFailed: true, engineStoreRefused: null });
      state.latestMomentOrder = 4;
      state.queued.push("updating", "updating", "updating", "updating", "updating");
      act(() => bridge.emitWorkspaceActivity());
      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
      const toast = await screen.findByTestId("workspace-shell-error");
      expect(toast.textContent).toContain("dohc could not check whether open files changed.");
      expect(toast.textContent).toContain("Recent changes are still being added to History.");
      await userEvent.click(screen.getByTestId("notice-center-toggle"));
      const notices = screen.getByRole("dialog", { name: "Notices" });
      expect(notices.textContent).toContain("dohc could not check whether open files changed.");
      await userEvent.click(within(notices).getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(bridge.readWorkspaceText.mock.calls.length).toBeGreaterThan(reads));
    } finally {
      vi.useRealTimers();
    }
  });

  // DesktopRoot keys the shell by workspace. A's newest-moment read can
  // answer after B is on screen, and must neither re-read B's open file nor
  // raise a failure there.
  it("keeps a newest-moment answer workspace A asked for out of workspace B", async () => {
    const heldA = deferred<{ status: "updating" }>();
    let holdA = false;
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(["b.md"], "b.md")));
    bridge.listWorkspaceFiles = vi.fn(async () => ({ visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "b.md", kind: "file" as const }], folders: [] }));
    bridge.getSyncStatus = vi.fn(async () => ({ ...SYNC_STATUS, historyCaptureFailed: true as const, engineStoreRefused: null }));
    let latestMomentOrder = 3;
    let readsOfA = 0;
    bridge.listEngineMoments.mockImplementation(async (payload?: { workspaceId: string }) => {
      if (payload?.workspaceId === WORKSPACE.workspaceId) readsOfA += 1;
      return payload?.workspaceId === WORKSPACE.workspaceId && holdA ? heldA.promise
        : { moments: [], nextCursor: null, latestMomentOrder, activeVersionId: "main", ...historyPageFields };
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
    await settledReads(bridge);

    holdA = true;
    const readsOfABeforeHold = readsOfA;
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(readsOfA).toBe(readsOfABeforeHold + 1));
    const readsOfABeforeAnswer = readsOfA;

    view.rerender(shell(OTHER_WORKSPACE));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenLastCalledWith({ workspaceId: OTHER_WORKSPACE.workspaceId, limit: 1 }));
    await waitFor(() => expect(bridge.readWorkspaceText).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: OTHER_WORKSPACE.workspaceId, relativePath: "b.md" })));
    await act(async () => {});
    const readsInB = bridge.readWorkspaceText.mock.calls.length;

    // A's held read answers `updating` under a failed capture: in A it would
    // retry, then report. In B it does nothing at all.
    latestMomentOrder = 9;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await act(async () => {
        heldA.resolve({ status: "updating" });
        await heldA.promise;
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    } finally {
      vi.useRealTimers();
    }
    expect(readsOfA).toBe(readsOfABeforeAnswer);
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(bridge.readWorkspaceText.mock.calls.length).toBe(readsInB);
  });

  it("says when the newest-moment read fails while History answers, and Try again re-reads the open file", async () => {
    const { bridge, state } = freshnessShell();
    const reads = await settledReads(bridge);
    state.latestMomentOrder = 4;
    state.queued.push(new Error("Error invoking remote method 'desktop:list-engine-moments': Error: engine busy"));
    act(() => bridge.emitWorkspaceActivity());
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not check whether open files changed.");
    expect(bridge.readWorkspaceText.mock.calls.length).toBe(reads);

    await userEvent.click(within(toast).getByTestId("workspace-shell-error-retry"));
    await waitFor(() => expect(bridge.readWorkspaceText.mock.calls.length).toBeGreaterThan(reads));
  });

  it("says History is hidden while its rules can't be read, and shows it again once they can", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn()
      .mockResolvedValueOnce({
        status: "policy-unreadable",
        unreadable: [".dohc/visibility.toml"],
        policyErrors: ["visibility.toml: TOML parse error at line 3, column 9"],
      } satisfies ListHistoryResult)
      .mockResolvedValue(historyPage([historyMoment("m-1", "Wrote the plan")]));
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId("titlebar-about-sidebar");
    await user.click(screen.getByTestId("activity-history"));

    const hidden = await screen.findByTestId("history-policy-hidden");
    expect(hidden.textContent).toContain(
      "dohc can't read .dohc/visibility.toml, so History is hidden. Fix the file, then try again.",
    );
    expect(hidden.textContent).not.toContain("TOML parse error");
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
    expect(screen.queryByText("No changes yet")).toBeNull();

    await user.click(within(hidden).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Wrote the plan")).toBeTruthy();
    expect(screen.queryByTestId("history-policy-hidden")).toBeNull();
  });

  it("reports a refused restore in dohc's words, and Try again asks before it restores", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const moment = historyMoment("m-1", "Wrote the plan");
    bridge.listHistory = vi.fn(async () => historyPage([moment]));
    bridge.readEngineMoment = vi.fn(async () => ({ moment: { ...moment, beforeText: "one\n", afterText: "two\n" } }));
    const restoreEngineMomentFile = vi.fn()
      .mockRejectedValueOnce(new Error(
        "Error invoking remote method 'desktop:restore-engine-moment-file': RestorePolicyRefusalError [policy-unreadable]: .dohc/visibility.toml: visibility.toml: TOML parse error at line 3, column 9",
      ))
      .mockResolvedValue({ restored: "text", restoredMomentId: "restore-1" });
    Object.assign(bridge, { restoreEngineMomentFile });
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId("titlebar-about-sidebar");
    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("engine-moment-open"));
    await user.click(await screen.findByTestId("engine-diff-restore-file"));
    await user.click(await screen.findByTestId("engine-diff-confirm-restore"));

    const toast = await screen.findByTestId("workspace-shell-error");
    // What failed is the title and what to fix is the body, so the title's
    // two-line clamp never hides the fix.
    expect(within(toast).getByText("dohc could not restore notes/plan.md")).toBeTruthy();
    expect(within(toast).getByText("It can't read .dohc/visibility.toml. Fix the file, then try again.")).toBeTruthy();
    expect(toast.textContent).not.toContain("TOML parse error");
    expect(screen.queryByTestId("engine-diff-restore-status")).toBeNull();

    // Try again reads the change again, then opens its confirm dialog
    // instead of restoring.
    const readsBefore = bridge.readEngineMoment.mock.calls.length;
    await user.click(within(toast).getByTestId("workspace-shell-error-retry"));
    expect(await screen.findByTestId("engine-diff-restore-confirm")).toBeTruthy();
    expect(bridge.readEngineMoment.mock.calls.length).toBeGreaterThan(readsBefore);
    await user.click(screen.getByTestId("engine-diff-confirm-restore"));
    await waitFor(() => expect(restoreEngineMomentFile).toHaveBeenCalledTimes(2));
    expect((await screen.findByTestId("engine-diff-restore-status")).textContent).toBe(
      "Restored the earlier state. Undo restore is available here.",
    );
    expect(screen.getByTestId("engine-diff-undo-restore")).toBeTruthy();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("keeps a hidden change's tab nameless and asks nothing when Try again finds it hidden", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const moment = historyMoment("m-1", "Wrote the plan");
    const blocked = {
      status: "policy-unreadable" as const,
      unreadable: [".dohc/visibility.toml" as const],
      policyErrors: ["visibility.toml: TOML parse error at line 3, column 9"],
    };
    let broken = false;
    bridge.listHistory = vi.fn(async (): Promise<ListHistoryResult> => broken ? blocked : historyPage([moment]));
    bridge.readEngineMoment = vi.fn(async (): Promise<ReadEngineMomentResult> => broken
      ? { ...blocked, moment: null }
      : { moment: { ...moment, beforeText: "one\n", afterText: "two\n" } });
    const restoreEngineMomentFile = vi.fn(async (): Promise<never> => {
      throw new Error(
        "Error invoking remote method 'desktop:restore-engine-moment-file': RestorePolicyRefusalError [policy-unreadable]: .dohc/visibility.toml: visibility.toml: TOML parse error at line 3, column 9",
      );
    });
    Object.assign(bridge, { restoreEngineMomentFile });
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId("titlebar-about-sidebar");
    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("engine-moment-open"));
    await user.click(await screen.findByTestId("engine-diff-restore-file"));
    await user.click(await screen.findByTestId("engine-diff-confirm-restore"));
    const toast = await screen.findByTestId("workspace-shell-error");
    const tab = screen.getByTestId("tab-dohc://moment-diff/m-1");
    expect(tab.textContent).toContain("Diff: plan.md");

    // A committed refresh hides the change while its tab is open.
    broken = true;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    expect(await screen.findByTestId("engine-diff-hidden")).toBeTruthy();
    await waitFor(() => expect(tab.textContent).toContain("History change"));

    // Try again reopens the tab, which reads the change again and finds it hidden.
    const readsBefore = bridge.readEngineMoment.mock.calls.length;
    await user.click(within(toast).getByTestId("workspace-shell-error-retry"));
    await waitFor(() => expect(bridge.readEngineMoment.mock.calls.length).toBeGreaterThan(readsBefore));
    await act(async () => {});
    expect(screen.getByTestId("engine-diff-hidden")).toBeTruthy();
    expect(screen.queryByTestId("engine-diff-restore-confirm")).toBeNull();
    expect(tab.textContent).toContain("History change");
    expect(tab.textContent).not.toContain("plan.md");
    expect(restoreEngineMomentFile).toHaveBeenCalledOnce();
  });

  it("hides an open diff when a History refresh finds the rules unreadable", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const moment = historyMoment("m-1", "Wrote the plan");
    const blocked = {
      status: "policy-unreadable" as const,
      unreadable: [".dohc/visibility.toml" as const],
      policyErrors: ["visibility.toml: TOML parse error at line 3, column 9"],
    };
    let broken = false;
    bridge.listHistory = vi.fn(async (): Promise<ListHistoryResult> => broken ? blocked : historyPage([moment]));
    bridge.readEngineMoment = vi.fn(async (): Promise<ReadEngineMomentResult> => broken
      ? { ...blocked, moment: null }
      : { moment: { ...moment, beforeText: "one\n", afterText: "two\n" } });
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId("titlebar-about-sidebar");
    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("engine-moment-open"));
    await screen.findByTestId("engine-diff-lines");
    const tab = screen.getByTestId("tab-dohc://moment-diff/m-1");
    expect(tab.textContent).toContain("Diff: plan.md");

    broken = true;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    expect(await screen.findByTestId("history-policy-hidden")).toBeTruthy();
    expect(await screen.findByTestId("engine-diff-hidden")).toBeTruthy();
    expect(screen.queryByTestId("engine-diff-lines")).toBeNull();
    expect(screen.queryByTestId("engine-diff-restore-file")).toBeNull();
    // The tab shows that a change is open, not which file it changed.
    await waitFor(() => expect(tab.textContent).not.toContain("plan.md"));
    expect(tab.textContent).toContain("History change");
  });

  it("persists a moment diff opened for a valid multibyte file path", async () => {
    const filePath = `目录/${"界".repeat(500)}.md`;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(async () =>
      historyPage([{ ...historyMoment("m-1", "Wrote the file"), path: filePath }]),
    );
    const validStates: WorkspaceUiState[] = [];
    bridge.setWorkspaceUiState.mockImplementation(async (payload) => {
      validStates.push(SetWorkspaceUiStatePayload.parse(payload).state);
    });
    const user = userEvent.setup();
    renderShell(bridge);
    await settleShareView();

    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("engine-moment-open"));
    const tabPath = momentDiffTabPath("m-1");
    await screen.findByTestId("tab-dohc://moment-diff/m-1");
    fireEvent(window, new Event("beforeunload"));

    await waitFor(() =>
      expect(
        validStates.some((state) =>
          storedTabs(state).includes(tabPath),
        ),
      ).toBe(true),
    );
    expect(filePath.length).toBeLessThanOrEqual(4096);
    expect(encodeURIComponent(filePath).length).toBeGreaterThan(4096);
  });

  // The ladder itself is the hook's (useHistoryPage.test.tsx). This pins the
  // surface it leaves behind: a line with no control and no global error,
  // kept through the next activity's read until its page replaces it.
  it("stops retrying an updating history and keeps its line until a page arrives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const bridge = makeBridge(Promise.resolve(null));
      bridge.listHistory = vi.fn(
        async (): Promise<ListHistoryResult> => ({ status: "updating" }),
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderShell(bridge);

      await user.click(screen.getByTestId("activity-history"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(bridge.listHistory).toHaveBeenCalledTimes(5);
      const line = await screen.findByTestId("history-updating");
      expect(line.textContent).toBe("Adding recent changes to History");
      expect(line.getAttribute("role")).toBe("status");
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

      const next = deferred<ListHistoryResult>();
      bridge.listHistory.mockImplementation(() => next.promise);
      act(() => bridge.emitWorkspaceActivity());
      await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(6));
      expect(screen.getByTestId("history-updating")).toBe(line);

      await act(async () => {
        next.resolve(historyPage([historyMoment("m-1", "Wrote the plan")]));
        await next.promise;
      });
      expect(await screen.findByTestId("engine-moment-open")).toBeTruthy();
      expect(screen.queryByTestId("history-updating")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // While main's status says History is paused, the panel says so: in place
  // of taking in changes, and above the rows a read still answers, which may
  // be missing changes. The line goes with the pause.
  it("says History is paused in place of updating and above a paused page's rows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const bridge = makeBridge(Promise.resolve(null));
      const paused = { ...SYNC_STATUS, historyCaptureFailed: true as const, engineStoreRefused: null };
      bridge.openWorkspace = vi.fn(async () => paused);
      bridge.getSyncStatus = vi.fn(async () => paused);
      bridge.listHistory = vi.fn(
        async (): Promise<ListHistoryResult> => ({ status: "updating" }),
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderShell(bridge);

      await user.click(screen.getByTestId("activity-history"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      const line = await screen.findByTestId("history-paused");
      expect(line.textContent).toBe("History paused");
      expect(screen.queryByTestId("history-updating")).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

      bridge.listHistory.mockResolvedValue(historyPage([historyMoment("m-1", "Wrote the plan")]));
      act(() => bridge.emitWorkspaceActivity());
      const row = await screen.findByTestId("engine-moment-open");
      const heading = screen.getByTestId("history-paused");
      expect(heading.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      bridge.getSyncStatus.mockResolvedValue(SYNC_STATUS);
      act(() => bridge.emitWorkspaceActivity());
      await waitFor(() => expect(screen.queryByTestId("history-paused")).toBeNull());
      expect(screen.getByTestId("engine-moment-open")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // A pause can end before History answers a page: the panel goes back to
  // taking in changes with no click, then the page replaces the line.
  it("goes back to taking in changes when the pause ends before a page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const bridge = makeBridge(Promise.resolve(null));
      const paused = { ...SYNC_STATUS, historyCaptureFailed: true as const, engineStoreRefused: null };
      bridge.openWorkspace = vi.fn(async () => paused);
      bridge.getSyncStatus = vi.fn(async () => paused);
      bridge.listHistory = vi.fn(
        async (): Promise<ListHistoryResult> => ({ status: "updating" }),
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderShell(bridge);

      await user.click(screen.getByTestId("activity-history"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      await screen.findByTestId("history-paused");

      bridge.getSyncStatus.mockResolvedValue(SYNC_STATUS);
      act(() => bridge.emitWorkspaceActivity());
      const line = await screen.findByTestId("history-updating");
      expect(line.textContent).toBe("Adding recent changes to History");
      expect(screen.queryByTestId("history-paused")).toBeNull();

      bridge.listHistory.mockResolvedValue(historyPage([historyMoment("m-1", "Wrote the plan")]));
      act(() => bridge.emitWorkspaceActivity());
      expect(await screen.findByTestId("engine-moment-open")).toBeTruthy();
      expect(screen.queryByTestId("history-updating")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // A pause does not hide a read that really failed: it keeps its words and
  // Try again, and the page Try again reads still starts with the line.
  it("keeps a real failure's words and Try again while History is paused", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const paused = { ...SYNC_STATUS, historyCaptureFailed: true as const, engineStoreRefused: null };
    bridge.openWorkspace = vi.fn(async () => paused);
    bridge.getSyncStatus = vi.fn(async () => paused);
    bridge.listHistory = vi.fn(async (): Promise<ListHistoryResult> => {
      throw new Error("history failed");
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    const failed = await screen.findByTestId("history-load-failed");
    expect(failed.textContent).toContain("dohc could not load this workspace's history.");
    expect(screen.queryByTestId("history-paused")).toBeNull();

    bridge.listHistory.mockResolvedValue(historyPage([historyMoment("m-1", "Wrote the plan")]));
    await user.click(within(failed).getByRole("button", { name: "Try again" }));
    const row = await screen.findByTestId("engine-moment-open");
    const heading = screen.getByTestId("history-paused");
    expect(heading.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows complete protected paging without a truncation banner", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(async () => ({
      ...historyPage([historyMoment("m-1", "Wrote the plan")]),

    }));
    const user = userEvent.setup();
    renderShell(bridge);
    await settleShareView();

    await user.click(screen.getByTestId("activity-history"));

    expect(await screen.findByText("Wrote the plan")).toBeTruthy();
    expect(screen.queryByText("Some protected activity in this range is not shown.")).toBeNull();
  });

  it("keeps a moment diff selected when an older duplicate-file open finishes flushing", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          { id: "left", tabs: ["b.md"], activeTab: "b.md", size: 0.5 },
          {
            id: "right",
            tabs: ["race-a.txt"],
            activeTab: "race-a.txt",
            size: 0.5,
          },
        ],
        activeEditorGroup: "right",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({ visibility: { status: "ready" as const, rules: [] },
      files: ["race-a.txt", "b.md"].map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    }));
    bridge.listHistory = vi.fn(async () =>
      historyPage([historyMoment("m-1", "Wrote the plan")]),
    );
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    const user = userEvent.setup();
    renderShell(bridge);
    await settleShareView();

    const left = await screen.findByRole("region", { name: "Editor group 1" });
    const right = screen.getByRole("region", { name: "Editor group 2" });
    const content = await textEditorContent(await within(right).findByTestId("view-text-editor"));
    await user.click(content);
    await user.keyboard("{End} changed");
    await waitFor(() => expect(within(right).getByTestId("tab-dirty")).toBeTruthy());

    fireEvent.pointerDown(left);
    await waitFor(() => expect(left.dataset.active).toBe("true"));
    await user.click(
      screen
        .getAllByTestId("tree-row")
        .find((row) => row.dataset.path === "race-a.txt")!,
    );
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(1));

    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("engine-moment-open"));

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });

    const momentPath = momentDiffTabPath("m-1");
    await waitFor(() =>
      expect(within(left).getByTestId("tab-dohc://moment-diff/m-1").dataset.active).toBe(
        "true",
      ),
    );
    expect(within(left).getByRole("tab", { name: "Diff: plan.md" }).title).toBe(
      "History diff: notes/plan.md",
    );
    await user.click(screen.getByTestId("activity-explorer"));
    const openMoment = screen
      .getAllByTestId("open-editor-row")
      .find((row) => row.dataset.path === momentPath);
    expect(openMoment?.textContent).toContain("Diff: plan.md");
    expect(left.dataset.active).toBe("true");
    expect(within(left).queryByTestId("tab-race-a.txt")).toBeNull();
  });

  it("keeps a newer file selected when an older moment-diff flush finishes", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["race-a.txt", "b.md"], "race-a.txt")),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({ visibility: { status: "ready" as const, rules: [] },
      files: ["race-a.txt", "b.md"].map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    }));
    bridge.listHistory = vi.fn(async () =>
      historyPage([historyMoment("m-1", "Wrote the plan")]),
    );
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    const user = userEvent.setup();
    renderShell(bridge);
    await settleShareView();

    const group = await screen.findByRole("region", { name: "Editor group 1" });
    const content = await textEditorContent(await within(group).findByTestId("view-text-editor"));
    await user.click(content);
    await user.keyboard("{End} changed");
    await waitFor(() => expect(within(group).getByTestId("tab-dirty")).toBeTruthy());

    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("engine-moment-open"));
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(1));

    await user.click(within(group).getByTestId("tab-b.md"));
    expect(within(group).getByTestId("tab-b.md").dataset.active).toBe("true");

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });

    await waitFor(() =>
      expect(within(group).getByTestId("tab-b.md").dataset.active).toBe("true"),
    );
    expect(
      within(group).queryByTestId(
        "tab-dohc://moment-diff/m-1",
      ),
    ).toBeNull();
  });

  it("does not open a moment after its target group closes during the draft flush", async () => {
    const save = deferred<{ status: "written"; contentHash: string }>();
    const bridge = makeBridge(
      Promise.resolve({
        ...STORED_STATE,
        editorGroups: [
          { id: "left", tabs: ["a.md"], activeTab: "a.md", size: 0.5 },
          {
            id: "right",
            tabs: ["dirty.txt"],
            activeTab: "dirty.txt",
            size: 0.5,
          },
        ],
        activeEditorGroup: "right",
      }),
    );
    bridge.listWorkspaceFiles = vi.fn(async () => ({ visibility: { status: "ready" as const, rules: [] },
      files: ["a.md", "dirty.txt"].map((path) => ({
        path,
        kind: "file" as const,
      })),
      folders: [],
    }));
    bridge.listHistory = vi.fn(async () =>
      historyPage([historyMoment("m-1", "Wrote the plan")]),
    );
    bridge.writeWorkspaceText = vi.fn(() => save.promise);
    const user = userEvent.setup();
    renderShell(bridge);
    await settleShareView();

    const left = await screen.findByRole("region", { name: "Editor group 1" });
    const right = screen.getByRole("region", { name: "Editor group 2" });
    const content = await textEditorContent(await within(right).findByTestId("view-text-editor"));
    await user.click(content);
    await user.keyboard("{End} changed");
    await waitFor(() => expect(within(right).getByTestId("tab-dirty")).toBeTruthy());

    fireEvent.pointerDown(left);
    await waitFor(() => expect(left.dataset.active).toBe("true"));
    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("engine-moment-open"));
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(1));

    await user.click(within(left).getByRole("button", { name: "Close a.md" }));
    await waitFor(() =>
      expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(1),
    );

    await act(async () => {
      save.resolve({ status: "written", contentHash: "b".repeat(64) });
      await save.promise;
    });

    expect(
      screen.queryByTestId("tab-dohc://moment-diff/m-1"),
    ).toBeNull();
    expect(screen.getByRole("region", { name: "Editor group 1" })).toBe(right);
  });

  // Page ordering, held refreshes and pagination admission are the hook's
  // (useHistoryPage.test.tsx). The shell owes the readiness mark to the page
  // that commits, and the Show earlier changes control to the hook's cursor.
  it("marks history ready when the page commits, and appends the earlier page", async () => {
    const previousOrdinal = rendererMarks.readSwitchTimeline().at(-1)?.ordinal ?? 0;
    const first = deferred<TimelinePage>();
    const earlier = deferred<TimelinePage>();
    const pages = [first, earlier];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => pages[issued++]!.promise);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage([historyMoment("m-first", "Added the launch checklist")]),
        nextCursor: timelineCursor(1),
      });
      await first.promise;
    });
    expect(await screen.findByText("Added the launch checklist")).toBeTruthy();
    await waitFor(() => {
      const timeline = rendererMarks
        .readSwitchTimeline()
        .find((entry) => entry.ordinal > previousOrdinal);
      expect(timeline?.phases["history-ready"]).toEqual(expect.any(Number));
    });

    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    expect(bridge.listHistory).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      limit: 50,
      cursor: timelineCursor(1),
    });
    // The earlier page still has a cursor, so the control stays and is
    // usable again once the page lands.
    await act(async () => {
      earlier.resolve({
        ...historyPage([historyMoment("m-earlier", "Started the plan")]),
        nextCursor: timelineCursor(0),
      });
      await earlier.promise;
    });

    expect(await screen.findByText("Started the plan")).toBeTruthy();
    expect(screen.getByText("Added the launch checklist")).toBeTruthy();
    const loadMore = screen.getByTestId("engine-history-load-more");
    await waitFor(() => expect(loadMore.hasAttribute("disabled")).toBe(false));
  });

  // A pagination failure about the displayed timeline reaches the notices.
  it("reports a pagination that failed for the timeline on screen", async () => {
    const first = deferred<TimelinePage>();
    let failPage!: (error: Error) => void;
    const page = new Promise<never>((_resolve, reject) => {
      failPage = reject;
    });
    const responses: Promise<TimelinePage>[] = [first.promise, page];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage([historyMoment("m-first", "Added the launch checklist")]),
        nextCursor: timelineCursor(1),
      });
      await first.promise;
    });
    expect(await screen.findByText("Added the launch checklist")).toBeTruthy();

    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    await act(async () => {
      failPage(new Error("pagination failed"));
      await Promise.resolve();
    });

    expect(await screen.findByTestId("workspace-shell-error")).toBeTruthy();
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
      "Could not load earlier history.",
    );
    expect(screen.getByText("Added the launch checklist")).toBeTruthy();
  });

  const REVIEW_STATE = {
    status: "review" as const,
    task: "Draft the launch note",
    versionId: "try-1",
    versionName: "Try: launch note",
    runId: "run-1",
    startedAtMs: 10,
    endedAtMs: 20,
    runOutcome: "complete" as const,
    changedFileCount: 1,
    mergeAvailable: false,
  };

  // The held answer is a TIMELINE answer. Holding the whole response would
  // republish snapshots the user has acted on since — here the review card the
  // main process already dismissed, which nothing else would clear.
  it("does not bring back a review the user dismissed while a page was loading", async () => {
    const first = deferred<TimelinePage>();
    const refreshed = deferred<TimelinePage>();
    let failPage!: (error: Error) => void;
    const page = new Promise<never>((_resolve, reject) => {
      failPage = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      first.promise,
      refreshed.promise,
      page,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    // The main process keeps reporting the review until it is dismissed.
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage([historyMoment("m-first", "Added the launch checklist")]),
        nextCursor: timelineCursor(1),
      });
      await first.promise;
    });
    expect(await screen.findByTestId("try-review-card")).toBeTruthy();

    // A refresh answers while a pagination is in flight, so it is held — and
    // the response it carries still contains the review.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(3));
    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });

    // The user dismisses the review.
    await user.click(screen.getByTestId("try-review-keep-working"));
    await waitFor(() => expect(bridge.dismissTryInVersionReview).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("try-review-card")).toBeNull());

    // The pagination fails, so the held TIMELINE answer commits — and only it.
    await act(async () => {
      failPage(new Error("pagination failed"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Rewrote the plan")).toBeTruthy();
    expect(screen.queryByTestId("try-review-card")).toBeNull();
  });

  // One layer deeper: the dismissal happens while the refresh is still in
  // flight. Counting only responses, that refresh is still the newest thing
  // the snapshot watermark has seen, so its status half would undo an action
  // the user took after it was issued — and nothing would put the card away
  // again, because dismissing emits no replacement activity.
  it("does not bring back a review dismissed while the refresh was still in flight", async () => {
    const first = deferred<TimelinePage>();
    const refreshed = deferred<TimelinePage>();
    let failPage!: (error: Error) => void;
    const page = new Promise<never>((_resolve, reject) => {
      failPage = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      first.promise,
      refreshed.promise,
      page,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    // The main process keeps reporting the review until it is dismissed.
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage([historyMoment("m-first", "Added the launch checklist")]),
        nextCursor: timelineCursor(1),
      });
      await first.promise;
    });
    expect(await screen.findByTestId("try-review-card")).toBeTruthy();

    // A refresh is out — its try-state half has already answered, carrying the
    // review — and a newer pagination is out behind it.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(bridge.getTryInVersionState).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(3));

    // The user dismisses the card while both are still in flight.
    await user.click(screen.getByTestId("try-review-keep-working"));
    await waitFor(() => expect(bridge.dismissTryInVersionReview).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("try-review-card")).toBeNull());

    // Now let everything settle: the refresh answers, and the pagination fails
    // so the held timeline commits.
    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });
    await act(async () => {
      failPage(new Error("pagination failed"));
      await Promise.resolve();
    });

    // The timeline still lands — only the snapshot the user overruled is gone.
    expect(await screen.findByText("Rewrote the plan")).toBeTruthy();
    expect(screen.queryByTestId("try-review-card")).toBeNull();
  });

  // A version switch changes which timeline is true, so it is a boundary: an
  // answer describing the version the user left must never paint the one they
  // are now on, however the newest-answer race would otherwise resolve.
  it("never paints the version the user left over the one they switched to", async () => {
    const first = deferred<TimelinePage>();
    const staleRefresh = deferred<TimelinePage>();
    const stalePage = deferred<TimelinePage>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      first.promise,
      staleRefresh.promise,
      stalePage.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    // The workspace reports the try version until the switch runs, Main after.
    let switched = false;
    bridge.listWorkspaceVersions = vi.fn(async () => ({
      versions: [
        {
          id: "main",
          name: "Main",
          kind: "main" as const,
          createdAtMs: 0,
          canMergeIntoMain: false,
        },
      ],
      activeVersionId: switched ? "main" : "try-1", ...historyPageFields,
    }));
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", ...historyPageFields, changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage(
          [historyMoment("m-first", "Wrote the note in the try version")],
          "try-1",
        ),
        nextCursor: timelineCursor(1),
      });
      await first.promise;
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    // A refresh and a pagination are both in flight when the user leaves.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(3));

    // Set aside: switch back to Main. Its own refresh fails, so nothing newer
    // ever answers — exactly when the stale answers would win.
    await user.click(screen.getByTestId("try-review-set-aside"));
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(4));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    // Both answers from the version the user left arrive too late to matter.
    await act(async () => {
      staleRefresh.resolve(
        historyPage(
          [historyMoment("m-stale", "Edited the note in the try version")],
          "try-1",
        ),
      );
      await staleRefresh.promise;
    });
    await act(async () => {
      stalePage.resolve(
        historyPage(
          [historyMoment("m-stale-page", "Started the try version")],
          "try-1",
        ),
      );
      await stalePage.promise;
    });

    expect(screen.queryByText("Edited the note in the try version")).toBeNull();
    expect(screen.queryByText("Started the try version")).toBeNull();
  });

  // The other side of that boundary. Main notifies the renderer before the
  // switch invoke resolves, so an activity refresh can be issued for the new
  // version before the shell hears about the switch at all. The switch's own
  // refresh supersedes it: only the newest refresh may answer, so when that
  // one fails the panel says so and Try again reads Main.
  it("lets the switch's own refresh supersede an earlier one, and recovers through Try again", async () => {
    const first = deferred<TimelinePage>();
    const earlyRefresh = deferred<TimelinePage>();
    const retry = deferred<TimelinePage>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      first.promise,
      earlyRefresh.promise,
      switchRefresh,
      retry.promise,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    let switched = false;
    bridge.listWorkspaceVersions = vi.fn(async () => ({
      versions: [
        {
          id: "main",
          name: "Main",
          kind: "main" as const,
          createdAtMs: 0,
          canMergeIntoMain: false,
        },
      ],
      activeVersionId: switched ? "main" : "try-1", ...historyPageFields,
    }));
    // The switch lands in the daemon and notifies the renderer before the
    // invoke resolves, which is the ordering this test exists for.
    const switchInvoke = deferred<void>();
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      bridge.emitWorkspaceActivity();
      await switchInvoke.promise;
      return { activeVersionId: "main", ...historyPageFields, changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve(
        historyPage([historyMoment("m-first", "Wrote the note in the try version")], "try-1"),
      );
      await first.promise;
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    // Set aside: the daemon switches and notifies, so the activity refresh for
    // MAIN is issued before the switch invoke resolves — and it is still in
    // flight when the shell finally hears about the switch.
    await user.click(screen.getByTestId("try-review-set-aside"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));

    // The switch resolves, the shell runs its boundary, and its own refresh
    // fails.
    await act(async () => {
      switchInvoke.resolve();
      await switchInvoke.promise;
    });
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(3));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    // The superseded early refresh answers last. It paints nothing.
    await act(async () => {
      earlyRefresh.resolve(
        historyPage([historyMoment("m-early", "Back on main")], "main"),
      );
      await earlyRefresh.promise;
    });
    expect(screen.queryByText("Back on main")).toBeNull();
    expect(screen.queryByText("Wrote the note in the try version")).toBeNull();
    await user.click(within(screen.getByTestId("history-load-failed")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(4));
    await act(async () => {
      retry.resolve(historyPage([historyMoment("m-main", "Back on main")], "main"));
      await retry.promise;
    });
    expect(await screen.findByText("Back on main")).toBeTruthy();
  });

  // The boundary has to name the version the user left, and before the first
  // page commits the panel displays none. Inferring that version from the
  // timeline left the guard with nothing to reject, so the answer describing
  // the version they had already left painted the panel — and stayed there
  // when the post-switch refresh failed.
  it("rejects the version the user left before the timeline committed one", async () => {
    const stranded = deferred<TimelinePage>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      stranded.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    let switched = false;
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
          id: "try-1",
          name: "Try: launch note",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: switched ? "main" : "try-1", ...historyPageFields,
    }));
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", ...historyPageFields, changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    // The first page is still in flight, so the panel knows no version of its
    // own when the user leaves this one.
    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());

    // The switch's own refresh fails, so nothing newer ever answers — exactly
    // when the stranded answer would win.
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    await act(async () => {
      stranded.resolve(
        historyPage(
          [historyMoment("m-stranded", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await stranded.promise;
    });

    expect(screen.queryByText("Wrote the note in the try version")).toBeNull();
  });

  // A boundary anyone has to await is not a boundary. When the old version's
  // answer lands first, it meets a guard that knows nothing, commits, and
  // whatever arrives later cannot retract it — so a failed switch-triggered
  // refresh left the previous version's moments on screen. Two awaits used to
  // sit in front of the announcement: the shell's own lookup, and the
  // selector's post-switch re-read. Neither answers here.
  it("rejects the old version's answer without waiting for a lookup", async () => {
    const stranded = deferred<TimelinePage>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      stranded.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    let switched = false;
    // Only the selector's mount read answers. Every later read hangs forever:
    // the shell's own lookup if it still needed one, AND the selector's
    // post-switch re-read — so a boundary announced after either of them is a
    // boundary that never arrives.
    const hungLookup = new Promise<never>(() => {});
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(() => {
      versionReads += 1;
      if (versionReads > 1) return hungLookup;
      return Promise.resolve({
        versions: [
          {
            id: "main",
            name: "Main",
            kind: "main" as const,
            createdAtMs: 0,
            canMergeIntoMain: false,
          },
          {
            id: "try-1",
            name: "Try: launch note",
            kind: "named" as const,
            createdAtMs: 1,
            canMergeIntoMain: true,
          },
        ],
        activeVersionId: switched ? "main" : "try-1", ...historyPageFields,
      });
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", ...historyPageFields, changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));

    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });
    await act(async () => {
      stranded.resolve(
        historyPage(
          [historyMoment("m-stranded", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await stranded.promise;
    });

    expect(screen.queryByText("Wrote the note in the try version")).toBeNull();
  });

  // The residual window: a switch that failed, whose recovery re-read
  // also failed, leaves the shell asking which version is active. The
  // old-version answer lands before that lookup does, but the switch's own
  // refresh superseded it, so it paints nothing even though that refresh
  // failed. The lookup then finds no page to drop and asks nothing.
  it("never paints an old-version answer the switch's failed refresh superseded", async () => {
    const stranded = deferred<TimelinePage>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      stranded.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    const versionList = [
      {
        id: "main",
        name: "Main",
        kind: "main" as const,
        createdAtMs: 0,
        canMergeIntoMain: false,
      },
      {
        id: "try-1",
        name: "Try: launch note",
        kind: "named" as const,
        createdAtMs: 1,
        canMergeIntoMain: true,
      },
    ];
    // Read 1 is the selector's mount read. Read 2 is its recovery re-read
    // after the failed switch — it fails too, so nobody can name the active
    // version and the shell has to ask. Read 3 is that lookup, held open.
    // Later reads (the re-key refresh) hang: nothing else may answer.
    const lookup = deferred<{
      versions: typeof versionList;
      activeVersionId: string;
    }>();
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(() => {
      versionReads += 1;
      if (versionReads === 1) {
        return Promise.resolve({ versions: versionList, activeVersionId: "try-1" });
      }
      if (versionReads === 2) return Promise.reject(new Error("recovery read failed"));
      if (versionReads === 3) return lookup.promise;
      return new Promise<never>(() => {});
    });
    // The switch failed — but it partially applied, so the workspace really
    // is on Main; only the lookup can say so.
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      throw new Error("switch failed");
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() =>
      expect(bridge.listWorkspaceVersions.mock.calls.length).toBeGreaterThanOrEqual(3),
    );

    // The switch-triggered refresh fails: nothing newer will answer on its own.
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    // The old version's answer lands while the lookup is still in flight.
    await act(async () => {
      stranded.resolve(
        historyPage(
          [historyMoment("m-stranded", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await stranded.promise;
    });
    expect(screen.queryByText("Wrote the note in the try version")).toBeNull();
    expect(screen.getByTestId("history-load-failed")).toBeTruthy();

    await act(async () => {
      lookup.resolve({ versions: versionList, activeVersionId: "main" });
      await lookup.promise;
    });
    expect(screen.queryByText("Wrote the note in the try version")).toBeNull();
    expect(bridge.listHistory).toHaveBeenCalledTimes(2);
  });

  // The other verdict the lookup can reach: it agrees with the committed page
  // (the failed switch never applied). Dropping here would blank a timeline
  // that is right — and this is every merge and conflict resolution, whose
  // lookup only restates what is already true.
  it("keeps the committed page when the failed-switch lookup agrees with it", async () => {
    const stranded = deferred<TimelinePage>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      stranded.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    const versionList = [
      {
        id: "main",
        name: "Main",
        kind: "main" as const,
        createdAtMs: 0,
        canMergeIntoMain: false,
      },
      {
        id: "try-1",
        name: "Try: launch note",
        kind: "named" as const,
        createdAtMs: 1,
        canMergeIntoMain: true,
      },
    ];
    const lookup = deferred<{
      versions: typeof versionList;
      activeVersionId: string;
    }>();
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(() => {
      versionReads += 1;
      if (versionReads === 1) {
        return Promise.resolve({ versions: versionList, activeVersionId: "try-1" });
      }
      if (versionReads === 2) return Promise.reject(new Error("recovery read failed"));
      if (versionReads === 3) return lookup.promise;
      return new Promise<never>(() => {});
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      throw new Error("switch failed");
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      stranded.resolve(
        historyPage(
          [historyMoment("m-stranded", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await stranded.promise;
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() =>
      expect(bridge.listWorkspaceVersions.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    // A failed refresh keeps the rows on screen.
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    // The switch never applied: the lookup names the version the page already
    // describes. Nothing is dropped and nothing is re-fetched.
    await act(async () => {
      lookup.resolve({ versions: versionList, activeVersionId: "try-1" });
      await lookup.promise;
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();
    expect(bridge.listHistory).toHaveBeenCalledTimes(2);
  });

  // The judge must know when court is over: a lookup that settles after the
  // shell unmounted judges nothing. Without the committed-watermark half of
  // the staleness question, a contradicting late lookup would drop state and
  // fire four IPC reads for a workspace the user already left — the renderer
  // async-state invariant.
  it("a lookup that settles after unmount drops nothing and asks nothing", async () => {
    const stranded = deferred<TimelinePage>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      stranded.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    const versionList = [
      {
        id: "main",
        name: "Main",
        kind: "main" as const,
        createdAtMs: 0,
        canMergeIntoMain: false,
      },
      {
        id: "try-1",
        name: "Try: launch note",
        kind: "named" as const,
        createdAtMs: 1,
        canMergeIntoMain: true,
      },
    ];
    const lookup = deferred<{
      versions: typeof versionList;
      activeVersionId: string;
    }>();
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(() => {
      versionReads += 1;
      if (versionReads === 1) {
        return Promise.resolve({ versions: versionList, activeVersionId: "try-1" });
      }
      if (versionReads === 2) return Promise.reject(new Error("recovery read failed"));
      if (versionReads === 3) return lookup.promise;
      return new Promise<never>(() => {});
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      throw new Error("switch failed");
    });
    const user = userEvent.setup();
    const view = renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() =>
      expect(bridge.listWorkspaceVersions.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });
    await act(async () => {
      stranded.resolve(
        historyPage(
          [historyMoment("m-stranded", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await stranded.promise;
    });

    // The user leaves while the lookup is still in flight.
    view.unmount();

    // The lookup settles, contradicting the page the shell once displayed.
    // Nothing may happen: no drop, and above all no re-fetch for a shell
    // that is gone.
    await act(async () => {
      lookup.resolve({ versions: versionList, activeVersionId: "main" });
      await lookup.promise;
      await Promise.resolve();
    });
    expect(bridge.listHistory).toHaveBeenCalledTimes(2);
  });

  // A null page is not "no changes". Before the first read answers, the
  // surface knows nothing, and it may claim neither an empty workspace nor a
  // failure. The moment the read answers with an empty timeline, the empty
  // copy is earned.
  it("claims neither empty nor failed until the first read answers", async () => {
    const first = deferred<TimelinePage>();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => first.promise);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalled());
    expect(screen.queryByText("No changes yet")).toBeNull();
    expect(screen.queryByTestId("history-load-failed")).toBeNull();

    await act(async () => {
      first.resolve(historyPage([]));
      await first.promise;
    });
    expect(await screen.findByText("No changes yet")).toBeTruthy();
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
  });

  // One refresh issues four reads, and they answer four different
  // questions. Awaiting them as one batch made the timeline report a failure
  // that happened somewhere else — the engine had already served the page.
  // The failure is still reported; it is reported about the read that had it.
  it("keeps the history page a sibling read's failure never touched", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(async () =>
      historyPage([historyMoment("m-1", "Wrote the plan")]),
    );
    bridge.getTryInVersionState = vi.fn(() =>
      Promise.reject(new Error("try state failed")),
    );
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText("Wrote the plan")).toBeTruthy();
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
    expect(screen.queryByText("No changes yet")).toBeNull();
    // Three lanes share one banner, so the sentence has to say which one went
    // stale — the cause alone names none of them — and it has to offer the way
    // back that the rendered timeline has just hidden.
    const banner = await screen.findByTestId("workspace-shell-error");
    expect(banner.textContent).toContain(
      "dohc could not refresh this workspace's try run.",
    );
    expect(banner.textContent).toContain("try state failed");
    expect(screen.getByTestId("workspace-shell-error-retry")).toBeTruthy();
  });

  // The reverse path, end to end. Separating the lanes took one away: a
  // sibling that fails while the page succeeds renders the timeline, and the
  // timeline hides History's Try again — so the only control that could reach
  // this read is the one on the banner. It has to work, not just be there.
  it("asks the failed lane again from the banner", async () => {
    const syncingStatus = { ...SYNC_STATUS, state: "syncing" as const };
    let nextStatus: typeof SYNC_STATUS | typeof syncingStatus = SYNC_STATUS;
    let failNextRead = false;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(async () =>
      historyPage([historyMoment("m-1", "Wrote the plan")]),
    );
    bridge.getSyncStatus = vi.fn(() => {
      if (failNextRead) {
        failNextRead = false;
        return Promise.reject(new Error("sync status failed"));
      }
      return Promise.resolve(nextStatus);
    });
    const user = userEvent.setup();
    renderShell(bridge);

    const treeRows = await screen.findAllByTestId("tree-row");
    await user.click(treeRows.find((row) => row.textContent?.includes("a.md"))!);
    await screen.findByTestId("tab-a.md");
    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText("Wrote the plan")).toBeTruthy();

    failNextRead = true;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(failNextRead).toBe(false));

    // The page renders, so History's own retry is not on screen. The banner
    // names the lane and carries the only way back.
    const banner = await screen.findByTestId("workspace-shell-error");
    expect(banner.textContent).toContain("dohc could not refresh sync status.");
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
    expect(screen.getByText("Wrote the plan")).toBeTruthy();

    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getAllByRole("region", { name: /Editor group/ })).toHaveLength(2),
    );
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
      "dohc could not refresh sync status.",
    );
    expect(screen.getByTestId("workspace-shell-error-retry")).toBeTruthy();

    // The workspace moved on while the lane was stale.
    nextStatus = syncingStatus;
    await user.click(screen.getByTestId("workspace-shell-error-retry"));

    await waitFor(() =>
      expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing"),
    );
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // Independent of each other's SUCCESS is only half of it. A refresh that
  // waits for all four answers before handling any of them is hostage to the
  // slowest lane: a history read that already failed would sit in
  // "Loading history..." behind a sibling that never settles, with no failure
  // and no way to ask again — worse than the batch it replaced, which at
  // least gave up as soon as history did.
  it("says the history read failed while a sibling read never settles", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => Promise.reject(new Error("history failed")));
    bridge.getSyncStatus = vi.fn(() => new Promise<never>(() => {}));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByTestId("history-load-failed")).toBeTruthy();
    // The Next has to be there too, not just the sentence.
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Loading history...")).toBeNull();
  });

  // The mirror: a page the engine already served is nobody's hostage either.
  it("shows the history page while a sibling read never settles", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(async () =>
      historyPage([historyMoment("m-1", "Wrote the plan")]),
    );
    bridge.getTryInVersionState = vi.fn(() => new Promise<never>(() => {}));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText("Wrote the plan")).toBeTruthy();
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
  });

  // The same rule read the other way: the history read is nobody else's
  // answer either. A try session the main process reported still reaches its
  // card while the timeline says it could not load.
  it("shows the try review a failed history read did not answer for", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => Promise.reject(new Error("history failed")));
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByTestId("history-load-failed")).toBeTruthy();
    expect(await screen.findByTestId("try-review-card")).toBeTruthy();
  });

  // A retry that still shows the failure it is retrying gives the user no
  // sign it took, and would keep offering the button while a read is already
  // on its way. Issuing a read says the surface does not know again — the
  // same thing the first load says.
  it("the retry shows a read on the way, not the failure it is retrying", async () => {
    let failFirst!: (error: Error) => void;
    const first = new Promise<never>((_resolve, reject) => {
      failFirst = reject;
    });
    const second = deferred<TimelinePage>();
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => (++issued === 1 ? first : second.promise));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      failFirst(new Error("history failed"));
      await Promise.resolve();
    });
    expect(await screen.findByTestId("history-load-failed")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
    expect(screen.getByText("Loading history...")).toBeTruthy();

    await act(async () => {
      second.resolve(historyPage([historyMoment("m-1", "Wrote the plan")]));
      await second.promise;
    });
    expect(await screen.findByText("Wrote the plan")).toBeTruthy();
  });

  // the vector, the double failure the review found: a switch fails, its
  // recovery read fails, and the switch's own refresh fails too. The surface
  // then has no page and no way to get one on its own — and it used to answer
  // that by telling a workspace with real history that it had no changes.
  it("never says 'No changes yet' for a read that failed", async () => {
    const stranded = deferred<TimelinePage>();
    const retry = deferred<TimelinePage>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      stranded.promise,
      switchRefresh,
      retry.promise,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    const versionList = [
      {
        id: "main",
        name: "Main",
        kind: "main" as const,
        createdAtMs: 0,
        canMergeIntoMain: false,
      },
      {
        id: "try-1",
        name: "Try: launch note",
        kind: "named" as const,
        createdAtMs: 1,
        canMergeIntoMain: true,
      },
    ];
    const lookup = deferred<{
      versions: typeof versionList;
      activeVersionId: string;
    }>();
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(() => {
      versionReads += 1;
      if (versionReads === 1) {
        return Promise.resolve({ versions: versionList, activeVersionId: "try-1" });
      }
      if (versionReads === 2) return Promise.reject(new Error("recovery read failed"));
      if (versionReads === 3) return lookup.promise;
      return new Promise<never>(() => {});
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      throw new Error("switch failed");
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() =>
      expect(bridge.listWorkspaceVersions.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });
    await act(async () => {
      stranded.resolve(
        historyPage(
          [historyMoment("m-stranded", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await stranded.promise;
    });
    await act(async () => {
      lookup.resolve({ versions: versionList, activeVersionId: "main" });
      await lookup.promise;
    });

    // No page, and no read on the way. The surface says what happened.
    await waitFor(() => expect(screen.getByTestId("history-load-failed")).toBeTruthy());
    expect(screen.queryByText("No changes yet")).toBeNull();
    expect(screen.queryByText("Wrote the note in the try version")).toBeNull();
    expect(screen.getByTestId("history-load-failed").textContent).toContain(
      "dohc could not load this workspace's history.",
    );

    // The Next has to work on this surface (copy.md): the control reads again.
    expect(bridge.listHistory).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(3));
    await act(async () => {
      retry.resolve(historyPage([historyMoment("m-main", "Back on main")], "main"));
      await retry.promise;
    });
    expect(await screen.findByText("Back on main")).toBeTruthy();
  });

  // The named road to the same wrong pixels. The switch succeeds, so it
  // names the version it landed on and nothing has to be looked up — but the
  // page on screen is still the version the user left, and the follow-up
  // refresh is the only thing that would replace it. When that refresh fails,
  // the timeline used to keep naming a version nobody is on.
  it("retracts the old version's timeline when the switch succeeds and its refresh fails", async () => {
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => {
      issued += 1;
      if (issued === 1) {
        return Promise.resolve(
          historyPage(
            [historyMoment("m-try", "Wrote the note in the try version")],
            "try-1",
          ),
        );
      }
      if (issued === 2) return switchRefresh;
      return new Promise<never>(() => {});
    });
    const versionList = [
      {
        id: "main",
        name: "Main",
        kind: "main" as const,
        createdAtMs: 0,
        canMergeIntoMain: false,
      },
      {
        id: "try-1",
        name: "Try: launch note",
        kind: "named" as const,
        createdAtMs: 1,
        canMergeIntoMain: true,
      },
    ];
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(async () => {
      versionReads += 1;
      return {
        versions: versionList,
        activeVersionId: versionReads === 1 ? "try-1" : "main", ...historyPageFields,
      };
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => ({
      activeVersionId: "main", ...historyPageFields,
      changedFileCount: 0,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    // The workspace is on Main. Nothing may still show the try version's
    // moments, and the blank they leave must not read as an empty workspace.
    await waitFor(() =>
      expect(screen.queryByText("Wrote the note in the try version")).toBeNull(),
    );
    expect(screen.queryByText("No changes yet")).toBeNull();
    expect(await screen.findByTestId("history-load-failed")).toBeTruthy();
  });

  // The other verdict on the named path, and the reason the retraction is a
  // question and not a blanket blank: the refresh succeeds, and the timeline
  // is simply the new version's.
  it("shows the new version's timeline when the switch and its refresh succeed", async () => {
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => {
      issued += 1;
      if (issued === 1) {
        return Promise.resolve(
          historyPage(
            [historyMoment("m-try", "Wrote the note in the try version")],
            "try-1",
          ),
        );
      }
      return Promise.resolve(
        historyPage([historyMoment("m-main", "Back on main")], "main"),
      );
    });
    const versionList = [
      {
        id: "main",
        name: "Main",
        kind: "main" as const,
        createdAtMs: 0,
        canMergeIntoMain: false,
      },
      {
        id: "try-1",
        name: "Try: launch note",
        kind: "named" as const,
        createdAtMs: 1,
        canMergeIntoMain: true,
      },
    ];
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(async () => {
      versionReads += 1;
      return {
        versions: versionList,
        activeVersionId: versionReads === 1 ? "try-1" : "main", ...historyPageFields,
      };
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => ({
      activeVersionId: "main", ...historyPageFields,
      changedFileCount: 0,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    expect(await screen.findByText("Back on main")).toBeTruthy();
    expect(screen.queryByText("Wrote the note in the try version")).toBeNull();
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
  });

  // Announcing the switch first re-keys this component, and the re-key used to
  // bump the same counter the operation checks itself against — so the switch
  // invalidated its own token while its follow-up re-read was still pending,
  // its finally skipped, and the selector sat disabled on "Switching…" for the
  // rest of the session. Liveness and operation identity are different
  // questions.
  it("re-enables the selector when the switch re-read outlives the epoch bump", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let switched = false;
    // Only the mount read answers at once. Every read after it — the switch's
    // own re-read, and the one the re-key issues — is held open, so the
    // operation must survive the re-key to finish at all.
    const held: Array<() => void> = [];
    let versionReads = 0;
    bridge.listWorkspaceVersions = vi.fn(() => {
      const answer = () => ({
        versions: [
          {
            id: "main",
            name: "Main",
            kind: "main" as const,
            createdAtMs: 0,
            canMergeIntoMain: false,
          },
          {
            id: "try-1",
            name: "Try: launch note",
            kind: "named" as const,
            createdAtMs: 1,
            canMergeIntoMain: true,
          },
        ],
        activeVersionId: switched ? "main" : "try-1", ...historyPageFields,
      });
      versionReads += 1;
      if (versionReads === 1) return Promise.resolve(answer());
      return new Promise<ReturnType<typeof answer>>((resolveRead) => {
        held.push(() => resolveRead(answer()));
      });
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", ...historyPageFields, changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    // The re-key has happened by now: it is what issues the extra read.
    await waitFor(() => expect(held.length).toBeGreaterThan(1));

    await act(async () => {
      for (const answerRead of held) answerRead();
      await Promise.resolve();
    });

    const trigger = await screen.findByTestId("version-menu-button");
    await waitFor(() =>
      expect(screen.getByTestId("version-menu-active").textContent).not.toBe(
        "Switching…",
      ),
    );
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
  });

  // The same slip on the other flow. "Back to Main" switched, then dismissed
  // the review, and only then said where the workspace had landed — so an
  // old-version answer arriving while the dismissal was in flight met an unset
  // boundary. The dismissal here never settles, which is what a slow one looks
  // like from the timeline's side.
  it("reports Main before the dismissal it does not wait for", async () => {
    const first = deferred<TimelinePage>();
    const stranded = deferred<TimelinePage>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      first.promise,
      stranded.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    let switched = false;
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
          id: "try-1",
          name: "Try: launch note",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: switched ? "main" : "try-1", ...historyPageFields,
    }));
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", ...historyPageFields, changedFileCount: 0 };
    });
    // The switch lands; the dismissal that follows it never does.
    bridge.dismissTryInVersionReview = vi.fn(() => new Promise<never>(() => {}));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve(
        historyPage(
          [historyMoment("m-first", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await first.promise;
    });
    expect(await screen.findByTestId("try-review-card")).toBeTruthy();

    // A try-version refresh is in flight when the user leaves.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));

    // Set aside: switch back to Main, then hang on the dismissal.
    await user.click(screen.getByTestId("try-review-set-aside"));
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() => expect(bridge.dismissTryInVersionReview).toHaveBeenCalled());

    // The boundary's own refresh fails, so the try-version answer is the only
    // one left — and it describes somewhere the user is no longer.
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(3));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });
    await act(async () => {
      stranded.resolve(
        historyPage(
          [historyMoment("m-stranded", "Edited the note in the try version")],
          "try-1",
        ),
      );
      await stranded.promise;
    });

    expect(screen.queryByText("Edited the note in the try version")).toBeNull();
  });

  // Main serves these calls concurrently, so a request issued earlier can
  // answer later. Two activity refreshes are both superseded by the switch's
  // own refresh. When that one fails, neither answer paints, whichever
  // version it describes; the rows the switch dropped stay gone.
  it("paints no superseded answer after the switch's own refresh failed", async () => {
    const opening = deferred<TimelinePage>();
    const late = deferred<TimelinePage>();
    const stale = deferred<TimelinePage>();
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      opening.promise,
      late.promise,
      stale.promise,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    let switched = false;
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
          id: "try-1",
          name: "Try: launch note",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: switched ? "main" : "try-1", ...historyPageFields,
    }));
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", ...historyPageFields, changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      opening.resolve(
        historyPage(
          [historyMoment("m-opening", "Wrote the note in the try version")],
          "try-1",
        ),
      );
      await opening.promise;
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    // Two refreshes go out, in this order. They will answer in the other one.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(3));

    // The switch: the workspace says Main, which is the newest statement of all
    // — issued after both refreshes. The switch's own refresh fails, so nothing
    // newer than those two ever answers.
    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(4));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    // The earlier of the two refreshes answers first, about Main.
    await act(async () => {
      late.resolve(historyPage([historyMoment("m-late", "Back on main")], "main"));
      await late.promise;
    });
    expect(screen.queryByText("Back on main")).toBeNull();

    // The later one describes the version the user left.
    await act(async () => {
      stale.resolve(
        historyPage(
          [historyMoment("m-stale", "Edited the note in the try version")],
          "try-1",
        ),
      );
      await stale.promise;
    });

    expect(screen.queryByText("Edited the note in the try version")).toBeNull();
    expect(screen.queryByText("Wrote the note in the try version")).toBeNull();
    expect(screen.getByTestId("history-load-failed")).toBeTruthy();
  });

  // The same callback runs for merges, conflict resolutions, and a "Set aside"
  // that was already on Main — none of which change the active version. Its
  // refresh supersedes the one a pagination was holding. When that refresh and
  // the pagination both fail, the rows on screen stay; the held answer, asked
  // again since, does not paint. (useHistoryPage.test.tsx pins that a version
  // statement alone keeps a held refresh.)
  it("keeps the rows on screen when the refresh that superseded a held one fails", async () => {
    const first = deferred<TimelinePage>();
    const refreshed = deferred<TimelinePage>();
    let failPage!: (error: Error) => void;
    const page = new Promise<never>((_resolve, reject) => {
      failPage = reject;
    });
    let failDismissRefresh!: (error: Error) => void;
    const dismissRefresh = new Promise<never>((_resolve, reject) => {
      failDismissRefresh = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      first.promise,
      refreshed.promise,
      page,
      dismissRefresh,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage([historyMoment("m-first", "Added the launch checklist")]),
        nextCursor: timelineCursor(1),
      });
      await first.promise;
    });
    expect(await screen.findByText("Added the launch checklist")).toBeTruthy();

    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(3));
    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });

    // Set aside while already on Main: no switch runs, but the shell hears the
    // version state changed and refreshes. That refresh fails.
    await user.click(screen.getByTestId("try-review-set-aside"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(4));
    expect(bridge.switchWorkspaceVersion).not.toHaveBeenCalled();
    await act(async () => {
      failDismissRefresh(new Error("history failed"));
      await Promise.resolve();
    });

    await act(async () => {
      failPage(new Error("pagination failed"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Added the launch checklist")).toBeTruthy();
    expect(screen.queryByText("Rewrote the plan")).toBeNull();
  });

  // A failure is an answer for the version rule: it answers about somewhere
  // the user has left. The switch bumps the issue counter but not the
  // committed watermark, so the old pagination's rejection still read as
  // "about the open timeline" and posted a banner for a version nobody is
  // looking at.
  it("says nothing about a pagination that failed for the version the user left", async () => {
    const first = deferred<TimelinePage>();
    let failPage!: (error: Error) => void;
    const page = new Promise<never>((_resolve, reject) => {
      failPage = reject;
    });
    let failSwitchRefresh!: (error: Error) => void;
    const switchRefresh = new Promise<never>((_resolve, reject) => {
      failSwitchRefresh = reject;
    });
    const responses: Promise<TimelinePage>[] = [
      first.promise,
      page,
      switchRefresh,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    let switched = false;
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
          id: "try-1",
          name: "Try: launch note",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: switched ? "main" : "try-1", ...historyPageFields,
    }));
    bridge.switchWorkspaceVersion = vi.fn(async () => {
      switched = true;
      return { activeVersionId: "main", ...historyPageFields, changedFileCount: 0 };
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        ...historyPage(
          [historyMoment("m-first", "Wrote the note in the try version")],
          "try-1",
        ),
        nextCursor: timelineCursor(1),
      });
      await first.promise;
    });
    expect(await screen.findByText("Wrote the note in the try version")).toBeTruthy();

    // Earlier moments are on their way when the user leaves this version.
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.switchWorkspaceVersion).toHaveBeenCalled());
    // Nothing commits for the new version either, so the committed watermark
    // never moves — the only thing that can tell the failure apart is which
    // version it belongs to.
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(3));
    await act(async () => {
      failSwitchRefresh(new Error("history failed"));
      await Promise.resolve();
    });
    // That refresh's own failure is real and is reported. Clear it, so what
    // remains can only have come from the pagination.
    await user.click(await screen.findByLabelText("Dismiss workspace error"));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    await act(async () => {
      failPage(new Error("pagination failed"));
      await Promise.resolve();
    });

    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // Main pushes each change of the run slot, so the dot needs no read on
  // refresh: a run seen by Settings or by chat dispatch shows the same way.
  it("follows main's run state pushes and never reads agent runs on refresh", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);
    await waitFor(() => expect(bridge.readAgentRunState).toHaveBeenCalledOnce());
    await waitFor(() => expect(bridge.getSyncStatus).toHaveBeenCalled());
    const setupReads = bridge.getAgentRunStatus.mock.calls.length;
    const statusReads = bridge.getSyncStatus.mock.calls.length;

    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() =>
      expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(statusReads),
    );
    expect(bridge.getAgentRunStatus).toHaveBeenCalledTimes(setupReads);
    expect(screen.queryByTestId("agent-run-indicator")).toBeNull();

    act(() => {
      bridge.emitAgentRunState({ workspaceId: WORKSPACE.workspaceId, revision: 1, active: true });
    });
    expect(screen.getByTestId("agent-run-indicator")).toBeTruthy();
    // Another workspace's run, and an answer older than the one shown, change nothing.
    act(() => {
      bridge.emitAgentRunState({ workspaceId: "ws-other", revision: 2, active: false });
      bridge.emitAgentRunState({ workspaceId: WORKSPACE.workspaceId, revision: 1, active: false });
    });
    expect(screen.getByTestId("agent-run-indicator")).toBeTruthy();
    act(() => {
      bridge.emitAgentRunState({ workspaceId: WORKSPACE.workspaceId, revision: 3, active: false });
    });
    expect(screen.queryByTestId("agent-run-indicator")).toBeNull();
    expect(bridge.readAgentRunState).toHaveBeenCalledOnce();
    expect(bridge.getAgentRunStatus).toHaveBeenCalledTimes(setupReads);
  });

  // A failure reports, and it takes nothing. The lane's watermark is what an
  // answer earns: a read that failed proves nothing, and the older read still
  // in flight may be the only answer anyone gets. Moving the watermark on a
  // rejection would reject that answer when it lands, and the workspace status would
  // sit on a value the workspace has left with nothing to correct it.
  it("commits an older sync status when the newer read failed", async () => {
    const syncingStatus = { ...SYNC_STATUS, state: "syncing" as const };
    const heldStatus = deferred<typeof SYNC_STATUS | typeof syncingStatus>();
    // Which read gets what is set by this test, not by a call count: the shell
    // reads status more than once while a workspace opens.
    let holdNextRead = false;
    let failNextRead = false;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(() => {
      if (holdNextRead) {
        holdNextRead = false;
        return heldStatus.promise;
      }
      if (failNextRead) {
        failNextRead = false;
        return Promise.reject(new Error("sync status failed"));
      }
      return Promise.resolve(SYNC_STATUS);
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalled());
    expect(screen.getByTestId("sync-status").dataset.state).toBe("synced");

    // One refresh's status read is still in flight.
    holdNextRead = true;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(holdNextRead).toBe(false));

    // A newer refresh asks the same lane, and its read fails. The failure is
    // reported — nothing else can say the shown value is now old.
    failNextRead = true;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(failNextRead).toBe(false));
    expect(await screen.findByTestId("workspace-shell-error")).toBeTruthy();

    // Then the older read answers. It is the only answer this lane has.
    await act(async () => {
      heldStatus.resolve(syncingStatus);
      await heldStatus.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing"),
    );
  });

  // What `committed` is for, on the success path: latest-committed-wins. Two
  // refreshes overlap, the newer answers first, and the older must not paint
  // its stale value over it when it finally lands.
  it("keeps an older answer from overwriting a newer one on the same lane", async () => {
    const syncingStatus = { ...SYNC_STATUS, state: "syncing" as const };
    const olderRead = deferred<typeof SYNC_STATUS | typeof syncingStatus>();
    let nextRead: "older" | null = null;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(() => {
      if (nextRead === "older") {
        nextRead = null;
        return olderRead.promise;
      }
      return Promise.resolve(syncingStatus);
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalled());

    // The older refresh's read is still in flight when a newer one answers.
    nextRead = "older";
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(nextRead).toBeNull());
    const statusReads = bridge.getSyncStatus.mock.calls.length;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    // Activity refreshes ride a trailing-edge debounce now, so the newer read
    // this scenario needs — the one the older answer must lose to — is issued
    // only after the window elapses. Wait for its issue, or the older answer
    // IS the newest information and displaying it would be correct.
    await waitFor(() =>
      expect(bridge.getSyncStatus.mock.calls.length).toBe(statusReads + 1),
    );
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing"),
    );

    // The older answer lands last and says something the workspace has left.
    await act(async () => {
      olderRead.resolve(SYNC_STATUS);
      await olderRead.promise;
    });
    expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing");
  });

  // The third way a failure can be superseded, and the one only `committed`
  // catches. The user acted, so this lane holds a value newer than every
  // request in flight — but the lane asked nothing, so its newest issued read
  // is still the one now failing. A banner about a card the user dismissed
  // describes nothing on screen.
  it("keeps a failed read from reporting after the user superseded its lane", async () => {
    const first = deferred<TimelinePage>();
    const refreshed = deferred<TimelinePage>();
    const responses: Promise<TimelinePage>[] = [
      first.promise,
      refreshed.promise,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    let failSecondTryRead!: (error: Error) => void;
    const secondTryRead = new Promise<never>((_resolve, reject) => {
      failSecondTryRead = reject;
    });
    let tryReads = 0;
    bridge.getTryInVersionState = vi.fn(() => {
      tryReads += 1;
      if (tryReads === 1) return Promise.resolve({ state: REVIEW_STATE });
      return secondTryRead;
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await act(async () => {
      first.resolve(historyPage([historyMoment("m-first", "Added the launch checklist")]));
      await first.promise;
    });
    expect(await screen.findByTestId("try-review-card")).toBeTruthy();

    // A refresh is in flight, and its try read has not answered.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.getTryInVersionState).toHaveBeenCalledTimes(2));

    // The user dismisses the review. That is newer than every request issued.
    await user.click(screen.getByTestId("try-review-keep-working"));
    await waitFor(() => expect(screen.queryByTestId("try-review-card")).toBeNull());

    // The read the user superseded now fails. It has nothing to report.
    await act(async () => {
      failSecondTryRead(new Error("try state failed"));
      await Promise.resolve();
    });
    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(screen.queryByTestId("try-review-card")).toBeNull();
  });

  // The same rule, the other ordering. Above, the newer answer had already
  // committed when the older read failed. Here it has not answered yet — so
  // "what did this lane last write" cannot see it, and the failure looks like
  // the newest thing there is. It is not: the lane has already asked again.
  // Reporting raises a banner that the newer answer will not take down, and it
  // then sits over a value the user can see is current.
  it("keeps a failed read from reporting while a newer one is in flight", async () => {
    const syncingStatus = { ...SYNC_STATUS, state: "syncing" as const };
    let failOlderRead!: (error: Error) => void;
    const olderRead = new Promise<never>((_resolve, reject) => {
      failOlderRead = reject;
    });
    const newerRead = deferred<typeof SYNC_STATUS | typeof syncingStatus>();
    let nextRead: "older" | "newer" | null = null;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(() => {
      if (nextRead === "older") {
        nextRead = null;
        return olderRead;
      }
      if (nextRead === "newer") {
        nextRead = null;
        return newerRead.promise;
      }
      return Promise.resolve(SYNC_STATUS);
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalled());
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    // Two refreshes overlap on this lane. Neither has answered.
    nextRead = "older";
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(nextRead).toBeNull());
    nextRead = "newer";
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(nextRead).toBeNull());

    // The older one fails first. The lane has already asked again, so this
    // failure has nothing to say.
    await act(async () => {
      failOlderRead(new Error("sync status failed"));
      await Promise.resolve();
    });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    // The newer one answers, and its value stands with no banner beside it.
    await act(async () => {
      newerRead.resolve(syncingStatus);
      await newerRead.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing"),
    );
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // Supersession is per LANE. The user dismissed a review; that says nothing
  // about sync state, and the dismiss emits no activity event, so rejecting
  // that lane too would strand the workspace status with no other source.
  it("suppresses only the lane the user wrote when a refresh answers late", async () => {
    const first = deferred<TimelinePage>();
    const refreshed = deferred<TimelinePage>();
    const responses: Promise<TimelinePage>[] = [
      first.promise,
      refreshed.promise,
    ];
    let issued = 0;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(() => responses[issued++]!);
    bridge.getTryInVersionState = vi.fn(async () => ({ state: REVIEW_STATE }));
    // The workspace moves on before the second refresh is issued, so that
    // refresh carries fresh news on the lane the user did not write.
    let movedOn = false;
    bridge.getSyncStatus = vi.fn(async () =>
      movedOn ? { ...SYNC_STATUS, state: "syncing" as const } : SYNC_STATUS,
    );
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve(historyPage([historyMoment("m-first", "Added the launch checklist")]));
      await first.promise;
    });
    expect(await screen.findByTestId("try-review-card")).toBeTruthy();
    expect(screen.getByTestId("sync-status").dataset.state).toBe("synced");

    // A refresh is in flight when the user dismisses the review.
    movedOn = true;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("try-review-keep-working"));
    await waitFor(() => expect(screen.queryByTestId("try-review-card")).toBeNull());

    await act(async () => {
      refreshed.resolve(historyPage([historyMoment("m-refreshed", "Rewrote the plan")]));
      await refreshed.promise;
    });

    // The lane the user wrote stays written; the lane they did not, updates.
    expect(screen.queryByTestId("try-review-card")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing"),
    );
  });

  it("marks history ready when the status read succeeds", async () => {
    const previousOrdinal = rendererMarks.readSwitchTimeline().at(-1)?.ordinal ?? 0;
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);

    await waitFor(() => expect(bridge.getSyncStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const timeline = rendererMarks
        .readSwitchTimeline()
        .find((entry) => entry.ordinal > previousOrdinal);
      expect(timeline?.phases["history-ready"]).toEqual(expect.any(Number));
    });
  });

  it("does not report an older no-history refresh after a newer one succeeds", async () => {
    let failOlderRead!: (error: Error) => void;
    let holdNextRead = false;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(() => {
      if (holdNextRead) {
        holdNextRead = false;
        return new Promise<never>((_resolve, reject) => {
          failOlderRead = reject;
        });
      }
      return Promise.resolve(SYNC_STATUS);
    });
    renderShell(bridge);

    await waitFor(() => expect(bridge.getSyncStatus).toHaveBeenCalledTimes(1));

    holdNextRead = true;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(holdNextRead).toBe(false));

    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.getSyncStatus).toHaveBeenCalledTimes(3));

    await act(async () => {
      failOlderRead(new Error("older sync status failed"));
      await Promise.resolve();
    });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("commits an older no-history refresh when the newer one fails", async () => {
    const syncingStatus = { ...SYNC_STATUS, state: "syncing" as const };
    const heldStatus = deferred<typeof SYNC_STATUS | typeof syncingStatus>();
    let holdNextRead = false;
    let failNextRead = false;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(() => {
      if (holdNextRead) {
        holdNextRead = false;
        return heldStatus.promise;
      }
      if (failNextRead) {
        failNextRead = false;
        return Promise.reject(new Error("sync status failed"));
      }
      return Promise.resolve(SYNC_STATUS);
    });
    renderShell(bridge);

    await waitFor(() => expect(bridge.getSyncStatus).toHaveBeenCalledTimes(1));

    holdNextRead = true;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(holdNextRead).toBe(false));

    failNextRead = true;
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(failNextRead).toBe(false));
    expect(await screen.findByTestId("workspace-shell-error")).toBeTruthy();

    await act(async () => {
      heldStatus.resolve(syncingStatus);
      await heldStatus.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing"),
    );
  });

});

// A shared view's open deliberately installed no capture, and main refuses
// every version call.
// The selector retried five times and then raised a danger-tone shell error
// naming a Settings toggle nobody touched, and it came back on every share
// refresh (the selector re-keys on versionEpoch).
describe("shared view versions surface", () => {
  it("never asks a shared view for versions, and raises no banner across a share refresh", async () => {
    const bridge = makeShareBridge();
    bridge.refreshSharedView = vi.fn(async () => ({
      ok: true as const,
      status: "updated" as const,
      changedPaths: 1,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    }));
    const user = userEvent.setup();
    renderShell(bridge, SHARE_VIEW);

    // Let the shell's mount effects run first, so the pins below cannot pass
    // vacuously.
    await settleShareView();
    // The selector is the surface that made the call, and it carries the
    // Try-in-version and compare entry points inside its menu — all three go
    // with it.
    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    // The banner is that call's consequence — the selector raises it after
    // five failed attempts over ~5 seconds — so the no-call pin above is what
    // this assertion rests on, not a race with the retry window.
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    // The share refresh is what made the banner RECUR: its versionEpoch bump
    // re-keys the selector's mount effect. With the selector gone there is no
    // key to bump, so this drives the whole refresh path (pull → file listing
    // → epoch) and pins that nothing along it asks main for versions.
    const pulls = bridge.refreshSharedView.mock.calls.length;
    await user.click(screen.getByTestId("shared-view-refresh"));
    await waitFor(() =>
      expect(bridge.refreshSharedView.mock.calls.length).toBeGreaterThan(pulls),
    );
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // A shared view in the pre-status window. This test was written to isolate
  // the share clause, and it no longer can: once the versions gate required
  // an answered status, that clause stopped being the only thing that
  // answers here, and main gives a shared view `historyShareView: true` for
  // the whole of its life. So `!isShareView` inside `versionsEnabled` is now
  // redundant with
  // the status clause and survives deletion. It is kept, and declared
  // unpinned, because it is the SYNCHRONOUS registry fact the review
  // asked for: it does not depend on main's status shape staying this way.
  // What this test still pins is the no-call itself, in the window where the
  // shell knows least.
  it("asks a shared view for no versions before its first status arrives", async () => {
    const status = deferred<typeof SHARE_STATUS>();
    const bridge = makeShareBridge();
    bridge.openWorkspace = vi.fn(() => status.promise);
    bridge.getSyncStatus = vi.fn(() => status.promise);
    renderShell(bridge, SHARE_VIEW);

    await settleShareView();
    // The premise: no status has answered, so the shell knows nothing about
    // the recorder yet.
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();

    // And it stays gone once the status agrees.
    await act(async () => {
      status.resolve(SHARE_STATUS);
      await status.promise;
    });
    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
  });

  // The other half of that branch: a workspace that is not a shared view must
  // still get the real page. Without this, replacing VersionComparePage with
  // the placeholder for every workspace keeps this suite green, and only an
  // e2e — which the javascript gate does not run — would catch it.
  it("keeps the real compare page for a persisted compare tab outside a shared view", async () => {
    const comparePath = versionCompareTabPath("v-old");
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs([comparePath], comparePath)),
    );
    renderShell(bridge);

    expect(await screen.findByTestId("version-compare-page")).toBeTruthy();
    expect(screen.queryByTestId("version-compare-share-view")).toBeNull();
  });

  it("states the capability for a persisted compare tab instead of a page that can only fail", async () => {
    const comparePath = versionCompareTabPath("v-old");
    const bridge = makeShareBridge(
      Promise.resolve(storedStateWithTabs([comparePath], comparePath)),
    );
    renderShell(bridge, SHARE_VIEW);

    // One line, per the empty-state recipe (copy.md): what is missing, then
    // the next step this surface really has — the tab closes.
    const placeholder = await screen.findByTestId("version-compare-share-view");
    expect(placeholder.textContent).toContain(
      "A shared view has no versions to compare. Close this tab to go back to the shared files.",
    );
    // The empty-state recipe's tone, not the neighbouring legacy note's
    // (copy.md: one text-sm text-muted line).
    expect(placeholder.className).toContain("text-sm");
    expect(placeholder.className).toContain("text-muted");
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });
});

// The same error loop from the other cause, on a workspace that is not
// a shared view. After a failed capture build main has no capture, so every
// version call is refused — while the renderer's own settings read still says
// engine-on. History has carried main's status override since #601; versions
// did not, so the selector rendered, retried, and raised the danger banner.
describe("versions surface after a failed capture build", () => {
  const FAILED_STATUS = {
    ...SYNC_STATUS,
    historyRecordingUnavailable: true,
  };

  it("renders no version surface and never asks for versions when the recorder failed to build", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => FAILED_STATUS);
    bridge.getSyncStatus = vi.fn(async () => FAILED_STATUS);
    // Main's real answer once the capture build failed (#541 copy).
    bridge.listWorkspaceVersions = vi.fn(async (): Promise<never> => {
      throw new Error(
        "dohc could not start Versions for this workspace. Restart dohc to try again.",
      );
    });
    renderShell(bridge);

    // Both halves of the premise, before anything is pinned: the renderer's
    // own read said engine-ON (this control renders on that read alone), and
    // main's status has landed carrying the failure. Without them the no-call
    // below passes vacuously in the pre-read window.
    await screen.findByTestId("titlebar-about-sidebar");
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );

    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    // The banner is that call's consequence, five failed attempts later.
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The other half of the branch: a healthy engine workspace must still get
  // the selector. Without this, dropping the version surface for every
  // workspace keeps the suite above green.
  it("keeps the version selector when main's status reports a live recorder", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);

    expect(await screen.findByTestId("version-menu-button")).toBeTruthy();
    await waitFor(() => expect(bridge.listWorkspaceVersions).toHaveBeenCalled());
  });

  // The window the test above cannot see. Its status fake answers in the same
  // microtask flush as the settings read, and PRODUCTION NEVER DOES:
  // `getWorkspaceSettings` is one file read, while `openWorkspace` waits for
  // the capture build and then for main's watcher to finish its first scan.
  // Engine-ON therefore lands first on every open, and a missing status used
  // to answer "there is a recorder": the selector mounted, called, retried
  // five times and raised the banner inside a window the fixture had
  // closed.
  //
  // So this open does not resolve in the same flush.
  it("asks for no versions before main's capture decision lands", async () => {
    const decision = deferred<typeof FAILED_STATUS>();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(() => decision.promise);
    bridge.getSyncStatus = vi.fn(() => decision.promise);
    bridge.listWorkspaceVersions = vi.fn(async (): Promise<never> => {
      throw new Error(
        "dohc could not start Versions for this workspace. Restart dohc to try again.",
      );
    });
    renderShell(bridge);

    // Both halves of the premise. The titlebar Chats button renders on the
    // renderer's own read alone, so it proves that read answered engine-ON;
    // `data-ready` proves the open has not resolved.
    await screen.findByTestId("titlebar-about-sidebar");
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");

    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();

    // And the answer keeps it that way — no banner from retries that never
    // started.
    await act(async () => {
      decision.resolve(FAILED_STATUS);
      await decision.promise;
    });
    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The same window, entered the way production actually enters it: through
  // an activity refresh, while main's entry still holds the defaults it
  // registered before it awaited the capture build.
  //
  // `workspaceActivity.open` registers that entry before the build — it must,
  // so a batch settling during the build finds a slot — and until the build
  // answers it holds `historyRecordingUnavailable: false` and
  // `historyRecordingUnavailable: false`. Any workspace's activity event
  // makes this shell refresh, so the refresh is what used to read those
  // defaults and commit them as a status. Reading that as "there is a
  // recorder" is the same defect as reading a missing status that way, one
  // indirection along.
  //
  // The refresh no longer reads them at all: before the decision it
  // returns, because both of its branches are wrong in this window — and the
  // status it used to commit could arrive after the decided one and put the
  // defaults back. So this pins two things at once: the refresh asks main
  // nothing here, and the gate stays shut through the whole window on the
  // decision alone.
  it("asks main for nothing while its capture decision is still pending", async () => {
    const settings = deferred<WorkspaceSettingsResult>();
    const decision = deferred<typeof FAILED_STATUS>();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getWorkspaceSettings = vi.fn(() => settings.promise);
    bridge.openWorkspace = vi.fn(() => decision.promise);
    // Main's answer before the decision: the entry exists and its recorder
    // fields are still at their defaults. After the decision it reports what
    // was decided. A fake that refused before the decision, or kept answering
    // with the defaults after it, would model something main cannot do — and
    // the second of those is what this pin is about.
    let decided = false;
    bridge.getSyncStatus = vi.fn(async () => (decided ? FAILED_STATUS : SYNC_STATUS));
    bridge.listWorkspaceVersions = vi.fn(async (): Promise<never> => {
      throw new Error(
        "dohc could not start Versions for this workspace. Restart dohc to try again.",
      );
    });
    renderShell(bridge);

    // Another workspace records a batch. The shell refreshes — and asks main
    // for nothing, because the only status available to it here is the
    // pre-decision default.
    await act(async () => {
      bridge.emitWorkspaceActivity();
      await Promise.resolve();
    });
    expect(bridge.getSyncStatus).not.toHaveBeenCalled();
    expect(bridge.listHistory).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");

    // Now the renderer's read answers engine-ON. Every input the old gate had
    // now says "recorder", and main has still decided nothing.
    await act(async () => {
      settings.resolve({
        settings: {
          ...DEFAULT_WORKSPACE_SETTINGS,
        },
        source: "stored",
      });
      await settings.promise;
    });
    await screen.findByTestId("titlebar-about-sidebar");

    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();

    // The decision lands, and it is the failure. Still nothing.
    await act(async () => {
      decided = true;
      decision.resolve(FAILED_STATUS);
      await decision.promise;
    });
    expect(screen.queryByTestId("version-menu-button")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The same cause on the surface that outlives the selector. A persisted
  // compare tab was gated on the share fact alone, so a workspace whose
  // capture build failed still mounted VersionComparePage — which asks for
  // the versions on mount and then says "Could not compare with Main."
  // Reached by opening a compare tab while healthy and restarting after a
  // failed build.
  it("states the capability for a persisted compare tab when the recorder failed to build", async () => {
    const comparePath = versionCompareTabPath("v-old");
    const status = deferred<typeof FAILED_STATUS>();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs([comparePath], comparePath)),
    );
    bridge.openWorkspace = vi.fn(() => status.promise);
    bridge.getSyncStatus = vi.fn(() => status.promise);
    renderShell(bridge);

    // Before the decision lands, the tab mounts no page and claims nothing:
    // the renderer's own read proves nothing about what main recorded.
    await screen.findByTestId("titlebar-about-sidebar");
    expect(screen.queryByTestId("version-compare-page")).toBeNull();
    expect(screen.queryByTestId("version-compare-off")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();

    await act(async () => {
      status.resolve(FAILED_STATUS);
      await status.promise;
    });

    // One line, per the empty-state recipe (copy.md), and the cause main
    // established chooses it. The cause here is a BUILD FAILURE, so the line
    // says what dohc could not do and how to retry. It must never say the
    // workspace has no versions: versions made before this session are still
    // on disk, and the restart this very sentence prescribes brings them
    // back.
    const placeholder = await screen.findByTestId("version-compare-off");
    expect(placeholder.textContent).toContain(
      "dohc could not open versions for this workspace. Your files still save normally. Restart dohc to try again.",
    );
    expect(placeholder.textContent).not.toContain("no versions");
    expect(placeholder.className).toContain("text-sm");
    expect(placeholder.className).toContain("text-muted");
    expect(screen.queryByTestId("version-compare-page")).toBeNull();
    expect(bridge.listWorkspaceVersions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });
});

// Virtual tabs survive restore, so a moment-diff tab outlives the History
// surface that opened it. A shared view opens the change its share imported,
// read-only: it has no recorder, so it offers no restore.
describe("shared view moment-diff tab", () => {
  const MOMENT_TAB = momentDiffTabPath("m-1");

  it("opens a persisted moment-diff tab read-only from the share's imported history", async () => {
    const bridge = makeShareBridge(
      Promise.resolve(storedStateWithTabs([MOMENT_TAB], MOMENT_TAB)),
    );
    bridge.readEngineMoment = vi.fn(async (): Promise<ReadEngineMomentResult> => ({
      moment: {
        id: "m-1", versionId: "main", path: "notes/plan.md", recordedAtMs: 100,
        operation: "write", origin: "local-file", beforeText: "old plan\n", afterText: "new plan\n",
      },
    }));
    renderShell(bridge, SHARE_VIEW);

    await screen.findByTestId("engine-moment-diff-page");
    expect(bridge.readEngineMoment).toHaveBeenCalledWith({ workspaceId: SHARE_VIEW.workspaceId, momentId: "m-1" });
    for (const control of ["engine-diff-restore-file", "engine-diff-shared-restore", "engine-diff-stop-and-restore", "engine-diff-undo-restore"]) {
      expect(screen.queryByTestId(control)).toBeNull();
    }
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("keeps the real diff page for a persisted moment-diff tab outside a shared view", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs([MOMENT_TAB], MOMENT_TAB)),
    );
    bridge.readEngineMoment = vi.fn(async (): Promise<ReadEngineMomentResult> => ({
      moment: {
        id: "m-1",
        versionId: "main",
        path: "notes/plan.md",
        recordedAtMs: 100,
        operation: "write",
        origin: "local-file",
        beforeText: "old plan\n",
        afterText: "new plan\n",
      },
    }));
    renderShell(bridge);

    await waitFor(() =>
      expect(bridge.readEngineMoment).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        momentId: "m-1",
      }),
    );
    const tab = await screen.findByRole("tab", { name: "Diff: plan.md" });
    expect(tab.title).toBe("History diff: notes/plan.md");
    expect(screen.queryByTestId("moment-diff-off")).toBeNull();
    expect(screen.getByTestId("engine-diff-restore-file")).toBeTruthy();
  });

  // Before main decides, the tab claims nothing and reads nothing.
  it("waits for main's decision before a shared view reads a moment", async () => {
    const status = deferred<typeof SHARE_STATUS>();
    const bridge = makeShareBridge(
      Promise.resolve(storedStateWithTabs([MOMENT_TAB], MOMENT_TAB)),
    );
    bridge.openWorkspace = vi.fn(() => status.promise);
    bridge.getSyncStatus = vi.fn(() => status.promise);
    renderShell(bridge, SHARE_VIEW);

    await settleShareView();
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    expect(screen.queryByTestId("engine-moment-diff-page")).toBeNull();
    expect(bridge.readEngineMoment).not.toHaveBeenCalled();
  });
});

// The same tab, the other cause. #621 gated it on the share fact
// alone, so a workspace whose recorder failed to build still mounted
// EngineMomentDiffPage — which calls readEngineMoment on mount and falls into
// its own error state. Reached by opening a moment diff while healthy and
// restarting after a failed build.
describe("moment-diff tab after a failed capture build", () => {
  const MOMENT_TAB = momentDiffTabPath("m-1");
  const FAILED_STATUS = {
    ...SYNC_STATUS,
    historyRecordingUnavailable: true,
  };

  it("states the capability instead of a page that can only fail", async () => {
    const status = deferred<typeof FAILED_STATUS>();
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs([MOMENT_TAB], MOMENT_TAB)),
    );
    bridge.openWorkspace = vi.fn(() => status.promise);
    bridge.getSyncStatus = vi.fn(() => status.promise);
    bridge.readEngineMoment = vi.fn(async (): Promise<never> => {
      throw new Error("Engine history is not enabled for this workspace.");
    });
    renderShell(bridge);

    // Before the decision lands the tab mounts no page and claims nothing:
    // the renderer's own read proves nothing about what main recorded.
    await screen.findByTestId("titlebar-about-sidebar");
    expect(screen.queryByTestId("engine-moment-diff-page")).toBeNull();
    expect(screen.queryByTestId("moment-diff-off")).toBeNull();
    expect(bridge.readEngineMoment).not.toHaveBeenCalled();

    await act(async () => {
      status.resolve(FAILED_STATUS);
      await status.promise;
    });

    // The History placeholder's line for this cause: one cause, one sentence,
    // wherever it is stated. It says what dohc could not do — never that the
    // workspace has no history, which the restart it prescribes would undo.
    const placeholder = await screen.findByTestId("moment-diff-off");
    expect(placeholder.textContent).toContain(
      "dohc could not start recording history for this workspace.",
    );
    expect(placeholder.textContent).toContain("Restart dohc to try again.");
    expect(placeholder.className).toContain("text-sm");
    expect(placeholder.className).toContain("text-muted");
    expect(screen.queryByTestId("engine-moment-diff-page")).toBeNull();
    expect(bridge.readEngineMoment).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

});
