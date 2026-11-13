// @vitest-environment jsdom
import { rendererMarks } from "../performance/rendererMarks";
import "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  EngineMomentRecord,
  ListHistoryResult,
  ReadEngineMomentResult,
} from "../ipc/bridgeContract";
import { momentDiffTabPath } from "./workbench/workbenchState";
import { deferred } from "../testing/deferred";
import {
  historyPageFields,
  timelineCursor,
  timelinePage,
  type TimelinePage,
} from "../testing/historyPageFixture";
import type { Workspace } from "./DesktopWorkspaceShell";
import {
  DesktopWorkspaceShell,
  WORKSPACE,
  OTHER_WORKSPACE,
  SYNC_STATUS,
  storedStateWithTabs,
  makeBridge,
  renderShell,
  shellBootstrapProps,
  SHARE_VIEW,
  makeShareBridge,
  settleShareView,
} from "./DesktopWorkspaceShell.testHarness";

describe("history page", () => {
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
    // No saved layout, so the History click below stays the shown view.
    bridge.getWorkspaceUiState = vi.fn(async () => null);
    bridge.openWorkspace = vi.fn(() => decision.promise);
    // Main's answer while the build runs: the entry exists, and its recorder
    // fields are still the defaults it registered before awaiting the build.
    let decided = false;
    bridge.getSyncStatus = vi.fn(async () => (decided ? FAILED_HISTORY_STATUS : SYNC_STATUS));
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

  // A shared view records nothing, but it reads the history its share
  // imported, an ended share included. The status is the one main really
  // produces for a shared view (historyShareView, no recorder).
  it.each([["ended View", "view", true]] as const)(
    "lists a %s share's imported history and refreshes it on activity",
    async (_name, access, ended) => {
      const bridge = makeBridge(Promise.resolve(null));
      const shareStatus = { ...SYNC_STATUS, historyShareView: true };
      bridge.openWorkspace = vi.fn(async () => shareStatus);
      bridge.getSyncStatus = vi.fn(async () => shareStatus);
      bridge.listHistory = vi.fn(async () =>
        historyPage([historyMoment("m-1", "Agent revised this line")]),
      );
      const user = userEvent.setup();
      renderShell(bridge, {
        ...WORKSPACE,
        shareView: {
          shareId: "share-1",
          granterEmail: "granter@dohc.test",
          access,
          ...(ended ? { ended: true } : {}),
        },
      });

      await user.click(screen.getByTestId("activity-history"));
      expect(await screen.findByTestId("engine-moment-open")).toBeTruthy();
      expect(screen.queryByTestId("history-off-placeholder")).toBeNull();
      expect(bridge.listHistory).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WORKSPACE.workspaceId }),
      );
      const reads = bridge.listHistory.mock.calls.length;
      await act(async () => {
        bridge.emitWorkspaceActivity();
        await Promise.resolve();
      });
      await waitFor(() => expect(bridge.listHistory.mock.calls.length).toBeGreaterThan(reads));
      expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    },
  );

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
    return timelinePage(
      moments.map((moment) => ({ kind: "file", moment })),
      { workspaceId, versionId },
    );
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
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
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

  it("keeps earlier History reachable when the bounded policy scan returns no rows", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi
      .fn()
      .mockResolvedValueOnce({ ...historyPage([]), nextCursor: timelineCursor(80) })
      .mockResolvedValue(historyPage([historyMoment("older", "Older admitted edit")]));
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId("titlebar-about-sidebar");
    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("engine-history-load-more"));
    expect(await screen.findByText("Older admitted edit")).toBeTruthy();
    expect(screen.queryByText("No changes yet.")).toBeNull();
    expect(bridge.listHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: timelineCursor(80) }),
    );
  });

  async function settledReads(bridge: ReturnType<typeof makeBridge>) {
    await settleShareView();
    await waitFor(() =>
      expect(bridge.readWorkspaceText).toHaveBeenCalledWith(
        expect.objectContaining({ relativePath: "b.md" }),
      ),
    );
    await waitFor(() => expect(bridge.listEngineMoments).toHaveBeenCalled());
    await act(async () => {});
    return bridge.readWorkspaceText.mock.calls.length;
  }

  // DesktopRoot keys the shell by workspace. A's newest-moment read can
  // answer after B is on screen, and must neither re-read B's open file nor
  // raise a failure there.
  it("keeps a newest-moment answer workspace A asked for out of workspace B", async () => {
    const heldA = deferred<{ status: "updating" }>();
    let holdA = false;
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(["b.md"], "b.md")));
    bridge.listWorkspaceFiles = vi.fn(async () => ({
      visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "b.md", kind: "file" as const }],
      folders: [],
    }));
    bridge.getSyncStatus = vi.fn(async () => ({
      ...SYNC_STATUS,
      historyCaptureFailed: true as const,
      engineStoreRefused: null,
    }));
    let latestMomentOrder = 3;
    let readsOfA = 0;
    bridge.listEngineMoments.mockImplementation(async (payload?: { workspaceId: string }) => {
      if (payload?.workspaceId === WORKSPACE.workspaceId) readsOfA += 1;
      return payload?.workspaceId === WORKSPACE.workspaceId && holdA
        ? heldA.promise
        : {
            moments: [],
            nextCursor: null,
            latestMomentOrder,
            activeVersionId: "main",
            ...historyPageFields,
          };
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
    await waitFor(() =>
      expect(bridge.listEngineMoments).toHaveBeenLastCalledWith({
        workspaceId: OTHER_WORKSPACE.workspaceId,
        limit: 1,
      }),
    );
    await waitFor(() =>
      expect(bridge.readWorkspaceText).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceId: OTHER_WORKSPACE.workspaceId, relativePath: "b.md" }),
      ),
    );
    await act(async () => {});
    const readsInB = bridge.readWorkspaceText.mock.calls.length;

    // A's held read answers `updating`. In A it would retry. In B it does
    // nothing at all.
    latestMomentOrder = 9;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await act(async () => {
        heldA.resolve({ status: "updating" });
        await heldA.promise;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(readsOfA).toBe(readsOfABeforeAnswer);
    // B's own paused capture may toast; A's failure may not.
    expect(screen.queryByTestId("workspace-shell-error")?.textContent ?? "").not.toContain(
      "dohc could not check whether open files changed.",
    );
    expect(bridge.readWorkspaceText.mock.calls.length).toBe(readsInB);
  });

  it("keeps a hidden change's tab nameless and restores nothing when Try again finds it hidden", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const moment = historyMoment("m-1", "Wrote the plan");
    const blocked = {
      status: "policy-unreadable" as const,
      unreadable: [".dohc/visibility.toml" as const],
      policyErrors: ["visibility.toml: TOML parse error at line 3, column 9"],
    };
    let broken = false;
    bridge.listHistory = vi.fn(async (): Promise<ListHistoryResult> =>
      broken ? blocked : historyPage([moment]),
    );
    bridge.readEngineMoment = vi.fn(async (): Promise<ReadEngineMomentResult> =>
      broken
        ? { ...blocked, moment: null }
        : { moment: { ...moment, beforeText: "one\n", afterText: "two\n" } },
    );
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
    await waitFor(() =>
      expect(bridge.readEngineMoment.mock.calls.length).toBeGreaterThan(readsBefore),
    );
    await act(async () => {});
    expect(screen.getByTestId("engine-diff-hidden")).toBeTruthy();
    expect(tab.textContent).toContain("History change");
    expect(tab.textContent).not.toContain("plan.md");
    expect(restoreEngineMomentFile).toHaveBeenCalledOnce();
  });

  // The ladder itself is the hook's (useHistoryPage.test.tsx). This pins the
  // surface it leaves behind: a line with no control and no global error,
  // kept through the next activity's read until its page replaces it.

  // While main's status says History is paused, the panel says so: in place
  // of taking in changes, and above the rows a read still answers, which may
  // be missing changes. The line goes with the pause.

  // A pause can end before History answers a page: the panel goes back to
  // taking in changes with no click, then the page replaces the line.

  // A pause does not hide a read that really failed: it keeps its words and
  // Try again, and the page Try again reads still starts with the line.

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
          id: "draft-1",
          name: "Draft",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: switched ? "main" : "draft-1",
      ...historyPageFields,
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
        ...historyPage([historyMoment("m-first", "Wrote the note in the draft")], "draft-1"),
        nextCursor: timelineCursor(1),
      });
      await first.promise;
    });
    expect(await screen.findByText("Wrote the note in the draft")).toBeTruthy();

    // A refresh and a pagination are both in flight when the user leaves.
    act(() => {
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("engine-history-load-more"));
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(3));

    // Switch back to Main. Its own refresh fails, so nothing newer ever
    // answers — exactly when the stale answers would win.
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

    // Both answers from the version the user left arrive too late to matter.
    await act(async () => {
      staleRefresh.resolve(
        historyPage([historyMoment("m-stale", "Edited the note in the draft")], "draft-1"),
      );
      await staleRefresh.promise;
    });
    await act(async () => {
      stalePage.resolve(
        historyPage([historyMoment("m-stale-page", "Started the draft")], "draft-1"),
      );
      await stalePage.promise;
    });

    expect(screen.queryByText("Edited the note in the draft")).toBeNull();
    expect(screen.queryByText("Started the draft")).toBeNull();
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
          id: "draft-1",
          name: "Draft",
          kind: "named" as const,
          createdAtMs: 1,
          canMergeIntoMain: true,
        },
      ],
      activeVersionId: switched ? "main" : "draft-1",
      ...historyPageFields,
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
        historyPage([historyMoment("m-first", "Wrote the note in the draft")], "draft-1"),
      );
      await first.promise;
    });
    expect(await screen.findByText("Wrote the note in the draft")).toBeTruthy();

    // Switch to Main: the daemon switches and notifies, so the activity
    // refresh for MAIN is issued before the switch invoke resolves — and it is
    // still in flight when the shell finally hears about the switch.
    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    await waitFor(() => expect(bridge.listHistory).toHaveBeenCalledTimes(2));

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
      earlyRefresh.resolve(historyPage([historyMoment("m-early", "Back on main")], "main"));
      await earlyRefresh.promise;
    });
    expect(screen.queryByText("Back on main")).toBeNull();
    expect(screen.queryByText("Wrote the note in the draft")).toBeNull();
    await user.click(
      within(screen.getByTestId("history-load-failed")).getByRole("button", { name: "Try again" }),
    );
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

  // A boundary anyone has to await is not a boundary. When the old version's
  // answer lands first, it meets a guard that knows nothing, commits, and
  // whatever arrives later cannot retract it, so a failed switch-triggered
  // refresh would leave the previous version's moments on screen. No await
  // may sit in front of the announcement. Neither the shell's own lookup nor
  // the selector's post-switch re-read answers here.

  // The residual window: a switch that failed, whose recovery re-read
  // also failed, leaves the shell asking which version is active. The
  // old-version answer lands before that lookup does, but the switch's own
  // refresh superseded it, so it paints nothing even though that refresh
  // failed. The lookup then finds no page to drop and asks nothing.

  // The other verdict the lookup can reach: it agrees with the committed page
  // (the failed switch never applied). Dropping here would blank a timeline
  // that is right — and this is every merge and conflict resolution, whose
  // lookup only restates what is already true.

  // The judge must know when court is over: a lookup that settles after the
  // shell unmounted judges nothing. Without the committed-watermark half of
  // the staleness question, a contradicting late lookup would drop state and
  // fire three IPC reads for a workspace the user already left — the renderer
  // async-state invariant.

  // A null page is not "no changes". Before the first read answers, the
  // surface knows nothing, and it may claim neither an empty workspace nor a
  // failure. The moment the read answers with an empty timeline, the empty
  // copy is earned.

  // One refresh issues three reads, and they answer three different
  // questions. Awaiting them as one batch made the timeline report a failure
  // that happened somewhere else — the engine had already served the page.
  // The failure is still reported; it is reported about the read that had it.

  // The reverse path, end to end. Separating the lanes took one away: a
  // sibling that fails while the page succeeds renders the timeline, and the
  // timeline hides History's Try again — so the only control that could reach
  // this read is the one on the banner. It has to work, not just be there.
  it("asks the failed lane again from the banner", async () => {
    const syncingStatus = { ...SYNC_STATUS, state: "syncing" as const };
    let nextStatus: typeof SYNC_STATUS | typeof syncingStatus = SYNC_STATUS;
    let failNextRead = false;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listHistory = vi.fn(async () => historyPage([historyMoment("m-1", "Wrote the plan")]));
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

    await waitFor(() => expect(screen.getByTestId("sync-status").dataset.state).toBe("syncing"));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
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
          historyPage([historyMoment("m-draft", "Wrote the note in the draft")], "draft-1"),
        );
      }
      return Promise.resolve(historyPage([historyMoment("m-main", "Back on main")], "main"));
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
        id: "draft-1",
        name: "Draft",
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
        activeVersionId: versionReads === 1 ? "draft-1" : "main",
        ...historyPageFields,
      };
    });
    bridge.switchWorkspaceVersion = vi.fn(async () => ({
      activeVersionId: "main",
      ...historyPageFields,
      changedFileCount: 0,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-history"));
    expect(await screen.findByText("Wrote the note in the draft")).toBeTruthy();

    await user.click(await screen.findByTestId("version-menu-button"));
    const mainItem = (await screen.findAllByTestId("version-item")).find(
      (item) => item.dataset.versionId === "main",
    );
    await user.click(mainItem!);
    expect(await screen.findByText("Back on main")).toBeTruthy();
    expect(screen.queryByText("Wrote the note in the draft")).toBeNull();
    expect(screen.queryByTestId("history-load-failed")).toBeNull();
  });

  // Announcing the switch first re-keys this component. The re-key must not
  // bump the counter the operation checks itself against. If it did, the
  // switch would invalidate its own token while its follow-up re-read was
  // still pending, its finally would skip, and the selector would sit
  // disabled on "Switching…" for the rest of the session. Liveness and
  // operation identity are different questions.

  // The switch says where the workspace landed before it awaits anything
  // else. Announcing after the selector's own re-read would leave an
  // old-version answer arriving during that read to meet an unset boundary.
  // The re-read here never settles, which is what a slow one looks like from
  // the timeline's side.

  // Main serves these calls concurrently, so a request issued earlier can
  // answer later. Two activity refreshes are both superseded by the switch's
  // own refresh. When that one fails, neither answer paints, whichever
  // version it describes; the rows the switch dropped stay gone.

  // The same callback runs for merges and conflict resolutions, neither of
  // which changes the active version. Its refresh supersedes the one a
  // pagination was holding. When that refresh and
  // the pagination both fail, the rows on screen stay; the held answer, asked
  // again since, does not paint. (useHistoryPage.test.tsx pins that a version
  // statement alone keeps a held refresh.)

  // A failure is an answer for the version rule: it answers about somewhere
  // the user has left. The switch bumps the issue counter but not the
  // committed watermark, so the old pagination's rejection still read as
  // "about the open timeline" and posted a banner for a version nobody is
  // looking at.

  // Main pushes each change of the run slot, so the dot needs no read on
  // refresh: a run seen by Settings or by chat dispatch shows the same way.

  // A failure reports, and it takes nothing. The lane's watermark is what an
  // answer earns: a read that failed proves nothing, and the older read still
  // in flight may be the only answer anyone gets. Moving the watermark on a
  // rejection would reject that answer when it lands, and the workspace status would
  // sit on a value the workspace has left with nothing to correct it.

  // What `committed` is for, on the success path: latest-committed-wins. Two
  // refreshes overlap, the newer answers first, and the older must not paint
  // its stale value over it when it finally lands.

  // A failure whose question was already asked again. The newer read has not
  // answered yet — so "what did this lane last write" cannot see it, and the
  // failure looks like
  // the newest thing there is. It is not: the lane has already asked again.
  // Reporting raises a banner that the newer answer will not take down, and it
  // then sits over a value the user can see is current.
});

