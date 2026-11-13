// @vitest-environment jsdom
import { registerYDocDelivery } from "./pendingYDocDeliveries";
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EngineYDocSaveStateEvent, ExitRoundMessage } from "../ipc/bridgeContract";
import { disposeEngineDocLeasesForTests } from "./collab/engineDocLease";
import {
  COLLECTION_WRITE_STALL_MS,
  CollectionFieldWriteHost,
  collectionWriteFailures,
  enqueueCollectionFieldWrite,
  resetCollectionFieldWritesForTests,
} from "./collections/recordFieldWrites";
import { AppErrorBoundary } from "./ErrorBoundary";
import {
  onRestartStopped,
  RecoveryCloseGuard,
  requestGuardedReload,
  requestGuardedUpdateInstall,
  resetGuardedExits,
} from "./RecoveryCloseGuard";
import {
  atRiskOrphanedDraftIds,
  captureOrphanedDraft,
  dismissOrphanedDraft,
  noteWorkspaceLabel,
  resetOrphanedDrafts,
  useAllOrphanedDrafts,
} from "./orphanedDrafts";
import { ORPHANED_DRAFT_STORAGE_PREFIX } from "./orphanedDraftStorage";
import { deferred } from "../testing/deferred";

function seedStoredDraft(): void {
  localStorage.setItem(
    `${ORPHANED_DRAFT_STORAGE_PREFIX}previous-run`,
    JSON.stringify({
      id: 7,
      workspaceId: "ws-1",
      path: "notes/a.md",
      text: "Survived the quit",
      capturedAtMs: Date.now(),
    }),
  );
}

// The exit bridge is a required contract: the guard calls onExitRound
// directly, so a stub that omits it is a mismatched build and must fail
// loudly. Every test therefore stubs the whole surface and overrides only
// what it asserts on.
function stubBridge(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal("dohcDesktop", {
    platform: "linux" as const,
    typingRecovery: async () => ({ failures: [] }),
    onExitRound: () => () => undefined,
    onWindowFullScreen: () => () => undefined,
    onWindowFocused: () => () => undefined,
    getSystemReducedMotion: async () => false,
    answerExitRound: async () => undefined,
    holdQuit: async () => undefined,
    resumeQuit: async () => undefined,
    ...overrides,
  });
}

function roundBridge(overrides: Record<string, unknown> = {}) {
  let listener: ((message: ExitRoundMessage) => void) | null = null;
  const answerExitRound = vi.fn(
    async (_payload: { roundId: number; decision: string }) => undefined,
  );
  stubBridge({
    answerExitRound,
    onExitRound: (next: (message: ExitRoundMessage) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    ...overrides,
  });
  const send = (message: ExitRoundMessage) => {
    act(() => {
      listener?.(message);
    });
  };
  return {
    answerExitRound,
    answers: () => answerExitRound.mock.calls.map(([payload]) => payload),
    ready: () => waitFor(() => expect(listener).not.toBeNull()),
    request: (roundId: number, exit: "quit" | "update") => send({ kind: "request", roundId, exit }),
    proceed: (roundId: number) => send({ kind: "proceed", roundId }),
    cancelled: (roundId: number) => send({ kind: "cancelled", roundId }),
  };
}

// Every test gets the full contract; overrides replace it where asserted on.
//
// Storage refuses every write here. A persisted draft comes back on
// the next launch and the guard rightly ignores it, so a suite about the
// guard must produce the drafts persistence cannot save — which is exactly
// what a full quota produces. The block below covers the drafts that can be
// persisted, and the secret-path floor is pinned in orphanedDrafts.test.ts.
beforeEach(() => {
  stubBridge();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });
});

afterEach(async () => {
  cleanup();
  resetGuardedExits();
  await disposeEngineDocLeasesForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetOrphanedDrafts();
  // The collection write queue is module state on purpose — a pending head
  // left by one test must not hold the next test's unload.
  resetCollectionFieldWritesForTests();
});

