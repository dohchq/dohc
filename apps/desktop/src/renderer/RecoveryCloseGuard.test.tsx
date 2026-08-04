// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./ErrorBoundary";
import {
  RecoveryCloseGuard,
  requestGuardedUpdateInstall,
  resetGuardedExits,
} from "./RecoveryCloseGuard";
import {
  captureOrphanedDraft,
  dismissOrphanedDraft,
  noteWorkspaceLabel,
  orphanedDraftCount,
  orphanedDraftIds,
  resetOrphanedDrafts,
} from "./orphanedDrafts";

// The quit bridge is a REQUIRED contract (#579 review, r15): the guard calls
// onQuitRequested / onRecoveryCheckRequested directly, so a stub that omits
// them is a mismatched build and must fail loudly. Every test therefore
// stubs the whole surface and overrides only what it asserts on.
function stubBridge(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal("dohcDesktop", {
    onQuitRequested: () => () => undefined,
    onRecoveryCheckRequested: () => () => undefined,
    answerRecoveryCheck: async () => undefined,
    holdQuit: async () => undefined,
    resumeQuit: async () => undefined,
    ...overrides,
  });
}

// Every test gets the full contract; overrides replace it where asserted on.
beforeEach(() => {
  stubBridge();
});

afterEach(() => {
  cleanup();
  resetGuardedExits();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetOrphanedDrafts();
});

