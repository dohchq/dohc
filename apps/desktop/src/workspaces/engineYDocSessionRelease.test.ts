import { describe, expect, it, vi } from "vitest";

import { releaseEngineYDocSession } from "./engineYDocSessionRelease";

interface TestEntry {
  session: { close: () => Promise<void> };
  path: string;
  label: string;
  closeFailed?: boolean;
}

function entryOf(label: string, close: () => Promise<void>): TestEntry {
  return { label, path: "notes/a.md", session: { close } };
}

describe("releaseEngineYDocSession", () => {
  it("drops the session from the registry when the close succeeds", async () => {
    const sessions = new Map<string, TestEntry>();
    const entry = entryOf("a", async () => undefined);
    sessions.set("s1", entry);
    const onCloseFailed = vi.fn();

    const released = await releaseEngineYDocSession({
      sessions,
      sessionId: "s1",
      entry,
      reason: "stale session replaced",
      onCloseFailed,
    });

    expect(released).toBe(true);
    expect(sessions.has("s1")).toBe(false);
    expect(entry.closeFailed).toBeUndefined();
    expect(onCloseFailed).not.toHaveBeenCalled();
  });

  it("MARKS the session when the close fails, and clears the mark by releasing it", async () => {
    // The mark is how the next open of this document finds the session to
    // retry: the renderer retries under a NEW session id, so nothing keyed by
    // id can reach it. An unmarked entry is a LIVE session someone owns.
    const sessions = new Map<string, TestEntry>();
    let refuse = true;
    const entry = entryOf("a", async () => {
      if (refuse) throw new Error("daemon refused the release");
    });
    sessions.set("s1", entry);

    expect(
      await releaseEngineYDocSession({
        sessions,
        sessionId: "s1",
        entry,
        reason: "renderer closed the document",
        onCloseFailed: () => undefined,
      }),
    ).toBe(false);
    expect(entry.closeFailed).toBe(true);

    refuse = false;
    expect(
      await releaseEngineYDocSession({
        sessions,
        sessionId: "s1",
        entry,
        reason: "unreleased session retried by a new open",
        onCloseFailed: () => undefined,
      }),
    ).toBe(true);
    // Released means gone: the mark cannot outlive the entry that carries it.
    expect(sessions.has("s1")).toBe(false);
  });

  it("KEEPS the session registered when the close fails", async () => {
    // The capture layer retains a failed close as `failing-close` and rethrows,
    // precisely because the reservation may still be held. If main drops its own
    // record too, nothing left in main can retry the teardown — not the close
    // IPC, not the renderer-destroy hook, not the quit sweep.
    const sessions = new Map<string, TestEntry>();
    const entry = entryOf("a", async () => {
      throw new Error("daemon refused the release");
    });
    sessions.set("s1", entry);

    const released = await releaseEngineYDocSession({
      sessions,
      sessionId: "s1",
      entry,
      reason: "stale session replaced",
      onCloseFailed: () => undefined,
    });

    expect(released).toBe(false);
    expect(sessions.get("s1")).toBe(entry);
  });

  it("REGISTERS an unregistered session when its close fails", async () => {
    // The renderer-died and kind-mismatch closes tear down a session main never
    // registered. A failed close there leaked the session entirely: the daemon
    // may still hold it and no main-side teardown could ever reach it again.
    const sessions = new Map<string, TestEntry>();
    const entry = entryOf("a", async () => {
      throw new Error("transport closed");
    });

    const released = await releaseEngineYDocSession({
      sessions,
      sessionId: "s1",
      entry,
      reason: "kind-mismatched lineage",
      onCloseFailed: () => undefined,
    });

    expect(released).toBe(false);
    expect(sessions.get("s1")).toBe(entry);
  });

  it("reports the failure with the path, the reason, and the error", async () => {
    // "Show agents the limits they hit": a swallowed close is indistinguishable
    // from an intended fallback in the log, which is how this survived.
    const sessions = new Map<string, TestEntry>();
    const error = new Error("daemon refused the release");
    const entry = entryOf("a", async () => {
      throw error;
    });
    const onCloseFailed = vi.fn();

    await releaseEngineYDocSession({
      sessions,
      sessionId: "s1",
      entry,
      reason: "kind-mismatched lineage",
      onCloseFailed,
    });

    expect(onCloseFailed).toHaveBeenCalledTimes(1);
    const [message, reported] = onCloseFailed.mock.calls[0] as [string, unknown];
    expect(reported).toBe(error);
    expect(message).toContain("notes/a.md");
    expect(message).toContain("kind-mismatched lineage");
    // The consequence, not just the event: this is what makes the read-only
    // answer the honest one.
    expect(message).toContain("may still hold");
  });

  it("never evicts a DIFFERENT session that took the id", async () => {
    // Two opens can share a session id across the await inside the open handler.
    // Releasing the older one must not deregister the live one.
    const sessions = new Map<string, TestEntry>();
    const live = entryOf("live", async () => undefined);
    const stale = entryOf("stale", async () => undefined);
    sessions.set("s1", live);

    const released = await releaseEngineYDocSession({
      sessions,
      sessionId: "s1",
      entry: stale,
      reason: "stale session replaced",
      onCloseFailed: () => undefined,
    });

    expect(released).toBe(true);
    expect(sessions.get("s1")).toBe(live);
  });

  it("never displaces a DIFFERENT session when a failed close needs a home", async () => {
    const sessions = new Map<string, TestEntry>();
    const live = entryOf("live", async () => undefined);
    const stale = entryOf("stale", async () => {
      throw new Error("daemon refused the release");
    });
    sessions.set("s1", live);

    const released = await releaseEngineYDocSession({
      sessions,
      sessionId: "s1",
      entry: stale,
      reason: "stale session replaced",
      onCloseFailed: () => undefined,
    });

    expect(released).toBe(false);
    expect(sessions.get("s1")).toBe(live);
    // ...and it is still REACHABLE. Leaving it out of the registry is the
    // unreachability this module exists to remove: no sweep, no close, and no
    // retry could ever release the lease again.
    expect([...sessions.values()]).toContain(stale);
    expect(sessions.get("s1#failed-1")).toBe(stale);
  });

  it("reaches an id-collision failure by sweep and by document, and never doubles it", async () => {
    // The two ways anything finds a failed session: the renderer and quit
    // sweeps walk the VALUES, and the next open scans by document. Neither
    // reads the key, which is why a derived one costs nothing.
    const sessions = new Map<string, TestEntry>();
    let refuse = true;
    const live = entryOf("live", async () => undefined);
    const stale = entryOf("stale", async () => {
      if (refuse) throw new Error("daemon refused the release");
    });
    sessions.set("s1", live);

    await releaseEngineYDocSession({
      sessions,
      sessionId: "s1",
      entry: stale,
      reason: "stale session replaced",
      onCloseFailed: () => undefined,
    });

    // A sweep re-releases it under the key it is registered with. Refused
    // again, it stays where it is instead of taking a second home.
    const sweep = async (): Promise<boolean[]> =>
      Promise.all(
        [...sessions]
          .filter(([, entry]) => entry.closeFailed && entry.path === "notes/a.md")
          .map(([sessionId, entry]) =>
            releaseEngineYDocSession({
              sessions,
              sessionId,
              entry,
              reason: "renderer teardown",
              onCloseFailed: () => undefined,
            }),
          ),
      );

    expect(await sweep()).toEqual([false]);
    expect(sessions.size).toBe(2);
    expect(sessions.get("s1#failed-1")).toBe(stale);

    refuse = false;
    expect(await sweep()).toEqual([true]);
    expect([...sessions.values()]).toEqual([live]);
  });
});