// A set-aside draft that storage cannot keep lives in renderer memory only,
// so closing or reloading the window is the one irreversible exit. The guard
// announces it first and carries the recovery list, so the warning offers
// the very actions it demands.
describe("RecoveryCloseGuard", () => {
  it("contains focus and returns it after the user goes back", async () => {
    const user = userEvent.setup();
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <button type="button">Open document</button>
      </RecoveryCloseGuard>,
    );
    const opener = screen.getByRole("button", { name: "Open document" });
    opener.focus();

    act(() => {
      window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    });
    const dialog = await screen.findByTestId("recovery-close-warning");
    const buttons = within(dialog).getAllByRole("button");
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    expect(document.activeElement).toBe(dialog);
    expect(screen.getByRole("dialog", { name: /without your set-aside edit\?$/ })).toBe(dialog);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(last);

    screen.getByTestId("recovery-close-goback").focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByTestId("recovery-close-anyway"));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByTestId("recovery-close-goback"));

    dialog.focus();
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(first);

    last.focus();
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(first);

    await user.click(screen.getByTestId("recovery-close-goback"));
    expect(document.activeElement).toBe(opener);
  });

  it("warns before closing while set-aside edits exist, offers the list, and closes on 'Close anyway'", async () => {
    const user = userEvent.setup();
    noteWorkspaceLabel("ws-1", "Personal notes");
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    // The guard is deliberately GLOBAL: the whole renderer
    // dies at once, so every workspace's drafts are at stake here.
    captureOrphanedDraft("ws-2", "other.md", "Also kept!");
    render(
      <RecoveryCloseGuard>
        <div data-testid="app-content" />
      </RecoveryCloseGuard>,
    );
    screen.getByTestId("app-content");

    const first = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(first);
    });
    expect(
      first.defaultPrevented,
      "close guard: remove the beforeunload interception. The close proceeds unannounced and every set-aside edit dies with it.",
    ).toBe(true);
    await screen.findByTestId("recovery-close-warning");

    const rows = screen.getAllByTestId("recovery-list-row");
    expect(
      rows,
      "dialog list: drop <RecoveryList /> from the dialog — the warning then demands actions it does not offer.",
    ).toHaveLength(2);
    const row = rows.find((candidate) => candidate.textContent?.includes("a.md"))!;
    expect(rows.some((candidate) => candidate.textContent?.includes("other.md"))).toBe(true);
    // The global list names each row's workspace, because two workspaces can
    // hold the same path and Copy/Dismiss must be tellable apart. It uses the
    // name the UI shows, not the raw UUID; an unregistered workspace falls
    // back to its id.
    const labels = screen
      .getAllByTestId("recovery-list-workspace")
      .map((label) => label.textContent);
    expect(
      labels,
      "workspace labels: drop the label span or show the raw id. Identical paths from two workspaces are indistinguishable.",
    ).toContain("Personal notes");
    expect(labels).toContain("ws-2");
    await user.click(within(row).getByTestId("recovery-list-copy"));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("Kept!"));

    await user.click(screen.getByTestId("recovery-close-goback"));
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();

    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);
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

    // Dismiss deletes the only copy, so the destructive path requires the
    // confirm step: the first click arms it and deletes
    // nothing, and Keep backs out whole.
    await user.click(screen.getByTestId("recovery-dismiss"));
    expect(
      screen.getByTestId("recovery-list-row"),
      "confirm gate: make the Dismiss button delete directly. The row is gone right here and the assertions below fail.",
    ).toBeTruthy();
    await user.click(screen.getByTestId("recovery-dismiss-cancel"));
    expect(screen.getByTestId("recovery-list-row")).toBeTruthy();
    expect(screen.queryByTestId("recovery-dismiss-confirm")).toBeNull();

    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() => expect(screen.queryByTestId("recovery-close-warning")).toBeNull());

    const second = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(false);
  });

  it("a blocked reload resumes as a reload, never an exit", async () => {
    const user = userEvent.setup();
    const reloadRenderer = vi.fn(async () => undefined);
    stubBridge({ reloadRenderer });
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    const Thrower = (): never => {
      throw new Error("boom");
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
    expect(screen.getByTestId("recovery-close-anyway").textContent).toBe("Reload anyway");

    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);
    await user.click(screen.getByTestId("recovery-close-anyway"));
    expect(
      reloadRenderer,
      "retain the action: make the confirm call window.close() unconditionally. The user asked to reload and gets an exit.",
    ).toHaveBeenCalledTimes(2);
    expect(closeSpy).not.toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  const READY_STATE = {
    status: "ready" as const,
    message: "Update 1.2.4 is ready.",
    currentVersion: "1.2.3",
    channel: "latest",
    canCheck: false,
    canInstall: true,
    version: "1.2.4",
  };

  it("reports an updater refusal to the initiating request across its own round", async () => {
    const answer = deferred<{ accepted: boolean; state: typeof READY_STATE }>();
    const main = roundBridge({ installUpdate: vi.fn(() => answer.promise) });
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await main.ready();

    const installing = requestGuardedUpdateInstall();
    main.request(1, "update");
    await waitFor(() => expect(main.answers()).toContainEqual({ roundId: 1, decision: "clear" }));
    main.proceed(1);
    await act(async () => answer.resolve({ accepted: false, state: READY_STATE }));
    expect(
      await installing,
      "own round: a request that increments exitRequest must not make the initiator's result stale",
    ).toEqual({ accepted: false, state: READY_STATE });
  });

  // With two windows, a late draft in window B can stop the approved
  // restart window A asked for. Going back in B takes the restart back from
  // every window of the round, so A's button offers Restart to update again
  // instead of showing "Restarting…" for a restart that is off.
  it("goes back on an approved restart for every window when a late draft stopped this window's unload", async () => {
    const user = userEvent.setup();
    const main = roundBridge();
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await main.ready();
    main.request(1, "update");
    main.proceed(1);

    captureOrphanedDraft("ws-1", "late.md", "Typed after the restart was approved");
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    const stopped = vi.fn();
    const unsubscribe = onRestartStopped(stopped);
    await user.click(await screen.findByTestId("recovery-close-goback"));
    expect(
      main.answers(),
      "Go back after the round proceeded must tell main, or the window that asked keeps showing Restarting…",
    ).toContainEqual({ roundId: 1, decision: "cancel" });
    main.cancelled(1);
    unsubscribe();
    expect(stopped).toHaveBeenCalledOnce();
  });

  it("answers a held round clear when its warning empties by dismissal", async () => {
    const user = userEvent.setup();
    const main = roundBridge();
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await main.ready();
    main.request(4, "update");
    await waitFor(() => expect(main.answers()).toContainEqual({ roundId: 4, decision: "hold" }));
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() => expect(screen.queryByTestId("recovery-close-warning")).toBeNull());
    await waitFor(() =>
      expect(main.answers(), "no silent held round may remain").toContainEqual({
        roundId: 4,
        decision: "clear",
      }),
    );
  });

  it("re-arms the draft approval locally on Go back", async () => {
    const user = userEvent.setup();
    const installUpdate = vi.fn(async () => ({ accepted: false, state: READY_STATE }));
    const main = roundBridge({ installUpdate });
    captureOrphanedDraft("ws-1", "d1.md", "First");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await main.ready();

    expect(await requestGuardedUpdateInstall()).toBeNull();
    await user.click(await screen.findByTestId("recovery-close-anyway"));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
    captureOrphanedDraft("ws-1", "d2.md", "Second");
    main.request(1, "update");
    await screen.findByTestId("recovery-close-warning");
    await user.click(screen.getByTestId("recovery-close-goback"));
    await waitFor(() => expect(main.answers()).toContainEqual({ roundId: 1, decision: "cancel" }));
    const rows = screen.queryAllByTestId("recovery-list-row");
    expect(rows).toHaveLength(0);
    const [d1] = atRiskOrphanedDraftIds();
    const d2 = atRiskOrphanedDraftIds().find((id) => id !== d1)!;
    dismissOrphanedDraft("ws-1", "d2.md", d2);
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(
      event.defaultPrevented,
      "stale approval: Go back must re-arm, or D1 is bypassed for an unrelated close",
    ).toBe(true);
  });

  it("re-arms the guard when the resumed action fails to unload", async () => {
    const user = userEvent.setup();
    const installUpdate = vi.fn(async () => ({
      accepted: false,
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

    const second = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(second);
    });
    expect(
      second.defaultPrevented,
      "scoped bypass: leave the bypass set after a failed resume. This close then passes unguarded and the drafts die silently.",
    ).toBe(true);
    expect(await screen.findByTestId("recovery-close-warning")).toBeTruthy();
  });

  // A window that did not ask for the restart still has drafts to lose. It
  // gets the same warning, and its confirm clears its part of the round:
  // main proceeds only when every window is clear, so nothing is resumed
  // from here.
  it("warns a noninitiating window about a restart, and its confirm clears the round", async () => {
    const user = userEvent.setup();
    const resumeQuit = vi.fn(async () => undefined);
    const installUpdate = vi.fn(async () => ({ accepted: true }));
    const main = roundBridge({ resumeQuit, installUpdate });
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await main.ready();

    main.request(5, "update");
    await waitFor(() => expect(main.answers()).toContainEqual({ roundId: 5, decision: "hold" }));
    expect(screen.getByTestId("recovery-close-anyway").textContent).toBe("Restart anyway");

    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(main.answers()).toContainEqual({ roundId: 5, decision: "clear" }));
    expect(resumeQuit).not.toHaveBeenCalled();
    expect(installUpdate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();

    main.proceed(5);
    captureOrphanedDraft("ws-1", "late.md", "Typed in the gap");
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId("recovery-close-anyway").textContent).toBe("Restart anyway");
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(resumeQuit).toHaveBeenCalledTimes(1));
    expect(closeSpy).not.toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it("closes a dialog for a round another window cancelled, and ignores a stale round", async () => {
    const main = roundBridge();
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await main.ready();

    main.request(7, "quit");
    await screen.findByTestId("recovery-close-warning");
    expect(screen.getByTestId("recovery-close-anyway").textContent).toBe("Quit anyway");
    main.cancelled(3);
    expect(screen.getByTestId("recovery-close-warning")).toBeTruthy();
    main.cancelled(7);
    await waitFor(() => expect(screen.queryByTestId("recovery-close-warning")).toBeNull());
    expect(main.answers()).not.toContainEqual({ roundId: 3, decision: "cancel" });
  });

  // An approval is only valid for the store state it
  // was given. "Restart anyway" approves losing the drafts the dialog listed,
  // and quitAndInstall is one-shot — so the boundary re-check reads the live
  // store instead of trusting the confirm, and a draft that appears after it
  // brings the decision back to the user with its text intact.
  function confirmedRestartHarness(options: { accepted?: boolean; onInstall?: () => void } = {}) {
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
      return { accepted, state: readyState };
    });
    const resumeQuit = vi.fn(async () => undefined);
    const main = roundBridge({ installUpdate, resumeQuit });
    return {
      installUpdate,
      answers: main.answers,
      resumeQuit,
      askBoundaryCheck: (roundId: number) => main.request(roundId, "update"),
      ready: main.ready,
    };
  }

  it("blocks the exit for a draft the approval never covered", async () => {
    const user = userEvent.setup();
    const harness = confirmedRestartHarness();
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    const [approvedId] = atRiskOrphanedDraftIds();
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
    // must answer from what is there, not from "the user already confirmed".
    // The approved draft is dismissed in the same window, so the COUNT is
    // unchanged: only the drafts' identity says the list is no longer the one
    // that was approved.
    dismissOrphanedDraft("ws-1", "a.md", approvedId);
    captureOrphanedDraft("ws-1", "b.md", "Never shown");
    expect(atRiskOrphanedDraftIds()).toHaveLength(1);

    harness.askBoundaryCheck(1);
    await waitFor(() =>
      expect(
        harness.answers(),
        "stale bypass: answer `!bypassCloseGuard.current && atRiskOrphanedDraftIds().length > 0`. The re-check reports clear and destroys the only copy of a draft that was in no warning.",
      ).toContainEqual({
        roundId: 1,
        decision: "hold",
      }),
    );
    const rows = await screen.findAllByTestId("recovery-list-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("b.md");

    // ...and it is still the restart the user asked for.
    // A warning that cannot tell close from restart passes either way, so
    // assert the action, not just its presence.
    expect(
      screen.getByTestId("recovery-close-anyway").textContent,
      "update intent: stop claiming pendingUnload in beginInstall. The warning degrades to 'Close', and confirming calls window.close() instead of resuming the quit quitAndInstall already started — whose one-shot latch is spent, so no later confirm can ever restart.",
    ).toBe("Restart anyway");
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() =>
      expect(harness.answers()).toContainEqual({ roundId: 1, decision: "clear" }),
    );
    expect(closeSpy).not.toHaveBeenCalled();
    expect(harness.resumeQuit).not.toHaveBeenCalled();
    expect(harness.installUpdate).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });

  // Answering the quit ask "clear" does not end the story. A
  // queued reopen can still capture a draft before the quit's own unload, and
  // the warning that blocks it must resume the quit — window.close() leaves
  // the process running on macOS and with agent dispatch alive.
  it("keeps a native quit's intent through a draft captured after the clear answer", async () => {
    const user = userEvent.setup();
    const resumeQuit = vi.fn(async () => undefined);
    const holdQuit = vi.fn(async () => undefined);
    const main = roundBridge({ holdQuit, resumeQuit });
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    await main.ready();

    main.request(1, "quit");
    await waitFor(() => expect(main.answers()).toContainEqual({ roundId: 1, decision: "clear" }));
    expect(holdQuit).not.toHaveBeenCalled();
    main.proceed(1);

    captureOrphanedDraft("ws-1", "a.md", "Typed in the gap");
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);

    expect(
      screen.getByTestId("recovery-close-anyway").textContent,
      "quit intent: stop claiming pendingUnload before answering clear. The warning degrades to 'Close', and confirming calls window.close() — which does not quit on macOS.",
    ).toBe("Quit anyway");
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(resumeQuit).toHaveBeenCalledTimes(1));
    expect(closeSpy).not.toHaveBeenCalled();
    closeSpy.mockRestore();
  });
});

