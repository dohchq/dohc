import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQuitGuard,
  createRecoveryChecker,
  createWorkspaceWindowRegistry,
} from "./quitGuard";

function makeGuard(overrides: {
  confirmForceQuit?: () => Promise<boolean>;
} = {}) {
  const askRenderer = vi.fn();
  const quit = vi.fn();
  const forceQuit = vi.fn();
  const confirmForceQuit = vi.fn(
    overrides.confirmForceQuit ?? (async () => false),
  );
  const guard = createQuitGuard({
    askRenderer,
    confirmForceQuit,
    quit,
    forceQuit,
    timeoutMs: 1_000,
  });
  return { guard, askRenderer, quit, forceQuit, confirmForceQuit };
}

function quitEvent() {
  const event = { prevented: false, preventDefault: () => undefined };
  event.preventDefault = () => {
    event.prevented = true;
  };
  return event;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// #567: a quit is the one irreversible exit for set-aside drafts, so main
// asks the renderer BEFORE it proceeds. The interesting cases are what
// happens when the renderer answers late or not at all.
describe("quit guard", () => {
  it("intercepts the first quit and asks the renderer", () => {
    const { guard, askRenderer, quit } = makeGuard();
    const event = quitEvent();
    expect(guard.beforeQuit(event)).toBe("asked");
    expect(event.prevented).toBe(true);
    expect(askRenderer).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
  });

  it("resumes into a real quit when the renderer says nothing is at stake", () => {
    const { guard, quit } = makeGuard();
    guard.beforeQuit(quitEvent());
    guard.resume();
    expect(quit).toHaveBeenCalledTimes(1);
    // The approved quit is not intercepted again.
    const second = quitEvent();
    expect(guard.beforeQuit(second)).toBe("proceed");
    expect(second.prevented).toBe(false);
  });

  it("holds indefinitely while the renderer's dialog owns the decision", async () => {
    vi.useFakeTimers();
    const { guard, quit, confirmForceQuit } = makeGuard();
    guard.beforeQuit(quitEvent());
    guard.hold();
    await vi.advanceTimersByTimeAsync(60_000);
    // No timer fires after a hold: the user is deciding.
    expect(confirmForceQuit).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  // #579 review r11: a renderer that has not answered may be BUSY, not dead.
  // The ACK window must never force-quit by itself — it asks the user, with
  // the loss named, and "Wait" leaves the drafts alone.
  it("asks the user instead of force-quitting a silent renderer, and waiting keeps the app up", async () => {
    vi.useFakeTimers();
    const { guard, quit, confirmForceQuit } = makeGuard({
      confirmForceQuit: async () => false,
    });
    guard.beforeQuit(quitEvent());

    // MUTATION (busy-renderer force quit): make the timeout approve and
    // call quit() directly (the r10 shape). A busy renderer's drafts die
    // with no dialog and no decision.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(confirmForceQuit).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();

    // The quit stays vetoed afterwards, so a slow renderer can still answer.
    const later = quitEvent();
    expect(guard.beforeQuit(later)).toBe("asked");
    expect(later.prevented).toBe(true);
  });

  // #579 review r15: an ordinary app.quit() does not deliver this answer. A
  // renderer that wakes before its window closes runs beforeunload knowing
  // nothing of the MAIN-side dialog — no bypass, no approved ids — so it
  // vetoes the exit and opens a second warning while the guard stays
  // approved. The explicit decision has to take the force path.
  it("force-quits only on an explicit decision, and through the force path", async () => {
    vi.useFakeTimers();
    const { guard, quit, forceQuit } = makeGuard({
      confirmForceQuit: async () => true,
    });
    guard.beforeQuit(quitEvent());
    await vi.advanceTimersByTimeAsync(1_000);
    // MUTATION (carry the decision): call options.quit() here instead. The
    // waking renderer vetoes the unload the user already chose.
    expect(forceQuit).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    const next = quitEvent();
    expect(guard.beforeQuit(next)).toBe("proceed");
  });

  it("drops a stale force-quit answer when the renderer already resumed", async () => {
    vi.useFakeTimers();
    let decide!: (quitAnyway: boolean) => void;
    const { guard, quit, forceQuit } = makeGuard({
      confirmForceQuit: () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        }),
    });
    guard.beforeQuit(quitEvent());
    await vi.advanceTimersByTimeAsync(1_000);
    // The renderer answers while the main-side dialog is still up.
    guard.resume();
    expect(quit).toHaveBeenCalledTimes(1);
    decide(true);
    await vi.advanceTimersByTimeAsync(0);
    // No second quit from the stale dialog answer, by either path.
    expect(quit).toHaveBeenCalledTimes(1);
    expect(forceQuit).not.toHaveBeenCalled();
  });

  // #579 review r19: an update install pre-approves the quit BEFORE the
  // renderer can veto its unload. If the user then goes back, the approval
  // must not outlive the quit it was granted for — otherwise the next Cmd+Q
  // proceeds without asking, reaches beforeunload with no pending intent, and
  // the warning is labelled a close.
  it("drops a pre-approval when the quit it was granted for is held", () => {
    const { guard, askRenderer } = makeGuard();
    guard.approve();
    // MUTATION (hold revokes): leave `approved` set in hold(). The next quit
    // proceeds unasked and the renderer never gets to name the action.
    guard.hold();
    const next = quitEvent();
    expect(guard.beforeQuit(next)).toBe("asked");
    expect(next.prevented).toBe(true);
    expect(askRenderer).toHaveBeenCalledTimes(1);
  });

  it("pre-approves an update's own quit, and a refused install revokes it", () => {
    const { guard, askRenderer } = makeGuard();
    guard.approve();
    const duringInstall = quitEvent();
    expect(guard.beforeQuit(duringInstall)).toBe("proceed");
    expect(askRenderer).not.toHaveBeenCalled();

    guard.revoke();
    const afterRefusal = quitEvent();
    expect(guard.beforeQuit(afterRefusal)).toBe("asked");
    expect(afterRefusal.prevented).toBe(true);
  });
});

// #579 review r12: which renderer answers for the quit. Not every window runs
// the workspace — the PDF export creates a hidden, preload-less one — and
// asking IT would answer nothing while the user sees the unresponsive dialog
// over drafts that were fully available.
describe("workspace window registry", () => {
  type FakeWindow = { id: string; destroyed: boolean };

  it("lists every live workspace window for the force-quit path", () => {
    const registry = createWorkspaceWindowRegistry<FakeWindow>(
      (window) => window.destroyed,
    );
    const first: FakeWindow = { id: "first", destroyed: false };
    const gone: FakeWindow = { id: "gone", destroyed: true };
    const second: FakeWindow = { id: "second", destroyed: false };
    registry.track(first);
    registry.track(gone);
    registry.track(second);
    // MUTATION (allLive): return every tracked window. The force path then
    // calls destroy() on one that is already destroyed.
    expect(registry.allLive().map((window) => window.id)).toEqual([
      "first",
      "second",
    ]);
  });


  it("answers with a tracked workspace window, never another live window", () => {
    const registry = createWorkspaceWindowRegistry<FakeWindow>(
      (window) => window.destroyed,
    );
    const workspace: FakeWindow = { id: "workspace", destroyed: false };
    // The PDF export's hidden window is never tracked.
    const pdfExport: FakeWindow = { id: "pdf-export", destroyed: false };
    registry.track(workspace);

    // MUTATION (window targeting): pick the first live window from a list
    // that includes untracked ones. The quit check reaches a renderer that
    // cannot answer.
    expect(registry.live()).toBe(workspace);
    expect(registry.live()).not.toBe(pdfExport);
  });

  it("skips destroyed windows and forgets closed ones", () => {
    const registry = createWorkspaceWindowRegistry<FakeWindow>(
      (window) => window.destroyed,
    );
    const closed: FakeWindow = { id: "old", destroyed: true };
    const open: FakeWindow = { id: "new", destroyed: false };
    registry.track(closed);
    registry.track(open);
    expect(registry.live()).toBe(open);

    registry.forget(open);
    expect(registry.live()).toBeUndefined();
  });
});

// #579 review r12: the renderer checks its drafts before it asks for an
// install, and a reopen can set an edit aside in the gap before main's
// handler runs. Main asks AGAIN at the moment it would approve the quit.
describe("recovery boundary check", () => {
  it("blocks when the renderer reports set-aside drafts at answer time", async () => {
    let asked: number | null = null;
    const checker = createRecoveryChecker({
      send: (requestId) => {
        asked = requestId;
        return true;
      },
      confirmProceed: async () => false,
      timeoutMs: 1_000,
    });
    const pending = checker.ask();
    expect(asked).not.toBeNull();
    checker.answer(asked!, true);
    await expect(pending).resolves.toBe(true);
  });

  it("clears the quit when the renderer reports nothing set aside", async () => {
    let asked: number | null = null;
    const checker = createRecoveryChecker({
      send: (requestId) => {
        asked = requestId;
        return true;
      },
      confirmProceed: async () => false,
      timeoutMs: 1_000,
    });
    const pending = checker.ask();
    checker.answer(asked!, false);
    await expect(pending).resolves.toBe(false);
  });

  // #579 review r16: the ACK window does not answer for the renderer. A busy
  // renderer and a dead one look identical from main at ANY deadline, so
  // silence asks the user instead of refusing the install they asked for.
  it("asks the user when the renderer never answers, and waiting blocks", async () => {
    vi.useFakeTimers();
    const confirmProceed = vi.fn(async () => false);
    const checker = createRecoveryChecker({
      send: () => true,
      confirmProceed,
      timeoutMs: 1_000,
    });
    const pending = checker.ask();
    // MUTATION (silent rejection): settle the timeout as blocked without
    // asking. A merely busy renderer then refuses the install with nothing
    // shown to the user.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(confirmProceed).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBe(true);
  });

  it("installs over an unresponsive renderer only on an explicit decision", async () => {
    vi.useFakeTimers();
    const checker = createRecoveryChecker({
      send: () => true,
      confirmProceed: async () => true,
      timeoutMs: 1_000,
    });
    const pending = checker.ask();
    // MUTATION (ignore the decision): settle as blocked regardless. The user
    // chose "Install anyway" over a renderer that never answered, and the
    // install is refused anyway.
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(false);
  });

  // #579 review r18: once the dialog is on screen it OWNS the answer. A late
  // renderer reply settling behind it either strands the user's click on a
  // request that no longer exists, or lets the install begin while the dialog
  // is still asking whether to proceed.
  it("lets the escalation dialog own the request against a late renderer answer", async () => {
    vi.useFakeTimers();
    let decide!: (proceed: boolean) => void;
    let asked: number | null = null;
    const checker = createRecoveryChecker({
      send: (requestId) => {
        asked = requestId;
        return true;
      },
      confirmProceed: () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        }),
      timeoutMs: 1_000,
    });
    const pending = checker.ask();
    await vi.advanceTimersByTimeAsync(1_000);

    // The renderer wakes mid-dialog and says "clear".
    // MUTATION (dialog ownership): drop the escalated guard from answer().
    // This settles the request as clear, so the install proceeds while the
    // user is still looking at a dialog asking whether it should.
    checker.answer(asked!, false);
    await vi.advanceTimersByTimeAsync(0);

    // The user is still deciding, and their answer is the one that counts.
    decide(false);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBe(true);
  });

  it("does not block when there is no renderer to ask", async () => {
    const checker = createRecoveryChecker({
      send: () => false,
      confirmProceed: async () => false,
    });
    // Nothing rendered means no renderer-held drafts to lose.
    await expect(checker.ask()).resolves.toBe(false);
  });

  it("keeps answers keyed to their own request", async () => {
    const ids: number[] = [];
    const checker = createRecoveryChecker({
      send: (requestId) => {
        ids.push(requestId);
        return true;
      },
      confirmProceed: async () => false,
      timeoutMs: 1_000,
    });
    const first = checker.ask();
    const second = checker.ask();
    expect(ids).toHaveLength(2);
    checker.answer(ids[1]!, false);
    checker.answer(ids[0]!, true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });
});
