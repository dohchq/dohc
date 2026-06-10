import { describe, expect, it } from "vitest";
import {
  initialUpdateState,
  transition,
  type UpdateEvent,
  type UpdateState,
} from "./updateMachine";

function run(events: UpdateEvent[], from: UpdateState = initialUpdateState): UpdateState {
  return events.reduce(transition, from);
}

describe("updateMachine", () => {
  it("starts idle with a user-visible message", () => {
    expect(initialUpdateState.status).toBe("idle");
    expect(initialUpdateState.message).toMatch(/not been checked/);
  });

  it("walks the full happy path: check → available → downloading → ready", () => {
    const checking = run([{ type: "check" }]);
    expect(checking).toMatchObject({ status: "checking", message: "Checking for updates…" });

    const available = transition(checking, { type: "available", version: "1.2.0" });
    expect(available).toMatchObject({ status: "available", version: "1.2.0" });
    expect(available.message).toContain("1.2.0");

    const downloading = transition(available, { type: "progress", percent: 41.5 });
    expect(downloading).toMatchObject({ status: "downloading", version: "1.2.0", percent: 41.5 });
    expect(downloading.message).toContain("42%");

    const further = transition(downloading, { type: "progress", percent: 90 });
    expect(further).toMatchObject({ status: "downloading", percent: 90 });

    const done = transition(further, { type: "downloaded", version: "1.2.0" });
    expect(done).toMatchObject({ status: "ready", version: "1.2.0", deferred: false });
    expect(done.message).toMatch(/restart dohc/i);
  });

  it("reports up-to-date when no update exists, and can re-check from there", () => {
    const upToDate = run([{ type: "check" }, { type: "not-available" }]);
    expect(upToDate).toMatchObject({ status: "up-to-date" });
    expect(upToDate.message).toMatch(/latest version/);
    expect(transition(upToDate, { type: "check" }).status).toBe("checking");
  });

  it("reaches ready when a cached/small download skips progress events", () => {
    const state = run([{ type: "check" }, { type: "downloaded", version: "1.3.0" }]);
    expect(state).toMatchObject({ status: "ready", version: "1.3.0", deferred: false });
  });

  it("defers a downloaded update to install-on-quit", () => {
    const ready = run([
      { type: "check" },
      { type: "available", version: "1.2.0" },
      { type: "downloaded", version: "1.2.0" },
    ]);
    const deferred = transition(ready, { type: "defer" });
    expect(deferred).toMatchObject({ status: "ready", version: "1.2.0", deferred: true });
    expect(deferred.message).toMatch(/when you quit dohc/);
    // Deferring again is a no-op state-wise.
    expect(transition(deferred, { type: "defer" })).toEqual(deferred);
  });

  it("ignores defer when no update is downloaded", () => {
    expect(transition(initialUpdateState, { type: "defer" })).toBe(initialUpdateState);
    const checking = run([{ type: "check" }]);
    expect(transition(checking, { type: "defer" })).toBe(checking);
  });

  it("surfaces errors from in-flight states with the failure reason, then recovers via check", () => {
    const paths: UpdateEvent[][] = [
      [{ type: "check" }],
      [{ type: "check" }, { type: "available", version: "1.2.0" }, { type: "progress", percent: 10 }],
    ];
    for (const events of paths) {
      const failed = transition(run(events), { type: "error", message: "feed returned 500" });
      expect(failed.status).toBe("error");
      expect(failed.message).toContain("feed returned 500");
      expect(transition(failed, { type: "check" }).status).toBe("checking");
    }
  });

  it("keeps a downloaded update through errors — install-on-quit still applies", () => {
    const ready = run([{ type: "check" }, { type: "downloaded", version: "1.2.0" }]);
    expect(transition(ready, { type: "error", message: "feed returned 500" })).toBe(ready);
  });

  it("goes offline from checking/downloading and recovers via check", () => {
    const fromChecking = run([{ type: "check" }, { type: "offline" }]);
    expect(fromChecking.status).toBe("offline");
    expect(fromChecking.message).toMatch(/offline/);

    const fromDownloading = run([
      { type: "check" },
      { type: "available", version: "1.2.0" },
      { type: "progress", percent: 50 },
      { type: "offline" },
    ]);
    expect(fromDownloading.status).toBe("offline");
    expect(transition(fromDownloading, { type: "check" }).status).toBe("checking");
  });

  it("keeps a downloaded update through offline — install-on-quit needs no network", () => {
    const ready = run([{ type: "check" }, { type: "downloaded", version: "1.2.0" }]);
    expect(transition(ready, { type: "offline" })).toBe(ready);
  });

  it("never restarts a flow already in progress", () => {
    const checking = run([{ type: "check" }]);
    expect(transition(checking, { type: "check" })).toBe(checking);

    const downloading = run([
      { type: "check" },
      { type: "available", version: "1.2.0" },
      { type: "progress", percent: 30 },
    ]);
    expect(transition(downloading, { type: "check" })).toBe(downloading);
    expect(transition(downloading, { type: "available", version: "9.9.9" })).toBe(downloading);
    expect(transition(downloading, { type: "not-available" })).toBe(downloading);

    const ready = transition(downloading, { type: "downloaded", version: "1.2.0" });
    expect(transition(ready, { type: "check" })).toBe(ready);
    expect(transition(ready, { type: "downloaded", version: "2.0.0" })).toBe(ready);
  });

  it("ignores stray progress/downloaded events outside an update flow", () => {
    expect(transition(initialUpdateState, { type: "progress", percent: 10 })).toBe(initialUpdateState);
    expect(transition(initialUpdateState, { type: "downloaded", version: "1.0.0" })).toBe(initialUpdateState);
    const upToDate = run([{ type: "check" }, { type: "not-available" }]);
    expect(transition(upToDate, { type: "progress", percent: 10 })).toBe(upToDate);
  });
});