// #567 / #579 review r4+r5: set-aside drafts live in renderer memory only,
// so closing or reloading the window is the one irreversible exit. The guard
// announces it first — and carries the full recovery list, so the warning
// offers the very actions it demands.
describe("RecoveryCloseGuard", () => {
  it("warns before closing while set-aside edits exist, offers the list, and closes on 'Close anyway'", async () => {
    const user = userEvent.setup();
    noteWorkspaceLabel("ws-1", "Personal notes");
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    // The guard is deliberately GLOBAL (#579 review, r6): the whole renderer
    // dies at once, so every workspace's drafts are at stake here.
    captureOrphanedDraft("ws-2", "other.md", "Also kept!");
    render(
      <RecoveryCloseGuard>
        <div data-testid="app-content" />
      </RecoveryCloseGuard>,
    );
    screen.getByTestId("app-content");

    // MUTATION (close guard): remove the beforeunload interception. The
    // close proceeds unannounced and every set-aside edit dies with it.
    const first = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(first);
    });
    expect(first.defaultPrevented).toBe(true);
    await screen.findByTestId("recovery-close-warning");

    // The dialog carries the recovery itself (#579 review, r5): Copy works
    // right here, path-labeled, whether or not the file still exists — and
    // BOTH workspaces' drafts are listed.
    // MUTATION (dialog list): drop <RecoveryList /> from the dialog — the
    // warning then demands actions it does not offer.
    const rows = screen.getAllByTestId("recovery-list-row");
    expect(rows).toHaveLength(2);
    const row = rows.find((candidate) =>
      candidate.textContent?.includes("a.md"),
    )!;
    expect(rows.some((candidate) => candidate.textContent?.includes("other.md"))).toBe(
      true,
    );
    // The GLOBAL list names each row's workspace — two workspaces can hold
    // the same path, and Copy/Dismiss must be tellable apart (#579 review,
    // r7) — with the NAME the UI shows, not the raw UUID (#579 review,
    // r10); an unregistered workspace falls back to its id.
    // MUTATION (workspace labels): drop the label span or show the raw id.
    // Identical paths from two workspaces are indistinguishable.
    const labels = screen
      .getAllByTestId("recovery-list-workspace")
      .map((label) => label.textContent);
    expect(labels).toContain("Personal notes");
    expect(labels).toContain("ws-2");
    await user.click(within(row).getByTestId("recovery-list-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Kept!"),
    );

    // Go back keeps everything.
    await user.click(screen.getByTestId("recovery-close-goback"));
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();

    // Close anyway releases the guard and re-runs the close.
    const closeSpy = vi
      .spyOn(window, "close")
      .mockImplementation(() => undefined);
    const second = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(second);
    });
    await user.click(await screen.findByTestId("recovery-close-anyway"));
    expect(closeSpy).toHaveBeenCalled();
    const third = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(third);
    });
    expect(third.defaultPrevented).toBe(false);
    closeSpy.mockRestore();
  });

  // #579 review r15: the bridge and the preload gained both quit listeners in
  // this same change. Treating them as optional would define a SECOND
  // supported preload — one where the renderer silently drops native-quit
  // handling — and every future change would have to keep that path alive.
  // There are no users and no old preloads to carry.
  it("fails loudly on a preload without the quit contract", () => {
    vi.stubGlobal("dohcDesktop", { installUpdate: async () => undefined });
    // MUTATION (optional contract): restore `onQuitRequested?.(...)` and the
    // catch-based fallback. This render then succeeds with native-quit
    // handling missing, and the mismatched build ships unnoticed.
    expect(() =>
      render(
        <RecoveryCloseGuard>
          <div />
        </RecoveryCloseGuard>,
      ),
    ).toThrow(/is not a function/);
  });

  it("does not intercept closing when no set-aside edits exist", async () => {
    render(
      <RecoveryCloseGuard>
        <div data-testid="app-content" />
      </RecoveryCloseGuard>,
    );
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();
  });

  it("dismissing the last draft from the dialog is resolution — the next close proceeds", async () => {
    const user = userEvent.setup();
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    const first = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(first);
    });
    await screen.findByTestId("recovery-close-warning");

    // Dismiss deletes the ONLY copy, so the destructive path REQUIRES the
    // confirm step (#579 review, r6): the first click arms it and deletes
    // nothing, and Keep backs out whole.
    // MUTATION (confirm gate): make the Dismiss button delete directly. The
    // row is gone right here and the assertions below fail.
    await user.click(screen.getByTestId("recovery-dismiss"));
    expect(screen.getByTestId("recovery-list-row")).toBeTruthy();
    await user.click(screen.getByTestId("recovery-dismiss-cancel"));
    expect(screen.getByTestId("recovery-list-row")).toBeTruthy();
    expect(screen.queryByTestId("recovery-dismiss-confirm")).toBeNull();

    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    // The last draft resolved: the dialog retires itself (#579 review, r10).
    await waitFor(() =>
      expect(screen.queryByTestId("recovery-close-warning")).toBeNull(),
    );

    const second = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(false);
  });

  // #579 review r7: the user asked for a RELOAD by name; the guard's confirm
  // must resume that action, never swap it for an exit.
  it("a blocked reload resumes as a reload, never an exit", async () => {
    const user = userEvent.setup();
    const reloadRenderer = vi.fn(async () => undefined);
    stubBridge({ reloadRenderer });
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    const Thrower = (): never => {
      throw new Error("boom");
    };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    render(
      <RecoveryCloseGuard>
        <AppErrorBoundary>
          <Thrower />
        </AppErrorBoundary>
      </RecoveryCloseGuard>,
    );
    consoleError.mockRestore();

    // The crash screen's "Reload dohc": the request reaches main once, and
    // Electron then fires beforeunload — simulated here.
    await user.click(screen.getByTestId("app-crash-reload"));
    expect(reloadRenderer).toHaveBeenCalledTimes(1);
    const blocked = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(blocked);
    });
    expect(blocked.defaultPrevented).toBe(true);
    await screen.findByTestId("recovery-close-warning");
    expect(screen.getByTestId("recovery-close-anyway").textContent).toBe(
      "Reload anyway",
    );

    // MUTATION (retain the action): make the confirm call window.close()
    // unconditionally. The user asked to RELOAD and gets an exit.
    const closeSpy = vi
      .spyOn(window, "close")
      .mockImplementation(() => undefined);
    await user.click(screen.getByTestId("recovery-close-anyway"));
    expect(reloadRenderer).toHaveBeenCalledTimes(2);
    expect(closeSpy).not.toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  // #579 review r10: electron-updater's quitAndInstall is ONE-SHOT, so the
  // decision comes BEFORE the destructive call — with drafts present, the
  // dialog opens INSTEAD of the install, and its confirm makes the one and
  // only quitAndInstall request.
  it("a blocked update restart defers the install and confirms into the only call", async () => {
    const user = userEvent.setup();
    const readyState = {
      status: "ready" as const,
      message: "Update 1.2.4 is ready.",
      currentVersion: "1.2.3",
      channel: "latest",
      canCheck: false,
      canInstall: true,
      version: "1.2.4",
    };
    const installUpdate = vi.fn(async () => ({
      accepted: true,
      completed: false,
      state: readyState,
    }));
    stubBridge({ installUpdate });
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );

    // MUTATION (decide-first): call installUpdate before the drafts check.
    // The one-shot latch is burned while the quit gets vetoed, and no
    // confirm can ever restart.
    const blocked = await requestGuardedUpdateInstall();
    expect(blocked).toBeNull();
    expect(installUpdate).not.toHaveBeenCalled();
    await screen.findByTestId("recovery-close-warning");
    expect(screen.getByTestId("recovery-close-anyway").textContent).toBe(
      "Restart anyway",
    );

    const closeSpy = vi
      .spyOn(window, "close")
      .mockImplementation(() => undefined);
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
    expect(closeSpy).not.toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it("installs at once when no set-aside edits exist", async () => {
    const installUpdate = vi.fn(async () => ({
      accepted: true,
      completed: false,
      state: {
        status: "ready" as const,
        message: "Update 1.2.4 is ready.",
        currentVersion: "1.2.3",
        channel: "latest",
        canCheck: false,
        canInstall: true,
        version: "1.2.4",
      },
    }));
    stubBridge({ installUpdate });
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    const result = await requestGuardedUpdateInstall();
    expect(result?.accepted).toBe(true);
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();
  });

  // #579 review r9: the bypass is scoped to the one resumed unload attempt.
  // If the resume fails without unloading, the guard must come BACK — a
  // stuck bypass would let the next ordinary close destroy every draft
  // silently.
  it("re-arms the guard when the resumed action fails to unload", async () => {
    const user = userEvent.setup();
    const installUpdate = vi.fn(async () => ({
      accepted: false,
      completed: false,
      state: {
        status: "ready" as const,
        message: "Update 1.2.4 is ready.",
        currentVersion: "1.2.3",
        channel: "latest",
        canCheck: false,
        canInstall: true,
        version: "1.2.4",
      },
    }));
    stubBridge({ installUpdate });
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );

    await requestGuardedUpdateInstall();
    await screen.findByTestId("recovery-close-warning");
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });

    // MUTATION (scoped bypass): leave the bypass set after a failed resume.
    // This close then passes unguarded and the drafts die silently.
    const second = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(true);
    expect(await screen.findByTestId("recovery-close-warning")).toBeTruthy();
  });

  // #579 review r12: main re-asks at the QUIT BOUNDARY, because a reopen can
  // set an edit aside after the renderer's own pre-install check. The answer
  // must be read when main asks, not when the install was requested.
  it("answers main's boundary re-check with the state at answer time", async () => {
    let checkListener: ((requestId: number) => void) | null = null;
    const onRecoveryCheckRequested = vi.fn((listener: (id: number) => void) => {
      checkListener = listener;
      return () => {
        checkListener = null;
      };
    });
    const answerRecoveryCheck = vi.fn(async () => undefined);
    stubBridge({ onRecoveryCheckRequested, answerRecoveryCheck });
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await waitFor(() => expect(checkListener).not.toBeNull());

    // Nothing set aside yet: the install may proceed.
    act(() => {
      checkListener?.(1);
    });
    await waitFor(() =>
      expect(answerRecoveryCheck).toHaveBeenCalledWith({
        requestId: 1,
        blocked: false,
      }),
    );

    // A reopen sets an edit aside INSIDE the gap — the very race this
    // re-check exists for.
    // MUTATION (boundary re-check): answer a snapshot taken when the install
    // was requested (or never register this listener). The install proceeds
    // and quitAndInstall destroys the only copy.
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    act(() => {
      checkListener?.(2);
    });
    await waitFor(() =>
      expect(answerRecoveryCheck).toHaveBeenCalledWith({
        requestId: 2,
        blocked: true,
      }),
    );
  });

  // #579 review r13 + r14: an approval is only valid for the store state it
  // was given. "Restart anyway" approves losing the drafts the dialog LISTED,
  // and quitAndInstall is one-shot — so the boundary re-check reads the LIVE
  // store instead of trusting the confirm, and a draft that appears after it
  // brings the decision back to the user with its text intact.
  function confirmedRestartHarness(
    options: { accepted?: boolean; onInstall?: () => void } = {},
  ) {
    const accepted = options.accepted ?? true;
    const readyState = {
      status: "ready" as const,
      message: "Update 1.2.4 is ready.",
      currentVersion: "1.2.3",
      channel: "latest",
      canCheck: false,
      canInstall: true,
      version: "1.2.4",
    };
    const installUpdate = vi.fn(async () => {
      options.onInstall?.();
      return { accepted, completed: false, state: readyState };
    });
    const answerRecoveryCheck = vi.fn(async () => undefined);
    const resumeQuit = vi.fn(async () => undefined);
    let checkListener: ((requestId: number) => void) | null = null;
    stubBridge({
      installUpdate,
      answerRecoveryCheck,
      resumeQuit,
      onRecoveryCheckRequested: (listener: (requestId: number) => void) => {
        checkListener = listener;
        return () => {
          checkListener = null;
        };
      },
    });
    return {
      installUpdate,
      answerRecoveryCheck,
      resumeQuit,
      askBoundaryCheck: (requestId: number) => {
        act(() => {
          checkListener?.(requestId);
        });
      },
      ready: async () => {
        await waitFor(() => expect(checkListener).not.toBeNull());
      },
    };
  }

  it("lets the approved list through without asking again", async () => {
    const user = userEvent.setup();
    const harness = confirmedRestartHarness();
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await harness.ready();

    await requestGuardedUpdateInstall();
    await screen.findByTestId("recovery-close-warning");
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(harness.installUpdate).toHaveBeenCalledTimes(1));

    // MUTATION (approval snapshot): leave approvedDraftIds empty at the
    // confirm. Every gate then reports the drafts the user JUST approved
    // losing, and no restart can ever run.
    harness.askBoundaryCheck(1);
    await waitFor(() =>
      expect(harness.answerRecoveryCheck).toHaveBeenCalledWith({
        requestId: 1,
        blocked: false,
      }),
    );
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  // #579 review r14: refusing the exit is only half an answer — the user
  // clicked "Restart anyway" and must not be left with a silent no-op. The
  // draft that stopped the restart comes back in the dialog, with its Copy
  // button, so the second confirm is made over the real full list.
  it("brings the decision back when a new draft stops the restart", async () => {
    const user = userEvent.setup();
    // Main refuses the install: its boundary re-check saw the new draft.
    // A reopen queued behind the click sets one more edit aside while the
    // install request is in flight — the window main's boundary re-check
    // exists for. It keeps its place in the store: refusing the capture would
    // strand the text in an editor the restart is about to destroy.
    let reopened = false;
    const harness = confirmedRestartHarness({
      accepted: false,
      onInstall: () => {
        if (reopened) return;
        reopened = true;
        captureOrphanedDraft("ws-1", "b.md", "Typed in the gap");
      },
    });
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await harness.ready();

    await requestGuardedUpdateInstall();
    await screen.findByTestId("recovery-close-warning");
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(harness.installUpdate).toHaveBeenCalledTimes(1));

    // MUTATION (re-prompt): re-arm the guard without re-opening the warning.
    // The restart silently never happens and the user is never shown the
    // draft that stopped it.
    const rows = await screen.findAllByTestId("recovery-list-row");
    expect(rows).toHaveLength(2);
    const fresh = rows.find((row) => row.textContent?.includes("b.md"))!;
    await user.click(within(fresh).getByTestId("recovery-list-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Typed in the gap"),
    );

    // The second confirm covers BOTH, so it is not asked a third time.
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(harness.installUpdate).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();
  });

  it("re-arms in silence when the resumed action fails for its own reasons", async () => {
    const user = userEvent.setup();
    const harness = confirmedRestartHarness({ accepted: false });
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await harness.ready();

    await requestGuardedUpdateInstall();
    await screen.findByTestId("recovery-close-warning");
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(harness.installUpdate).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });

    // MUTATION (scoped re-prompt): re-open the warning on ANY failed resume.
    // An updater that is simply not ready then re-asks a question the user
    // already answered, every time, with nothing new to show.
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();
  });

  it("blocks the exit for a draft the approval never covered", async () => {
    const user = userEvent.setup();
    const harness = confirmedRestartHarness();
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    const [approvedId] = orphanedDraftIds();
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await harness.ready();

    await requestGuardedUpdateInstall();
    await screen.findByTestId("recovery-close-warning");
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(harness.installUpdate).toHaveBeenCalledTimes(1));

    // A reopen queued behind the click sets one more edit aside. The guard
    // must answer from what is THERE, not from "the user already confirmed".
    // The approved draft is dismissed in the same window, so the COUNT is
    // unchanged: only the drafts' identity says the list is no longer the one
    // that was approved.
    dismissOrphanedDraft("ws-1", "a.md", approvedId);
    captureOrphanedDraft("ws-1", "b.md", "Never shown");
    expect(orphanedDraftCount()).toBe(1);

    // MUTATION (stale bypass): answer `!bypassCloseGuard.current &&
    // orphanedDraftCount() > 0`. The re-check reports clear and quitAndInstall
    // destroys the only copy of a draft that was in no warning.
    harness.askBoundaryCheck(1);
    await waitFor(() =>
      expect(harness.answerRecoveryCheck).toHaveBeenCalledWith({
        requestId: 1,
        blocked: true,
      }),
    );

    // The same live answer governs the unload the bypass was meant to permit.
    // MUTATION (bypassed unload): return early whenever the bypass is set.
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    // A fresh decision over what is actually there, approvals cleared.
    const rows = await screen.findAllByTestId("recovery-list-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("b.md");

    // ...and it is still the RESTART the user asked for (#579 review, r16).
    // A warning that cannot tell close from restart passes either way, so
    // assert the action, not just its presence.
    // MUTATION (update intent): stop claiming pendingUnload in beginInstall.
    // The warning degrades to "Close", and confirming calls window.close()
    // instead of resuming the quit quitAndInstall already started — whose
    // one-shot latch is spent, so no later confirm can ever restart.
    expect(screen.getByTestId("recovery-close-anyway").textContent).toBe(
      "Restart anyway",
    );
    const closeSpy = vi
      .spyOn(window, "close")
      .mockImplementation(() => undefined);
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(harness.resumeQuit).toHaveBeenCalledTimes(1));
    expect(closeSpy).not.toHaveBeenCalled();
    expect(harness.installUpdate).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });

  // #579 review r17: a draft appearing after main's recovery check opens the
  // late warning, and "Go back" saves the text — but quitAndInstall has
  // already run by then. The restart must stay finishable, or Go back is a
  // reverse path that reverses nothing and the update strands for the run.
  it("finishes a staged restart on the next Restart instead of re-installing", async () => {
    const user = userEvent.setup();
    let reopened = false;
    const harness = confirmedRestartHarness({
      onInstall: () => {
        if (reopened) return;
        reopened = true;
        captureOrphanedDraft("ws-1", "b.md", "Typed in the gap");
      },
    });
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await harness.ready();

    await requestGuardedUpdateInstall();
    await screen.findByTestId("recovery-close-warning");
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(harness.installUpdate).toHaveBeenCalledTimes(1));

    // The late draft blocks the install's own exit, and the user goes back to
    // save it. quitAndInstall's latch is spent.
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await user.click(await screen.findByTestId("recovery-close-goback"));
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();

    // They copy the text, resolve the drafts, and ask to restart again.
    resetOrphanedDrafts();
    // MUTATION (staged restart): drop the installStaged branch from
    // requestGuardedUpdateInstall. The second Restart calls installUpdate
    // again, the spent latch refuses it, and no restart ever happens.
    await requestGuardedUpdateInstall();
    await waitFor(() => expect(harness.resumeQuit).toHaveBeenCalledTimes(1));
    expect(harness.installUpdate).toHaveBeenCalledTimes(1);
  });

  // #579 review r17: answering the quit ask "clear" does not end the story. A
  // queued reopen can still capture a draft before the quit's own unload, and
  // the warning that blocks it must resume the QUIT — window.close() leaves
  // the process running on macOS and with agent dispatch alive.
  it("keeps a native quit's intent through a draft captured after the clear answer", async () => {
    const user = userEvent.setup();
    let quitListener: (() => void) | null = null;
    const resumeQuit = vi.fn(async () => undefined);
    const holdQuit = vi.fn(async () => undefined);
    stubBridge({
      holdQuit,
      resumeQuit,
      onQuitRequested: (listener: () => void) => {
        quitListener = listener;
        return () => {
          quitListener = null;
        };
      },
    });
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await waitFor(() => expect(quitListener).not.toBeNull());

    // Nothing set aside: the renderer answers clear and main starts quitting.
    act(() => {
      quitListener?.();
    });
    await waitFor(() => expect(resumeQuit).toHaveBeenCalledTimes(1));
    expect(holdQuit).not.toHaveBeenCalled();

    // A queued reopen lands before the quit's beforeunload.
    captureOrphanedDraft("ws-1", "a.md", "Typed in the gap");
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);

    // MUTATION (quit intent): stop claiming pendingUnload before resumeQuit.
    // The warning degrades to "Close", and confirming calls window.close() —
    // which does not quit on macOS.
    expect(screen.getByTestId("recovery-close-anyway").textContent).toBe(
      "Quit anyway",
    );
    const closeSpy = vi
      .spyOn(window, "close")
      .mockImplementation(() => undefined);
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(resumeQuit).toHaveBeenCalledTimes(2));
    expect(closeSpy).not.toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  // #579 review r10: a native quit (Cmd+Q, tray Quit) is main-initiated —
  // main asks first, and the renderer's answer must resume the QUIT, never
  // swap it for a window close that leaves the process running on macOS.
  it("holds a native quit for the dialog, and 'Quit anyway' resumes the quit", async () => {
    const user = userEvent.setup();
    let quitListener: (() => void) | null = null;
    const onQuitRequested = vi.fn((listener: () => void) => {
      quitListener = listener;
      return () => {
        quitListener = null;
      };
    });
    const holdQuit = vi.fn(async () => undefined);
    const resumeQuit = vi.fn(async () => undefined);
    stubBridge({ onQuitRequested, holdQuit, resumeQuit });
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await waitFor(() => expect(quitListener).not.toBeNull());

    // MUTATION (quit hold): resume every quit ask unconditionally. The
    // drafts die with the quit, unannounced.
    act(() => {
      quitListener?.();
    });
    await waitFor(() => expect(holdQuit).toHaveBeenCalledTimes(1));
    expect(resumeQuit).not.toHaveBeenCalled();
    await screen.findByTestId("recovery-close-warning");
    expect(screen.getByTestId("recovery-close-anyway").textContent).toBe(
      "Quit anyway",
    );

    // MUTATION (resume the QUIT): make the confirm call window.close(). On
    // macOS the process keeps running after the user asked to quit.
    const closeSpy = vi
      .spyOn(window, "close")
      .mockImplementation(() => undefined);
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(resumeQuit).toHaveBeenCalledTimes(1));
    expect(closeSpy).not.toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it("resumes a quit at once when no set-aside edits exist", async () => {
    let quitListener: (() => void) | null = null;
    const onQuitRequested = vi.fn((listener: () => void) => {
      quitListener = listener;
      return () => {
        quitListener = null;
      };
    });
    const holdQuit = vi.fn(async () => undefined);
    const resumeQuit = vi.fn(async () => undefined);
    stubBridge({ onQuitRequested, holdQuit, resumeQuit });
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await waitFor(() => expect(quitListener).not.toBeNull());
    act(() => {
      quitListener?.();
    });
    await waitFor(() => expect(resumeQuit).toHaveBeenCalledTimes(1));
    expect(holdQuit).not.toHaveBeenCalled();
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();
  });

  // #579 review r10: the dialog's count is LIVE. Dismissing rows from the
  // dialog updates the sentence, and an emptied dialog has nothing left to
  // warn about — it retires itself and the next close proceeds.
  it("keeps the dialog's count live and retires it when the last draft resolves", async () => {
    const user = userEvent.setup();
    captureOrphanedDraft("ws-1", "a.md", "First!");
    captureOrphanedDraft("ws-1", "b.md", "Second!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    const first = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(first);
    });
    const dialog = await screen.findByTestId("recovery-close-warning");
    expect(dialog.textContent).toContain("2 set-aside edits are lost");

    // MUTATION (live count): render the snapshot count. Dismissing a row
    // leaves the dialog claiming two edits, then one that no longer exists.
    const firstRow = screen.getAllByTestId("recovery-list-row")[0];
    await user.click(within(firstRow).getByTestId("recovery-dismiss"));
    await user.click(
      within(firstRow).getByTestId("recovery-dismiss-confirm"),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("recovery-close-warning").textContent,
      ).toContain("1 set-aside edit is lost"),
    );

    const lastRow = screen.getByTestId("recovery-list-row");
    await user.click(within(lastRow).getByTestId("recovery-dismiss"));
    await user.click(within(lastRow).getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("recovery-close-warning")).toBeNull(),
    );
    const second = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(false);
  });

  // #579 review r5: the guard must survive a CRASH. A guard inside the
  // crashed tree unmounts with it, and the crash screen's "Reload dohc"
  // would destroy every draft silently.
  it("still warns above the crash screen, with the recovery list usable", async () => {
    const user = userEvent.setup();
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    const Thrower = (): never => {
      throw new Error("boom");
    };
    // React logs the caught error; keep the test output clean.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    render(
      <RecoveryCloseGuard>
        <AppErrorBoundary>
          <Thrower />
        </AppErrorBoundary>
      </RecoveryCloseGuard>,
    );
    consoleError.mockRestore();
    screen.getByTestId("app-crash-screen");

    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await screen.findByTestId("recovery-close-warning");
    await user.click(screen.getByTestId("recovery-list-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Kept!"),
    );
  });
});

// The wiring, not just the component: main.tsx must mount the guard ABOVE
// AppErrorBoundary. A crashed DesktopRoot leaves the crash screen up, and
// the reload it offers must still be announced.
// MUTATION (wiring): render `<AppErrorBoundary><DesktopRoot/></...>` alone
// in main.tsx (the pre-r5 shape). No guard ever mounts and the beforeunload
// below passes unprevented.
describe("main.tsx composition", () => {
  it("keeps the close guard alive above a crashed root", async () => {
    vi.doMock("./DesktopRoot", () => ({
      DesktopRoot: (): never => {
        throw new Error("boom");
      },
    }));
    // main.tsx runs initTheme(), which reads the OS theme; jsdom has no
    // matchMedia.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    const container = document.createElement("div");
    container.id = "root";
    document.body.appendChild(container);
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await import("./main");
      await screen.findByTestId("app-crash-screen");
    } finally {
      consoleError.mockRestore();
    }

    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await screen.findByTestId("recovery-close-warning");
    expect(screen.getByTestId("recovery-list-row").textContent).toContain(
      "a.md",
    );
    container.remove();
    vi.doUnmock("./DesktopRoot");
  });
});
