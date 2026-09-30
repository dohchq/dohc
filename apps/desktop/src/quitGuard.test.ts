import { afterEach, describe, expect, it, vi } from "vitest";
import { QUIT_ASK_TIMEOUT_MS } from "./shutdownBudgets";
import {
  createExitRounds,
  createQuitGuard,
  createWorkspaceWindowRegistry,
  type ExitKind,
  type ExitRoundMessage,
} from "./quitGuard";

type Window = { id: number; destroyed: boolean };
const window = (id: number): Window => ({ id, destroyed: false });

function rounds(options: {
  windows?: Window[];
  confirmProceed?: (kind: ExitKind) => Promise<boolean>;
} = {}) {
  const windows = options.windows ?? [window(1), window(2)];
  const sent: Array<{ to: number; message: ExitRoundMessage }> = [];
  const confirmProceed = vi.fn(options.confirmProceed ?? (async () => false));
  const exits = createExitRounds<Window>({
    participants: () => windows.filter((entry) => !entry.destroyed),
    participantId: (entry) => entry.id,
    send: (entry, message) => { sent.push({ to: entry.id, message }); },
    confirmProceed,
    timeoutMs: 1_000,
  });
  const requests = (to: number) =>
    sent.filter((entry) => entry.to === to && entry.message.kind === "request").map((entry) => entry.message.roundId);
  const closings = (to: number) =>
    sent.filter((entry) => entry.to === to && entry.message.kind !== "request").map((entry) => entry.message.kind);
  const settled = (outcome: Promise<unknown>) => {
    const state = { value: null as unknown };
    void outcome.then((value) => { state.value = value; });
    return state;
  };
  return { exits, windows, sent, requests, closings, confirmProceed, settled };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// The exit round asks every workspace window, and proceeds only when every
// one is clear. The interesting cases are what happens when the windows
// disagree, answer late, come and go, or never answer.
describe("exit rounds", () => {
  it("uses the product acknowledgement window before asking about a silent renderer", async () => {
    vi.useFakeTimers();
    const confirmProceed = vi.fn(async () => true);
    const exits = createExitRounds({
      participants: () => [window(1)],
      participantId: (participant) => participant.id,
      send: vi.fn(),
      confirmProceed,
    });
    const round = exits.begin("quit");
    await vi.advanceTimersByTimeAsync(QUIT_ASK_TIMEOUT_MS - 1);
    expect(confirmProceed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(confirmProceed).toHaveBeenCalledExactlyOnceWith("quit");
    await expect(round.outcome).resolves.toBe("forced");
  });

  it("asks every window and proceeds only when the last one clears", async () => {
    const r = rounds();
    const round = r.exits.begin("quit");
    expect(round.created).toBe(true);
    expect(r.requests(1)).toEqual([round.roundId]);
    expect(r.requests(2)).toEqual([round.roundId]);
    const state = r.settled(round.outcome);
    expect(r.exits.answer(1, round.roundId, "clear")).toBe(true);
    await Promise.resolve();
    expect(state.value, "a clear first responder must not carry the second window").toBeNull();
    r.exits.answer(2, round.roundId, "clear");
    await expect(round.outcome).resolves.toBe("proceed");
    expect(r.closings(1)).toEqual(["proceed"]);
    expect(r.closings(2)).toEqual(["proceed"]);
  });

  it("keeps a clear first responder from bypassing a held second, until it clears too", async () => {
    vi.useFakeTimers();
    const r = rounds();
    const round = r.exits.begin("update");
    r.exits.answer(1, round.roundId, "clear");
    r.exits.answer(2, round.roundId, "hold");
    await vi.advanceTimersByTimeAsync(60_000);
    // Every window answered: the held one owns the decision, no dialog.
    expect(r.confirmProceed).not.toHaveBeenCalled();
    r.exits.answer(2, round.roundId, "clear");
    await expect(round.outcome).resolves.toBe("proceed");
  });

  it("ignores a wrong sender and a stale round id", async () => {
    vi.useFakeTimers();
    const r = rounds({ windows: [window(1), window(2)] });
    const round = r.exits.begin("quit");
    expect(r.exits.answer(99, round.roundId, "clear")).toBe(false);
    expect(r.exits.answer(1, round.roundId + 1, "clear")).toBe(false);
    expect(r.exits.answer(2, round.roundId - 1, "cancel")).toBe(false);
    const state = r.settled(round.outcome);
    r.exits.answer(1, round.roundId, "clear");
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value).toBeNull();
    r.exits.answer(2, round.roundId, "clear");
    await expect(round.outcome).resolves.toBe("proceed");
  });

  it("cancels the whole round when any window goes back, and tells the others", async () => {
    const r = rounds();
    const round = r.exits.begin("update");
    r.exits.answer(1, round.roundId, "clear");
    r.exits.answer(2, round.roundId, "cancel");
    await expect(round.outcome).resolves.toBe("cancelled");
    expect(r.closings(1)).toEqual(["cancelled"]);
    expect(r.closings(2)).toEqual(["cancelled"]);
    expect(r.exits.current()).toBeNull();
    // A late clear for the cancelled round counts for nothing.
    expect(r.exits.answer(1, round.roundId, "clear")).toBe(false);
  });

  it("joins a second request for the same exit and supersedes a different one", async () => {
    const r = rounds();
    const first = r.exits.begin("update");
    const again = r.exits.begin("update");
    expect(again.created).toBe(false);
    expect(again.roundId).toBe(first.roundId);
    expect(r.requests(1)).toEqual([first.roundId, first.roundId]);
    const quit = r.exits.begin("quit");
    expect(quit.created).toBe(true);
    await expect(first.outcome).resolves.toBe("cancelled");
    await expect(again.outcome).resolves.toBe("cancelled");
    expect(r.exits.current()).toEqual({ roundId: quit.roundId, kind: "quit" });
  });

  it("removes a closed participant and enrolls a window that opens mid-round", async () => {
    const r = rounds();
    const round = r.exits.begin("quit");
    r.exits.answer(1, round.roundId, "clear");
    const third = window(3);
    r.exits.enroll(third);
    expect(r.requests(3)).toEqual([round.roundId]);
    r.windows[1]!.destroyed = true;
    r.exits.remove(2);
    const state = r.settled(round.outcome);
    await Promise.resolve();
    expect(state.value, "the new window has not answered").toBeNull();
    r.exits.answer(3, round.roundId, "clear");
    await expect(round.outcome).resolves.toBe("proceed");
    expect(r.closings(2)).toEqual([]);
  });

  it("proceeds when the last participant closes and when there is nothing to ask", async () => {
    const r = rounds({ windows: [window(1)] });
    const round = r.exits.begin("quit");
    r.exits.remove(1);
    await expect(round.outcome).resolves.toBe("proceed");
    const empty = rounds({ windows: [] });
    await expect(empty.exits.begin("update").outcome).resolves.toBe("proceed");
    expect(empty.confirmProceed).not.toHaveBeenCalled();
  });

  // A silent window may be busy, not dead. The ACK window never proceeds by
  // itself: it asks the USER, and "Wait" keeps everything as it was.
  it("asks the user about a silent window and waiting keeps a quit vetoed", async () => {
    vi.useFakeTimers();
    const r = rounds();
    const round = r.exits.begin("quit");
    r.exits.answer(1, round.roundId, "clear");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.confirmProceed).toHaveBeenCalledExactlyOnceWith("quit");
    const state = r.settled(round.outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value, "a silent renderer must never count as safe").toBeNull();
    expect(r.exits.current()?.roundId).toBe(round.roundId);
    // The slow window still answers, and its answer counts once the user
    // asks to quit again; Wait itself authorizes nothing.
    r.exits.answer(2, round.roundId, "clear");
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value).toBeNull();
    r.exits.begin("quit");
    await expect(round.outcome).resolves.toBe("proceed");
  });

  it("refuses an install outright when the user waits on a silent window", async () => {
    vi.useFakeTimers();
    const r = rounds();
    const round = r.exits.begin("update");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.confirmProceed).toHaveBeenCalledExactlyOnceWith("update");
    await expect(round.outcome).resolves.toBe("cancelled");
  });

  it("forces a quit or installs only on an explicit decision over the covered windows", async () => {
    vi.useFakeTimers();
    const quit = rounds({ confirmProceed: async () => true });
    const quitRound = quit.exits.begin("quit");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(quitRound.outcome).resolves.toBe("forced");
    expect(quit.closings(1)).toEqual([]);

    const update = rounds({ confirmProceed: async () => true });
    const updateRound = update.exits.begin("update");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(updateRound.outcome).resolves.toBe("proceed");
  });

  it("does not let a stale timeout decision cover a window enrolled while the dialog was up", async () => {
    vi.useFakeTimers();
    let decide!: (proceed: boolean) => void;
    const r = rounds({ confirmProceed: () => new Promise<boolean>((resolve) => { decide = resolve; }) });
    const round = r.exits.begin("quit");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.confirmProceed).toHaveBeenCalledOnce();
    const third = window(3);
    r.exits.enroll(third);
    decide(true);
    await vi.advanceTimersByTimeAsync(0);
    const state = r.settled(round.outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value, "the dialog never named the new window's work").toBeNull();
    // The new window answers clear for itself; the two the dialog covered
    // are decided by that dialog, and only they are forced.
    r.exits.answer(3, round.roundId, "clear");
    await expect(round.outcome).resolves.toBe("forced");
    expect(r.exits.takeForcedParticipants().map((entry) => entry.id)).toEqual([1, 2]);
    expect(r.closings(3)).toEqual(["proceed"]);
    expect(r.closings(1)).toEqual([]);
  });

  it("lets the escalation dialog own an install against a late renderer answer", async () => {
    vi.useFakeTimers();
    let decide!: (proceed: boolean) => void;
    const r = rounds({ confirmProceed: () => new Promise<boolean>((resolve) => { decide = resolve; }) });
    const round = r.exits.begin("update");
    await vi.advanceTimersByTimeAsync(1_000);
    // Both wake mid-dialog and say clear.
    r.exits.answer(1, round.roundId, "clear");
    r.exits.answer(2, round.roundId, "clear");
    const state = r.settled(round.outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value).toBeNull();
    decide(false);
    await expect(round.outcome).resolves.toBe("cancelled");
  });

  it("keeps a newcomer's reply while the install dialog is up, and lets it cancel", async () => {
    vi.useFakeTimers();
    let decide!: (proceed: boolean) => void;
    const r = rounds({ confirmProceed: () => new Promise<boolean>((resolve) => { decide = resolve; }) });
    const round = r.exits.begin("update");
    await vi.advanceTimersByTimeAsync(1_000);
    const third = window(3);
    r.exits.enroll(third);
    // Its hold is kept: after the dialog proceeds, the round waits on it.
    expect(r.exits.answer(3, round.roundId, "hold")).toBe(true);
    decide(true);
    await vi.advanceTimersByTimeAsync(0);
    const state = r.settled(round.outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value, "a held newcomer must not be overridden by a dialog that never named it").toBeNull();
    r.exits.answer(3, round.roundId, "clear");
    await expect(round.outcome).resolves.toBe("proceed");

    // And its Go back cancels even while the dialog is still open.
    const again = rounds({ confirmProceed: () => new Promise<boolean>(() => undefined) });
    const second = again.exits.begin("update");
    await vi.advanceTimersByTimeAsync(1_000);
    again.exits.enroll(window(3));
    expect(again.exits.answer(3, second.roundId, "cancel")).toBe(true);
    await expect(second.outcome).resolves.toBe("cancelled");
  });

  it("does not stage an install behind an open dialog when the last member leaves", async () => {
    vi.useFakeTimers();
    let decide!: (proceed: boolean) => void;
    const r = rounds({ windows: [window(1)], confirmProceed: () => new Promise<boolean>((resolve) => { decide = resolve; }) });
    const round = r.exits.begin("update");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.confirmProceed).toHaveBeenCalledOnce();
    r.exits.remove(1);
    const state = r.settled(round.outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value, "the user is still deciding the warning").toBeNull();
    decide(false);
    await expect(round.outcome).resolves.toBe("cancelled");

    const two = rounds({ confirmProceed: () => new Promise<boolean>((resolve) => { decide = resolve; }) });
    const twoRound = two.exits.begin("update");
    two.exits.answer(1, twoRound.roundId, "clear");
    await vi.advanceTimersByTimeAsync(1_000);
    // The silent member closes: the clear one alone would settle, but not
    // behind the dialog.
    two.exits.remove(2);
    const twoState = two.settled(twoRound.outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(twoState.value).toBeNull();
    decide(true);
    await expect(twoRound.outcome).resolves.toBe("proceed");
  });

  it("forces only the silent windows the quit dialog was about, never one that answered for itself", async () => {
    vi.useFakeTimers();
    let decide!: (proceed: boolean) => void;
    const r = rounds({ confirmProceed: () => new Promise<boolean>((resolve) => { decide = resolve; }) });
    const round = r.exits.begin("quit");
    r.exits.answer(1, round.roundId, "clear");
    // A window opened after the round began answers clear before the
    // dialog. It can still capture a draft after that, so it is never
    // destroyed under a decision about someone else's silence.
    const third = window(3);
    r.exits.enroll(third);
    r.exits.answer(3, round.roundId, "clear");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.confirmProceed).toHaveBeenCalledOnce();
    // One more window opens while the dialog is up: not covered either.
    const fourth = window(4);
    r.exits.enroll(fourth);
    r.exits.answer(4, round.roundId, "clear");
    decide(true);
    await expect(round.outcome).resolves.toBe("forced");
    expect(r.exits.takeForcedParticipants().map((entry) => entry.id)).toEqual([2]);
    expect(r.exits.takeForcedParticipants()).toEqual([]);
    for (const id of [1, 3, 4]) expect(r.closings(id)).toEqual(["proceed"]);
    expect(r.closings(2)).toEqual([]);
  });

  it("re-asks a window enrolled before it loaded, and retracts a proceeded round to every member", async () => {
    const r = rounds({ windows: [window(1)] });
    const round = r.exits.begin("update");
    const late = window(2);
    r.exits.enroll(late);
    r.exits.enroll(late);
    expect(r.requests(2)).toEqual([round.roundId, round.roundId]);
    r.exits.answer(1, round.roundId, "clear");
    r.exits.answer(2, round.roundId, "clear");
    await expect(round.outcome).resolves.toBe("proceed");
    // A stale id retracts nothing; the proceeded round reaches both.
    r.exits.retract(round.roundId + 1);
    expect(r.closings(2)).toEqual(["proceed"]);
    r.exits.retract(round.roundId);
    expect(r.closings(2)).toEqual(["proceed", "cancelled"]);
    expect(r.closings(1)).toEqual(["proceed", "cancelled"]);
    r.exits.retract(round.roundId);
    expect(r.closings(1)).toEqual(["proceed", "cancelled"]);
  });

  // Wait is not authorization. It keeps the quit vetoed, asks nothing more,
  // and the next explicit quit decides afresh.
  it("does not re-prompt after Wait on a silent window, and a new quit asks again", async () => {
    vi.useFakeTimers();
    const r = rounds({ confirmProceed: async () => false });
    const round = r.exits.begin("quit");
    r.exits.answer(1, round.roundId, "clear");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.confirmProceed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.confirmProceed, "Wait must not repeat the prompt unasked").toHaveBeenCalledOnce();
    expect(r.exits.current()?.roundId).toBe(round.roundId);
    // The user asks to quit again: the silent window is asked once more,
    // and its silence goes back to the user.
    const again = r.exits.begin("quit");
    expect(again.roundId).toBe(round.roundId);
    expect(r.requests(2)).toEqual([round.roundId, round.roundId]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.confirmProceed).toHaveBeenCalledTimes(2);
  });

  it("does not prompt for a window that opens or reloads during Wait until the next explicit quit", async () => {
    vi.useFakeTimers();
    const r = rounds({ confirmProceed: async () => false });
    const round = r.exits.begin("quit");
    r.exits.answer(1, round.roundId, "clear");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.confirmProceed).toHaveBeenCalledOnce();
    // A new window is tracked and then loads, and a member that already
    // answered reloads. Each is asked, and none re-prompts the user.
    const third = window(3);
    r.exits.enroll(third);
    r.exits.enroll(third);
    r.exits.enroll(r.windows[1]!);
    expect(r.requests(3)).toEqual([round.roundId, round.roundId]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.confirmProceed, "Wait must not be undone by a window opening").toHaveBeenCalledOnce();
    expect(r.exits.current()?.roundId).toBe(round.roundId);
    // Explicit quit re-arms: the silent windows go back to the user.
    r.exits.begin("quit");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.confirmProceed).toHaveBeenCalledTimes(2);
  });

  it("lets a late clear during Wait settle only on the next explicit quit", async () => {
    vi.useFakeTimers();
    let decide!: (proceed: boolean) => void;
    const r = rounds({ confirmProceed: () => new Promise<boolean>((resolve) => { decide = resolve; }) });
    const round = r.exits.begin("quit");
    r.exits.answer(1, round.roundId, "clear");
    await vi.advanceTimersByTimeAsync(1_000);
    // The slow window answers clear while the dialog is up; the user waits.
    r.exits.answer(2, round.roundId, "clear");
    decide(false);
    await vi.advanceTimersByTimeAsync(0);
    const state = r.settled(round.outcome);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.value, "Wait is not authorization to quit").toBeNull();
    expect(r.confirmProceed).toHaveBeenCalledOnce();
    // Cmd+Q again: everyone is clear, so the quit proceeds without a stuck
    // round asking nobody.
    const again = r.exits.begin("quit");
    expect(again.created).toBe(false);
    await expect(round.outcome).resolves.toBe("proceed");
    expect(r.exits.current()).toBeNull();
  });
});

