import { describe, expect, it } from "vitest";
import {
  initialUpdateState,
  releaseChannelFromArgv,
  releaseChannelPreloadArguments,
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

  it("walks the full path: check → available → download → downloading → ready", () => {
    const checking = run([{ type: "check" }]);
    expect(checking).toMatchObject({ status: "checking", message: "Checking for updates…" });

    const available = transition(checking, { type: "available", version: "1.2.0" });
    expect(available).toEqual({ status: "available", version: "1.2.0", message: "dohc 1.2.0 is available." });

    const started = transition(available, { type: "download" });
    expect(started).toEqual({ status: "downloading", version: "1.2.0", message: "Downloading update 1.2.0…" });

    const downloading = transition(started, { type: "progress", percent: 41.5 });
    expect(downloading).toEqual({ status: "downloading", version: "1.2.0", percent: 41.5, message: "Downloading update 1.2.0, 42%" });

    const done = transition(downloading, { type: "downloaded", version: "1.2.0" });
    expect(done).toMatchObject({ status: "ready", version: "1.2.0" });
    expect(done.message).toMatch(/restart dohc/i);
  });

  it("downloads nothing a person did not ask for", () => {
    const available = run([{ type: "check" }, { type: "available", version: "1.2.0" }]);
    expect(transition(available, { type: "progress", percent: 10 })).toBe(available);
    expect(transition(available, { type: "downloaded", version: "1.2.0" })).toBe(available);
    expect(run([{ type: "check" }, { type: "downloaded", version: "1.2.0" }]).status).toBe("checking");
    expect(transition(initialUpdateState, { type: "download" })).toBe(initialUpdateState);
  });

  it("reports up-to-date when no update exists, and can re-check from there", () => {
    const upToDate = run([{ type: "check" }, { type: "not-available" }]);
    expect(upToDate).toMatchObject({ status: "up-to-date" });
    expect(upToDate.message).toMatch(/latest version/);
    expect(transition(upToDate, { type: "check" }).status).toBe("checking");
  });

  it("surfaces a failed check with its reason, then recovers via check", () => {
    const failed = transition(run([{ type: "check" }]), { type: "error", message: "feed returned 500" });
    expect(failed).toEqual({ status: "error", message: "feed returned 500" });
    expect(transition(failed, { type: "check" }).status).toBe("checking");
  });

  it("returns a failed or offline download to the found update", () => {
    const downloading = run([
      { type: "check" },
      { type: "available", version: "1.2.0" },
      { type: "download" },
      { type: "progress", percent: 50 },
    ]);
    for (const event of [{ type: "error", message: "sha512 checksum mismatch" }, { type: "offline" }] as const) {
      const failed = transition(downloading, event);
      expect(failed).toEqual({ status: "available", version: "1.2.0", message: "dohc 1.2.0 is available." });
      expect(transition(failed, { type: "download" }).status).toBe("downloading");
    }
  });

  it("keeps a downloaded update through errors and offline — installing it is local", () => {
    const ready = run([
      { type: "check" },
      { type: "available", version: "1.2.0" },
      { type: "download" },
      { type: "downloaded", version: "1.2.0" },
    ]);
    expect(transition(ready, { type: "error", message: "feed returned 500" })).toBe(ready);
    expect(transition(ready, { type: "offline" })).toBe(ready);
  });

  it("goes offline from checking and recovers via check", () => {
    const offline = run([{ type: "check" }, { type: "offline" }]);
    expect(offline.status).toBe("offline");
    expect(offline.message).toMatch(/offline/);
    expect(transition(offline, { type: "check" }).status).toBe("checking");
  });

  it("never restarts a flow already in progress", () => {
    const checking = run([{ type: "check" }]);
    expect(transition(checking, { type: "check" })).toBe(checking);

    const available = transition(checking, { type: "available", version: "1.2.0" });
    expect(transition(available, { type: "check" })).toBe(available);

    const downloading = run([{ type: "download" }, { type: "progress", percent: 30 }], available);
    expect(transition(downloading, { type: "check" })).toBe(downloading);
    expect(transition(downloading, { type: "download" })).toBe(downloading);
    expect(transition(downloading, { type: "available", version: "9.9.9" })).toBe(downloading);
    expect(transition(downloading, { type: "not-available" })).toBe(downloading);

    const ready = transition(downloading, { type: "downloaded", version: "1.2.0" });
    expect(transition(ready, { type: "check" })).toBe(ready);
    expect(transition(ready, { type: "download" })).toBe(ready);
    expect(transition(ready, { type: "downloaded", version: "2.0.0" })).toBe(ready);
  });

  it("ignores stray progress/downloaded events outside a download", () => {
    expect(transition(initialUpdateState, { type: "progress", percent: 10 })).toBe(initialUpdateState);
    expect(transition(initialUpdateState, { type: "downloaded", version: "1.0.0" })).toBe(initialUpdateState);
    const upToDate = run([{ type: "check" }, { type: "not-available" }]);
    expect(transition(upToDate, { type: "progress", percent: 10 })).toBe(upToDate);
  });
});

describe("release channel preload argument", () => {
  it("carries the build's channel from main to the preload", () => {
    expect(releaseChannelFromArgv(["electron", ...releaseChannelPreloadArguments("nightly")])).toBe("nightly");
    expect(releaseChannelFromArgv(["electron", ...releaseChannelPreloadArguments("latest")])).toBe("latest");
    expect(releaseChannelFromArgv(["electron"])).toBe("latest");
  });
});
