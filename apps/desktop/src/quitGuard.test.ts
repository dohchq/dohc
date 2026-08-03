import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuitGuard } from "./quitGuard";

function makeGuard(overrides: {
  confirmForceQuit?: () => Promise<boolean>;
} = {}) {
  const askRenderer = vi.fn();
  const quit = vi.fn();
  const confirmForceQuit = vi.fn(
    overrides.confirmForceQuit ?? (async () => false),
  );
  const guard = createQuitGuard({
    askRenderer,
    confirmForceQuit,
    quit,
    timeoutMs: 1_000,
  });
  return { guard, askRenderer, quit, confirmForceQuit };
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

  it("force-quits only on an explicit decision", async () => {
    vi.useFakeTimers();
    const { guard, quit } = makeGuard({ confirmForceQuit: async () => true });
    guard.beforeQuit(quitEvent());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(quit).toHaveBeenCalledTimes(1);
    const next = quitEvent();
    expect(guard.beforeQuit(next)).toBe("proceed");
  });

  it("drops a stale force-quit answer when the renderer already resumed", async () => {
    vi.useFakeTimers();
    let decide!: (quitAnyway: boolean) => void;
    const { guard, quit } = makeGuard({
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
    // No second quit from the stale dialog answer.
    expect(quit).toHaveBeenCalledTimes(1);
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