describe("RecoveryCloseGuard with working storage", () => {
  beforeEach(() => {
    // Undo the suite-wide refusal above; these tests need storage to work.
    vi.restoreAllMocks();
  });

  it("warns about the drafts storage could not take, and lists only those", async () => {
    captureOrphanedDraft("ws-1", "a.md", "Persisted");
    // A secret-classified path never enters plaintext storage, so this
    // one still dies with the app run.
    captureOrphanedDraft("ws-1", ".env", "API_KEY=shh");
    render(
      <RecoveryCloseGuard>
        <div />
      </RecoveryCloseGuard>,
    );
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await screen.findByTestId("recovery-close-warning");
    const rows = screen.getAllByTestId("recovery-list-row");
    expect(
      rows,
      "dialog list: hand <RecoveryList/> every row instead of `liveDrafts`. The warning then lists a draft it is not warning about.",
    ).toHaveLength(1);
    expect(rows[0].textContent).toContain(".env");
  });
});

describe("main.tsx composition", () => {
  // Stops main.tsx's reduced-motion poll even when the test fails before it does.
  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
  });

  it("restores stored recoveries and keeps the close guard alive above a crashed root", async () => {
    let mountedRoot: Root | null = null;
    vi.doMock("react-dom/client", async (importOriginal) => {
      const actual = await importOriginal<typeof import("react-dom/client")>();
      return {
        ...actual,
        createRoot: (...args: Parameters<typeof actual.createRoot>) => {
          mountedRoot = actual.createRoot(...args);
          return mountedRoot;
        },
      };
    });
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
    // A stored recovery from the last run, seeded through real storage; the
    // capture after it goes back to the suite's full quota, so it stays
    // at-risk and the guard still has something to announce.
    vi.restoreAllMocks();
    seedStoredDraft();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    // main.tsx renders outside act, so the crash screen's DOM can land one
    // commit before the guard's passive effect adds this listener — wait for
    // the registration itself rather than a fixed number of flushes.
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await import("./main");
      await screen.findByTestId("app-crash-screen");
    } finally {
      consoleError.mockRestore();
    }
    await waitFor(() =>
      expect(addEventListenerSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function)),
    );

    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await screen.findByTestId("recovery-close-warning");
    // The dialog names the at-risk draft, and only it: importing main.tsx
    // restored the stored one, which no exit can destroy.
    const listed = screen.getAllByTestId("recovery-list-row");
    expect(listed).toHaveLength(1);
    expect(listed[0].textContent).toContain("a.md");
    expect(screen.getByTestId("recovery-close-warning").textContent).not.toContain("notes/a.md");
    const restored = renderHook(() => useAllOrphanedDrafts());
    expect(restored.result.current.map((row) => `${row.path}:${row.persisted}`)).toContain(
      "notes/a.md:true",
    );
    restored.unmount();
    // On Linux main.tsx polls the native reduced-motion setting every second
    // until pagehide stops it. Left running, its timer can fire after this
    // file's jsdom is gone and fail the whole run.
    await waitFor(() => expect(document.documentElement.dataset.systemReducedMotion).toBe("false"));
    window.dispatchEvent(new Event("pagehide"));
    expect(document.documentElement.dataset.systemReducedMotion).toBeUndefined();
    act(() => mountedRoot?.unmount());
    container.remove();
    vi.doUnmock("./DesktopRoot");
    vi.doUnmock("react-dom/client");
  });
});