describe("quit guard", () => {
  function makeGuard() {
    const ask = vi.fn();
    const quit = vi.fn();
    const forceQuit = vi.fn();
    return { guard: createQuitGuard({ ask, quit, forceQuit }), ask, quit, forceQuit };
  }
  function quitEvent() {
    const event = { prevented: false, preventDefault: () => undefined };
    event.preventDefault = () => { event.prevented = true; };
    return event;
  }

  it("intercepts the first quit and starts the round", () => {
    const { guard, ask, quit } = makeGuard();
    const event = quitEvent();
    expect(guard.beforeQuit(event)).toBe("asked");
    expect(event.prevented).toBe(true);
    expect(ask).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
  });

  it("resumes into a real quit and does not ask again for it", () => {
    const { guard, quit } = makeGuard();
    guard.beforeQuit(quitEvent());
    guard.resume();
    expect(quit).toHaveBeenCalledOnce();
    const second = quitEvent();
    expect(guard.beforeQuit(second)).toBe("proceed");
    expect(second.prevented).toBe(false);
  });

  it("forces only through the force path, and a held quit revokes any approval", () => {
    const { guard, quit, forceQuit, ask } = makeGuard();
    guard.beforeQuit(quitEvent());
    guard.force();
    expect(forceQuit).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    expect(guard.beforeQuit(quitEvent())).toBe("proceed");
    guard.hold();
    const next = quitEvent();
    expect(guard.beforeQuit(next)).toBe("asked");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("pre-approves an update's own quit, and a refused install revokes it", () => {
    const { guard, ask } = makeGuard();
    guard.approve();
    expect(guard.beforeQuit(quitEvent())).toBe("proceed");
    expect(ask).not.toHaveBeenCalled();
    guard.revoke();
    expect(guard.beforeQuit(quitEvent())).toBe("asked");
  });
});

// Which renderers answer for the quit. Not every window runs the workspace:
// the PDF export creates a hidden, preload-less one, and asking IT would
// answer nothing while the user sees the unresponsive dialog over drafts that
// were fully available.
describe("workspace window registry", () => {
  type FakeWindow = { id: string; destroyed: boolean; crashed?: boolean };

  it("asks only windows whose renderer still runs, and still lists a crashed one for the force path", () => {
    const registry = createWorkspaceWindowRegistry<FakeWindow>((entry) => entry.destroyed, (entry) => entry.crashed === true);
    const working: FakeWindow = { id: "working", destroyed: false };
    const crashed: FakeWindow = { id: "crashed", destroyed: false, crashed: true };
    const closed: FakeWindow = { id: "closed", destroyed: true };
    registry.track(working);
    registry.track(crashed);
    registry.track(closed);
    expect(registry.answering().map((entry) => entry.id)).toEqual(["working"]);
    expect(registry.allLive().map((entry) => entry.id)).toEqual(["working", "crashed"]);
  });

  it("lists every live workspace window for the force-quit path", () => {
    const registry = createWorkspaceWindowRegistry<FakeWindow>((entry) => entry.destroyed, (entry) => entry.crashed === true);
    const first: FakeWindow = { id: "first", destroyed: false };
    const gone: FakeWindow = { id: "gone", destroyed: true };
    const second: FakeWindow = { id: "second", destroyed: false };
    registry.track(first);
    registry.track(gone);
    registry.track(second);
    expect(registry.allLive().map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("answers with a tracked workspace window, never another live window", () => {
    const registry = createWorkspaceWindowRegistry<FakeWindow>((entry) => entry.destroyed, (entry) => entry.crashed === true);
    const workspace: FakeWindow = { id: "workspace", destroyed: false };
    const pdfExport: FakeWindow = { id: "pdf-export", destroyed: false };
    registry.track(workspace);
    expect(registry.live()).toBe(workspace);
    expect(registry.live()).not.toBe(pdfExport);
  });

  it("skips destroyed windows and forgets closed ones", () => {
    const registry = createWorkspaceWindowRegistry<FakeWindow>((entry) => entry.destroyed, (entry) => entry.crashed === true);
    const closed: FakeWindow = { id: "old", destroyed: true };
    const open: FakeWindow = { id: "new", destroyed: false };
    registry.track(closed);
    registry.track(open);
    expect(registry.live()).toBe(open);
    registry.forget(open);
    expect(registry.live()).toBeUndefined();
  });
});
