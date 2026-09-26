import { describe, expect, it } from "vitest";
import { closeActivity, holdBackground, leaveForeground, releaseBackground, type ActivityUse } from "./activityRelease";

const use = (overrides: Partial<ActivityUse> = {}): ActivityUse =>
  ({ retainedActivity: false, backgroundHolds: 0, activityClosing: null, ...overrides });

describe("closing a workspace's activity", () => {
  it("leaves a workspace a window or background work holds open", () => {
    let closes = 0;
    const close = async () => { closes += 1; };
    expect(closeActivity(use({ retainedActivity: true }), close, { unlessInUse: true })).toBeNull();
    expect(closeActivity(use({ backgroundHolds: 1 }), close, { unlessInUse: true })).toBeNull();
    expect(closes).toBe(0);
  });

  it("closes after a background run when the window that opened the workspace meanwhile has left", async () => {
    const state = use();
    const closes: string[] = [];
    const close = async () => { closes.push("closed"); };
    // A schedule run holds the workspace; a window opens it too.
    holdBackground(state);
    state.retainedActivity = true;
    // The last window closes before the run ends: its hold goes, the run's stays.
    leaveForeground(state);
    expect(closeActivity(state, close, { unlessInUse: true }), "the run still holds it").toBeNull();
    // The run ends and its release closes the workspace.
    releaseBackground(state);
    await closeActivity(state, close, { unlessInUse: true });
    expect(closes).toEqual(["closed"]);
  });

  it("publishes the close before anything can yield, so a window that arrives waits for it", async () => {
    const state = use();
    let finish: () => void = () => undefined;
    const steps: string[] = [];
    const closing = closeActivity(state, async () => {
      steps.push("close started");
      await new Promise<void>((resolve) => { finish = resolve; });
      steps.push("close ended");
    }, { unlessInUse: true });
    expect(state.activityClosing, "published at once").toBe(closing);

    // A window opens the workspace now: it retains it and waits for the close.
    state.retainedActivity = true;
    const reopened = state.activityClosing!.then(() => steps.push("window opened"));
    expect(closeActivity(state, async () => { steps.push("second close"); }), "a second close joins").toBe(closing);
    finish();
    await reopened;
    expect(steps).toEqual(["close started", "close ended", "window opened"]);
    expect(state.activityClosing, "cleared once it ends").toBeNull();
  });
});