describe("RecoveryCloseGuard with pending collection writes", () => {
  const CHANGE_ONE = {
    recordId: "rec-1",
    recordPath: "tasks/one.md",
    field: "done",
    value: true,
  };
  const CHANGE_TWO = {
    recordId: "rec-2",
    recordPath: "tasks/two.md",
    field: "done",
    value: false,
  };

  // The real queue and the real writer, over a controllable engine: opens
  // succeed (or are deferred), and a save settles only when a test emits its
  // "saved" event — exactly how a pending write looks at an unload boundary.
  function stubWriteBridge(overrides: Record<string, unknown> = {}) {
    const sessionsByPath = new Map<string, string>();
    const applied = vi.fn(async (_payload: { sessionId: string; seq: number }) => ({
      accepted: true as const,
    }));
    const saveStateListeners = new Set<(event: EngineYDocSaveStateEvent) => void>();
    stubBridge({
      // A field write checks its record's file before the session opens.
      readWorkspaceText: vi.fn(async (payload: { relativePath: string }) => ({
        text: `---\nid: ${payload.relativePath === "tasks/one.md" ? "rec-1" : "rec-2"}\n---\n`,
        truncated: false,
        contentHash: payload.relativePath === "tasks/one.md" ? "1".repeat(64) : "2".repeat(64),
      })),
      openEngineYDocSession: vi.fn(async (payload: { path: string; sessionId: string }) => {
        sessionsByPath.set(payload.path, payload.sessionId);
        const doc = new Y.Doc();
        doc.getMap("frontmatter").set("id", payload.path === "tasks/one.md" ? "rec-1" : "rec-2");
        return {
          available: true,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          lineageGeneration: 1,
        };
      }),
      applyEngineYDocUpdate: applied,
      closeEngineYDocSession: vi.fn(async () => undefined),
      onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
      onEngineYDocOwnerHandoff: () => () => undefined,
      prepareEngineYDocOwnerHandoff: async () => undefined,
      onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
      onEngineYDocSaveState: vi.fn((listener: (event: EngineYDocSaveStateEvent) => void) => {
        saveStateListeners.add(listener);
        return () => saveStateListeners.delete(listener);
      }),
      ...overrides,
    });
    const settleSave = (path: string) => {
      act(() => {
        const sessionId = sessionsByPath.get(path);
        expect(sessionId).toBeTruthy();
        const seq = Math.max(
          ...applied.mock.calls
            .filter(([payload]) => payload.sessionId === sessionId)
            .map(([payload]) => payload.seq),
        );
        expect(seq).toBeGreaterThan(0);
        for (const listener of [...saveStateListeners]) {
          listener({
            sessionId: sessionId!,
            workspaceId: "ws-1",
            path: "notes/a.md",
            state: { kind: "saved-here" },
            seq,
          });
        }
      });
    };
    const awaitStaged = (path: string) =>
      waitFor(() => {
        const sessionId = sessionsByPath.get(path);
        expect(sessionId).toBeTruthy();
        expect(applied.mock.calls.some(([payload]) => payload.sessionId === sessionId)).toBe(true);
      });
    return { settleSave, awaitStaged };
  }

  function renderGuardWithHost() {
    return render(
      <RecoveryCloseGuard>
        <CollectionFieldWriteHost />
      </RecoveryCloseGuard>,
    );
  }

  function dispatchUnload(): Event {
    const event = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  }

  it("a close waits for the whole queued tail, then closes on its own", async () => {
    const { settleSave, awaitStaged } = stubWriteBridge();
    renderGuardWithHost();
    act(() => {
      enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE_ONE);
      enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE_TWO);
    });
    await awaitStaged("tasks/one.md");

    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);
    // MUTATION (write hold): drop the pending-writes branch from
    // onBeforeUnload. The close proceeds here and the queued tail dies with
    // the renderer.
    expect(dispatchUnload().defaultPrevented).toBe(true);
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();

    settleSave("tasks/one.md");
    await awaitStaged("tasks/two.md");
    expect(closeSpy).not.toHaveBeenCalled();
    settleSave("tasks/two.md");
    await waitFor(() => expect(closeSpy).toHaveBeenCalled());
    closeSpy.mockRestore();
  });

  // A round-aware write bridge: the round messages arrive through the
  // listener, and the write engine is the controllable one above.
  function stubRoundWriteBridge(overrides: Record<string, unknown> = {}) {
    let listener: ((message: ExitRoundMessage) => void) | null = null;
    const answerExitRound = vi.fn(
      async (_payload: { roundId: number; decision: string }) => undefined,
    );
    const engine = stubWriteBridge({
      answerExitRound,
      onExitRound: (next: (message: ExitRoundMessage) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      ...overrides,
    });
    const send = (message: ExitRoundMessage) => {
      act(() => {
        listener?.(message);
      });
    };
    return {
      ...engine,
      answers: () => answerExitRound.mock.calls.map(([payload]) => payload),
      request: (roundId: number, exit: "quit" | "update") =>
        send({ kind: "request", roundId, exit }),
      proceed: (roundId: number) => send({ kind: "proceed", roundId }),
      cancelled: (roundId: number) => send({ kind: "cancelled", roundId }),
    };
  }

  it("a native quit blocked by a pending write holds, then clears once the write lands", async () => {
    const resumeQuit = vi.fn(async () => undefined);
    const holdQuit = vi.fn(async () => undefined);
    const main = stubRoundWriteBridge({ resumeQuit, holdQuit });
    renderGuardWithHost();
    act(() => {
      enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE_ONE);
    });
    await main.awaitStaged("tasks/one.md");

    main.request(1, "quit");
    expect(main.answers()).toContainEqual({ roundId: 1, decision: "hold" });
    expect(holdQuit).toHaveBeenCalled();

    main.settleSave("tasks/one.md");
    await waitFor(() => expect(main.answers()).toContainEqual({ roundId: 1, decision: "clear" }));
    expect(resumeQuit).not.toHaveBeenCalled();
    main.proceed(1);
    expect(dispatchUnload().defaultPrevented).toBe(false);
  });

  // Window A cleared the update round; window B still holds its warning, so
  // nothing is staged yet. A then accepts a collection write and closes.
  // Its unload captures the round's intent and drains the write. Resuming
  // that intent must answer the still-open round again, never resume a quit
  // that B has not approved and that would skip the install altogether.
  it("re-answers a held update round from a late beforeunload drain instead of quitting past it", async () => {
    const user = userEvent.setup();
    const resumeQuit = vi.fn(async () => undefined);
    const installUpdate = vi.fn(async () => ({ accepted: true }));
    const main = stubRoundWriteBridge({ resumeQuit, installUpdate });
    renderGuardWithHost();

    const installing = requestGuardedUpdateInstall();
    expect(installUpdate).toHaveBeenCalledTimes(1);
    main.request(1, "update");
    await waitFor(() => expect(main.answers()).toContainEqual({ roundId: 1, decision: "clear" }));

    act(() => {
      enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE_ONE);
    });
    await main.awaitStaged("tasks/one.md");
    expect(dispatchUnload().defaultPrevented).toBe(true);
    main.settleSave("tasks/one.md");
    await waitFor(() =>
      expect(
        main.answers().filter((answer) => answer.roundId === 1 && answer.decision === "clear"),
      ).toHaveLength(2),
    );
    expect(
      resumeQuit,
      "a held round must not be bypassed by a window closing",
    ).not.toHaveBeenCalled();
    expect(installUpdate).toHaveBeenCalledTimes(1);

    main.proceed(1);
    expect(await installing).toEqual({ accepted: true });
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(resumeQuit).not.toHaveBeenCalled();

    captureOrphanedDraft("ws-1", "late.md", "Typed in the gap");
    expect(dispatchUnload().defaultPrevented).toBe(true);
    expect(screen.getByTestId("recovery-close-anyway").textContent).toBe("Restart anyway");
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);
    await user.click(screen.getByTestId("recovery-close-anyway"));
    await waitFor(() => expect(resumeQuit).toHaveBeenCalledTimes(1));
    expect(closeSpy).not.toHaveBeenCalled();
    expect(installUpdate).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });

  it("a collection drain after cancellation cannot clear a newer round", async () => {
    const main = stubRoundWriteBridge();
    renderGuardWithHost();
    act(() => {
      enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE_ONE);
    });
    await main.awaitStaged("tasks/one.md");

    main.request(1, "update");
    expect(main.answers()).toContainEqual({ roundId: 1, decision: "hold" });
    main.cancelled(1);
    main.request(2, "update");
    expect(main.answers()).toContainEqual({ roundId: 2, decision: "hold" });

    main.settleSave("tasks/one.md");
    await waitFor(() => expect(main.answers()).toContainEqual({ roundId: 2, decision: "clear" }));
    expect(main.answers()).not.toContainEqual({ roundId: 1, decision: "clear" });
  });

  it("keeps a local approval until a failed drain cancels the round, then re-arms", async () => {
    const user = userEvent.setup();
    let resolveOpen: ((result: { available: false }) => void) | null = null;
    const open = new Promise<{ available: false }>((resolve) => {
      resolveOpen = resolve;
    });
    const installUpdate = vi.fn(async () => ({
      accepted: false,
      state: { status: "ready" as const },
    }));
    const main = stubRoundWriteBridge({ openEngineYDocSession: vi.fn(() => open), installUpdate });
    captureOrphanedDraft("ws-1", "d1.md", "First");
    renderGuardWithHost();

    expect(await requestGuardedUpdateInstall()).toBeNull();
    await user.click(await screen.findByTestId("recovery-close-anyway"));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
    act(() => {
      enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE_ONE);
    });
    main.request(6, "update");
    expect(main.answers()).toContainEqual({ roundId: 6, decision: "hold" });
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();

    await act(async () => {
      resolveOpen!({ available: false });
      await open;
    });
    await screen.findByTestId("collection-write-failure");
    await waitFor(() => expect(main.answers()).toContainEqual({ roundId: 6, decision: "cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard unsaved change" }));
    const event = dispatchUnload();
    expect(
      event.defaultPrevented,
      "stale approval: a failed-drain cancellation must re-arm, or D1 is bypassed until the fail-safe timer",
    ).toBe(true);
    expect((await screen.findByTestId("recovery-close-anyway")).textContent).toBe("Close anyway");
  });

  it("cancels an update round when its collection drain stalls", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const main = stubRoundWriteBridge();
      renderGuardWithHost();
      act(() => {
        enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE_ONE);
      });
      await main.awaitStaged("tasks/one.md");
      main.request(5, "update");
      expect(main.answers()).toContainEqual({ roundId: 5, decision: "hold" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(COLLECTION_WRITE_STALL_MS + 1);
      });
      await waitFor(() =>
        expect(main.answers()).toContainEqual({ roundId: 5, decision: "cancel" }),
      );
      expect(main.answers()).not.toContainEqual({ roundId: 5, decision: "clear" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains an edit accepted during main's install check and retries the same restart", async () => {
    let refuse!: (result: { accepted: false }) => void;
    const refused = new Promise<{ accepted: false }>((resolve) => {
      refuse = resolve;
    });
    const installUpdate = vi
      .fn()
      .mockReturnValueOnce(refused)
      .mockResolvedValue({ accepted: true });
    const { settleSave, awaitStaged } = stubWriteBridge({ installUpdate });
    renderGuardWithHost();
    const installing = requestGuardedUpdateInstall();
    expect(installUpdate).toHaveBeenCalledTimes(1);
    act(() => {
      enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE_ONE);
    });
    await awaitStaged("tasks/one.md");
    await act(async () => {
      refuse({ accepted: false });
      await refused;
    });
    expect(installUpdate).toHaveBeenCalledTimes(1);
    settleSave("tasks/one.md");
    expect(await installing).toEqual({ accepted: true });
    expect(installUpdate).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("recovery-close-warning")).toBeNull();
  });

  it.each([false, true])(
    "a newer reload supersedes an install retry drain (confirmed: %s)",
    async (confirmed) => {
      let refuse!: (result: { accepted: false }) => void;
      const refused = new Promise<{ accepted: false }>((resolve) => {
        refuse = resolve;
      });
      const installUpdate = vi
        .fn()
        .mockReturnValueOnce(refused)
        .mockResolvedValue({ accepted: true });
      const reloadRenderer = vi.fn(async () => {
        dispatchUnload();
      });
      const { settleSave, awaitStaged } = stubWriteBridge({ installUpdate, reloadRenderer });
      if (confirmed) captureOrphanedDraft("ws-1", "old.md", "Before restart");
      renderGuardWithHost();
      let installing: Promise<unknown>;
      if (confirmed) {
        expect(await requestGuardedUpdateInstall()).toBeNull();
        await userEvent.click(await screen.findByTestId("recovery-close-anyway"));
        installing = Promise.resolve();
      } else {
        installing = requestGuardedUpdateInstall();
      }
      expect(installUpdate).toHaveBeenCalledTimes(1);
      act(() => {
        enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE_ONE);
      });
      await awaitStaged("tasks/one.md");
      await act(async () => {
        refuse({ accepted: false });
        await refused;
      });
      act(() => {
        captureOrphanedDraft("ws-1", "new.md", "During restart");
        requestGuardedReload();
      });
      settleSave("tasks/one.md");
      await installing;
      await waitFor(() =>
        expect(screen.getByTestId("recovery-close-anyway").textContent).toBe("Reload anyway"),
      );
      expect(installUpdate).toHaveBeenCalledTimes(1);
    },
  );

  it("a write that fails while the unload waits keeps the app open", async () => {
    let resolveOpen: ((result: { available: false }) => void) | null = null;
    const open = new Promise<{ available: false }>((resolve) => {
      resolveOpen = resolve;
    });
    stubWriteBridge({
      openEngineYDocSession: vi.fn(() => open),
    });
    renderGuardWithHost();
    act(() => {
      enqueueCollectionFieldWrite("ws-1", "tasks", CHANGE_ONE);
    });

    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);
    expect(dispatchUnload().defaultPrevented).toBe(true);

    // The record's open settles without a session: the write FAILS while the
    // close waits. Exiting now would destroy the only surface that can show
    // the failure, so the close stays stopped.
    // MUTATION (failure gate): resume regardless of `failed`. The renderer
    // exits over an error the user never saw.
    await act(async () => {
      resolveOpen!({ available: false });
      await open;
    });
    await screen.findByTestId("collection-write-failure");
    expect(collectionWriteFailures()[0]?.change).toEqual(CHANGE_ONE);
    expect(dispatchUnload().defaultPrevented).toBe(true);
    expect(dispatchUnload().defaultPrevented).toBe(true);
    expect(closeSpy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Discard unsaved change" }));
    expect(dispatchUnload().defaultPrevented).toBe(false);
    closeSpy.mockRestore();
  });
});

it("holds last-window unload until pending Y.Doc deliveries and their main checkpoint land", async () => {
  const gate = deferred<void>();
  let pending = true;
  const unregister = registerYDocDelivery({
    pending: () => pending,
    flush: async () => {
      await gate.promise;
      pending = false;
    },
  });
  const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
  try {
    render(
      <RecoveryCloseGuard>
        <span>Workspace</span>
      </RecoveryCloseGuard>,
    );
    const unload = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(unload);
    });
    expect(unload.defaultPrevented).toBe(true);
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  } finally {
    unregister();
  }
});