// A shared view's open deliberately installed no capture, and main refuses
// every version call.
// The selector retried five times and then raised a danger-tone shell error
// naming a Settings toggle nobody touched, and it came back on every share
// refresh (the selector re-keys on versionEpoch).

// The same error loop from the other cause, on a workspace that is not
// a shared view. After a failed capture build main has no capture, so every
// version call is refused while the renderer's own settings read still says
// engine-on. Versions must follow main's status override as history does, or
// the selector renders, retries, and raises the danger banner.

// Virtual tabs survive restore, so a moment-diff tab outlives the History
// surface that opened it. A shared view opens the change its share imported,
// read-only: it has no recorder, so it offers no restore.
describe("shared view moment-diff tab", () => {
  const MOMENT_TAB = momentDiffTabPath("m-1");

  it("opens a persisted moment-diff tab read-only from the share's imported history", async () => {
    const bridge = makeShareBridge(Promise.resolve(storedStateWithTabs([MOMENT_TAB], MOMENT_TAB)));
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
    renderShell(bridge, SHARE_VIEW);

    await screen.findByTestId("engine-moment-diff-page");
    expect(bridge.readEngineMoment).toHaveBeenCalledWith({
      workspaceId: SHARE_VIEW.workspaceId,
      momentId: "m-1",
    });
    await userEvent.setup().click(screen.getByTestId("engine-diff-more"));
    expect(screen.getByTestId("engine-diff-open-file")).toBeTruthy();
    for (const control of [
      "engine-diff-restore-file",
      "engine-diff-shared-restore",
      "engine-diff-stop-and-restore",
      "engine-diff-undo-restore",
    ]) {
      expect(screen.queryByTestId(control)).toBeNull();
    }
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // Before main decides, the tab claims nothing and reads nothing.
});

// The same tab, the other cause. Gated on the share fact alone, a workspace
// whose recorder failed to build would still mount EngineMomentDiffPage,
// which calls readEngineMoment on mount and falls into its own error state.
// Reached by opening a moment diff while healthy and restarting after a
// failed build.
describe("moment-diff tab after a failed capture build", () => {
  const MOMENT_TAB = momentDiffTabPath("m-1");
  const FAILED_STATUS = {
    ...SYNC_STATUS,
    historyRecordingUnavailable: true,
  };

  it("states the capability instead of a page that can only fail", async () => {
    const status = deferred<typeof FAILED_STATUS>();
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs([MOMENT_TAB], MOMENT_TAB)));
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
