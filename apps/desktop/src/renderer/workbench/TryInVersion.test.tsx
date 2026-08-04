// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TryInVersionRunState } from "../../ipc/bridgeContract";
import { TryInVersionBanner, TryInVersionReviewCard } from "./TryInVersion";
import { TryTaskDialog, VersionMenu } from "./WorkspaceVersions";

// PR 0N-2 renderer surfaces: the task dialog (gesture entry), the running
// banner, and the review card. The bridge is the real preload surface shape,
// mocked per test.

const bridgeMock = {
  probeAgentDrivers: vi.fn(),
  tryInWorkspaceVersion: vi.fn(),
  dismissTryInVersionReview: vi.fn(),
  listWorkspaceVersions: vi.fn(),
  switchWorkspaceVersion: vi.fn(),
};

function driverProbe(installed: boolean) {
  return {
    drivers: [
      {
        id: "codex-app-server",
        displayName: "Codex",
        installed,
        auth: { status: "unknown" as const },
        models: [],
      },
    ],
    session: null,
  };
}

function reviewState(overrides: Partial<TryInVersionRunState> = {}): TryInVersionRunState {
  return {
    status: "review",
    task: "tidy the notes",
    versionId: "try-1",
    versionName: "Try: tidy the notes",
    runId: "run-1",
    startedAtMs: 1,
    endedAtMs: 2,
    runOutcome: "complete",
    changedFileCount: 2,
    mergeAvailable: true,
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  bridgeMock.probeAgentDrivers.mockResolvedValue(driverProbe(false));
  bridgeMock.tryInWorkspaceVersion.mockResolvedValue({
    versionId: "try-1",
    versionName: "Try: tidy the notes",
    runId: "run-1",
  });
  bridgeMock.dismissTryInVersionReview.mockResolvedValue(undefined);
  bridgeMock.listWorkspaceVersions.mockResolvedValue({
    versions: [
      { id: "main", name: "Main", kind: "main", createdAtMs: 0, canMergeIntoMain: false },
      { id: "try-1", name: "Try: tidy the notes", kind: "named", createdAtMs: 1, canMergeIntoMain: true },
    ],
    activeVersionId: "try-1",
  });
  bridgeMock.switchWorkspaceVersion.mockResolvedValue({
    activeVersionId: "main",
    changedFileCount: 1,
  });
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("TryTaskDialog", () => {
  it("saves the open draft first, then starts the gesture without a driver", async () => {
    const order: string[] = [];
    const flushActiveDraft = vi.fn(async () => {
      order.push("flush");
    });
    bridgeMock.tryInWorkspaceVersion.mockImplementation(async () => {
      order.push("start");
      return { versionId: "try-1", versionName: "Try: tidy the notes", runId: "run-1" };
    });
    const onStarted = vi.fn();
    const user = userEvent.setup();
    render(
      <TryTaskDialog
        workspaceId="ws-try"
        activeTabDirty={true}
        flushActiveDraft={flushActiveDraft}
        onStarted={onStarted}
        onClose={() => {}}
      />,
    );

    // The dirty-editor guard is explicit copy: saving happens before trying.
    expect(screen.getByTestId("try-task-dialog").textContent).toContain(
      "Your unsaved changes are saved first.",
    );
    // No installed agent tool -> honest helper line, bare run.
    await waitFor(() =>
      expect(screen.getByTestId("try-task-helper").textContent).toContain(
        "No agent app was found",
      ),
    );

    await user.type(screen.getByTestId("try-task-input"), "tidy the notes");
    await user.click(screen.getByTestId("try-task-start"));

    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(order).toEqual(["flush", "start"]);
    expect(bridgeMock.tryInWorkspaceVersion).toHaveBeenCalledWith({
      workspaceId: "ws-try",
      task: "tidy the notes",
    });
  });

  it("hands the task to the first installed driver when one exists", async () => {
    bridgeMock.probeAgentDrivers.mockResolvedValue(driverProbe(true));
    const user = userEvent.setup();
    render(
      <TryTaskDialog
        workspaceId="ws-try"
        activeTabDirty={false}
        flushActiveDraft={async () => {}}
        onStarted={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("try-task-helper").textContent).toContain(
        "Codex will do the work",
      ),
    );
    await user.type(screen.getByTestId("try-task-input"), "tidy the notes");
    await user.click(screen.getByTestId("try-task-start"));
    await waitFor(() =>
      expect(bridgeMock.tryInWorkspaceVersion).toHaveBeenCalledWith({
        workspaceId: "ws-try",
        task: "tidy the notes",
        driverId: "codex-app-server",
      }),
    );
  });

  it("keeps Start disabled until the task has content, and surfaces failures inline", async () => {
    bridgeMock.tryInWorkspaceVersion.mockRejectedValue(
      new Error(
        "Error invoking remote method 'desktop:try-in-workspace-version': Error: Versions are not enabled for this workspace.",
      ),
    );
    const user = userEvent.setup();
    render(
      <TryTaskDialog
        workspaceId="ws-try"
        activeTabDirty={false}
        flushActiveDraft={async () => {}}
        onStarted={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("try-task-helper").textContent).not.toContain(
        "Checking",
      ),
    );
    expect((screen.getByTestId("try-task-start") as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByTestId("try-task-input"), "tidy");
    expect((screen.getByTestId("try-task-start") as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByTestId("try-task-start"));
    await waitFor(() =>
      expect(screen.getByTestId("try-task-error").textContent).toBe(
        "Versions are not enabled for this workspace.",
      ),
    );
  });
});

describe("TryInVersionBanner", () => {
  it("states the task and version", () => {
    render(
      <TryInVersionBanner task="tidy the notes" versionName="Try: tidy the notes" />,
    );
    const banner = screen.getByTestId("try-run-banner");
    expect(banner.textContent).toContain("An agent is trying:");
    expect(screen.getByTestId("try-run-banner-task").textContent).toBe("tidy the notes");
    expect(banner.textContent).toContain("in Try: tidy the notes");
  });
});

describe("TryInVersionReviewCard", () => {
  function renderCard(state: TryInVersionRunState, handlers?: {
    onOpenCompare?: (versionId: string) => void;
    onDismissed?: () => void;
    onWorkspaceStateChanged?: (activeVersionId?: string) => void;
    flushActiveDraft?: () => Promise<void>;
  }) {
    return render(
      <TryInVersionReviewCard
        workspaceId="ws-try"
        state={state}
        activeTabDirty={false}
        flushActiveDraft={handlers?.flushActiveDraft ?? (async () => {})}
        onOpenCompare={handlers?.onOpenCompare ?? (() => {})}
        onWorkspaceStateChanged={handlers?.onWorkspaceStateChanged ?? (() => {})}
        onDismissed={handlers?.onDismissed ?? (() => {})}
      />,
    );
  }

  it("takes focus on appear and states the changed-file count", () => {
    renderCard(reviewState());
    const card = screen.getByTestId("try-review-card");
    expect(document.activeElement).toBe(card);
    expect(screen.getByTestId("try-review-summary").textContent).toContain(
      "2 files changed in Try: tidy the notes",
    );
  });

  it("opens the compare tab from Review changes (card stays)", async () => {
    const onOpenCompare = vi.fn();
    const user = userEvent.setup();
    renderCard(reviewState(), { onOpenCompare });
    await user.click(screen.getByTestId("try-review-open-compare"));
    expect(onOpenCompare).toHaveBeenCalledWith("try-1");
    expect(screen.getByTestId("try-review-card")).toBeTruthy();
  });

  it("Keep working in it dismisses through main and notifies the shell", async () => {
    const onDismissed = vi.fn();
    const user = userEvent.setup();
    renderCard(reviewState(), { onDismissed });
    await user.click(screen.getByTestId("try-review-keep-working"));
    await waitFor(() => expect(onDismissed).toHaveBeenCalledOnce());
    expect(bridgeMock.dismissTryInVersionReview).toHaveBeenCalledWith({
      workspaceId: "ws-try",
    });
    expect(bridgeMock.switchWorkspaceVersion).not.toHaveBeenCalled();
  });

  it("Set aside switches back to Main and clears the review", async () => {
    const onDismissed = vi.fn();
    const onWorkspaceStateChanged = vi.fn();
    const user = userEvent.setup();
    renderCard(reviewState(), { onDismissed, onWorkspaceStateChanged });
    await user.click(screen.getByTestId("try-review-set-aside"));
    await waitFor(() => expect(onDismissed).toHaveBeenCalledOnce());
    expect(bridgeMock.switchWorkspaceVersion).toHaveBeenCalledWith({
      workspaceId: "ws-try",
      versionId: "main",
    });
    expect(bridgeMock.dismissTryInVersionReview).toHaveBeenCalledOnce();
    expect(onWorkspaceStateChanged).toHaveBeenCalled();
  });

  // #579 review r11: the pre-switch flush is the SAME class the version menu
  // fixed in r7, on the second switch surface. When the flush fails the
  // switch never starts and the workspace never leaves its version —
  // announcing a change would reopen the open document and set its
  // still-editable draft aside for nothing (#567).
  it("announces nothing when the pre-switch flush fails before the switch starts", async () => {
    const onWorkspaceStateChanged = vi.fn();
    const user = userEvent.setup();
    renderCard(reviewState(), {
      onWorkspaceStateChanged,
      flushActiveDraft: async () => {
        throw new Error("disk full");
      },
    });
    await user.click(screen.getByTestId("try-review-set-aside"));

    // MUTATION (switchIssued in backToMain): announce unconditionally from
    // the catch. The bookkeeping reopen then sets the draft aside on the
    // version the user never left.
    await waitFor(() =>
      expect(screen.getByTestId("try-review-error")).toBeTruthy(),
    );
    expect(bridgeMock.switchWorkspaceVersion).not.toHaveBeenCalled();
    expect(onWorkspaceStateChanged).not.toHaveBeenCalled();
  });

  // ...but a failure AFTER the switch IPC started must still announce: main
  // settles and closes live Y.Doc sessions on its way, so the reopen is what
  // re-binds them.
  it("still announces when the switch itself fails mid-way", async () => {
    const onWorkspaceStateChanged = vi.fn();
    const user = userEvent.setup();
    bridgeMock.switchWorkspaceVersion.mockRejectedValueOnce(
      new Error("switch failed mid-way"),
    );
    renderCard(reviewState(), { onWorkspaceStateChanged });
    await user.click(screen.getByTestId("try-review-set-aside"));
    await waitFor(() =>
      expect(bridgeMock.switchWorkspaceVersion).toHaveBeenCalled(),
    );
    await waitFor(() => expect(onWorkspaceStateChanged).toHaveBeenCalled());
    // Nobody knows what stuck, so the shell is sent to ask.
    expect(onWorkspaceStateChanged).toHaveBeenCalledWith(undefined);
  });

  // #579 review r15: the announcement already happened at line 161, before
  // the dismissal IPC. A dismissal that fails afterwards does not un-know
  // where the workspace landed, and announcing twice bumps the version epoch
  // a SECOND time — that same-version reopen sets aside a draft the user
  // typed while the dismissal hung, for a failure that has nothing to do with
  // the version.
  it("announces the landing once when only the dismissal fails", async () => {
    const onWorkspaceStateChanged = vi.fn();
    const user = userEvent.setup();
    bridgeMock.dismissTryInVersionReview.mockRejectedValueOnce(
      new Error("dismissal failed"),
    );
    renderCard(reviewState(), { onWorkspaceStateChanged });
    await user.click(screen.getByTestId("try-review-set-aside"));
    await waitFor(() =>
      expect(screen.getByTestId("try-review-error")).toBeTruthy(),
    );

    // MUTATION (double bump): drop the `landedOn !== undefined` return. The
    // catch announces the same landing again and reopens Main twice.
    expect(onWorkspaceStateChanged).toHaveBeenCalledTimes(1);
    expect(onWorkspaceStateChanged).toHaveBeenCalledWith("main");
  });

  it("says so plainly when the agent changed nothing and offers the way back", () => {
    renderCard(reviewState({ changedFileCount: 0 }));
    expect(screen.getByTestId("try-review-card").textContent).toContain(
      "The agent didn't change any files",
    );
    expect(screen.getByTestId("try-review-back-to-main")).toBeTruthy();
    expect(screen.queryByTestId("try-review-merge")).toBeNull();
    expect(screen.queryByTestId("try-review-open-compare")).toBeNull();
  });

  it("hides Merge into Main when the version cannot merge, and stays honest without a count", () => {
    renderCard(reviewState({ mergeAvailable: false, changedFileCount: null }));
    expect(screen.queryByTestId("try-review-merge")).toBeNull();
    expect(screen.getByTestId("try-review-summary").textContent).toContain(
      "open the comparison to see what changed",
    );
  });

  it("reports a failed run without hiding the review actions", () => {
    renderCard(reviewState({ runOutcome: "failed", changedFileCount: 1 }));
    expect(screen.getByTestId("try-review-card").textContent).toContain(
      "The agent stopped before finishing",
    );
    expect(screen.getByTestId("try-review-open-compare")).toBeTruthy();
  });
});

describe("VersionMenu refreshKey (regression: external version switches)", () => {
  it("re-reads the active version when the shell bumps refreshKey", async () => {
    function menu(refreshKey: number) {
      return (
        <VersionMenu
          workspaceId="ws-try"
          activeTabDirty={false}
          flushActiveDraft={async () => {}}
          onOpenCompare={() => {}}
          onWorkspaceStateChanged={() => {}}
          onError={() => {}}
          refreshKey={refreshKey}
        />
      );
    }
    const view = render(menu(0));
    await waitFor(() =>
      expect(screen.getByTestId("version-menu-active").textContent).toBe(
        "Try: tidy the notes",
      ),
    );

    // The 0N-2 review card switches back to Main OUTSIDE this menu; the shell
    // bumps versionEpoch -> refreshKey. Without the re-read the selector kept
    // showing the stale try-version name.
    bridgeMock.listWorkspaceVersions.mockResolvedValue({
      versions: [
        { id: "main", name: "Main", kind: "main", createdAtMs: 0, canMergeIntoMain: false },
        { id: "try-1", name: "Try: tidy the notes", kind: "named", createdAtMs: 1, canMergeIntoMain: true },
      ],
      activeVersionId: "main",
    });
    view.rerender(menu(1));
    await waitFor(() =>
      expect(screen.getByTestId("version-menu-active").textContent).toBe("Main"),
    );
  });
});
