import { describe, expect, it, vi } from "vitest";

import {
  claimEngineYDocSessionSlot,
  engineYDocSessionKey,
} from "./engineYDocSessionRegistry";
import { releaseEngineYDocSession } from "./engineYDocSessionRelease";

interface TestEntry {
  session: { close: () => Promise<void> };
  path: string;
  closeFailed?: boolean;
}

// What a stranded session COSTS is a lease the daemon still holds, so these
// tests count the daemon's live sessions, not the registry's entries.
function daemon(): {
  live: Set<string>;
  open: (path: string, options?: { closeFails?: boolean }) => TestEntry;
} {
  const live = new Set<string>();
  return {
    live,
    open(path, options = {}) {
      live.add(path);
      return {
        path,
        session: {
          close: async () => {
            if (options.closeFails) throw new Error("daemon refused the close");
            live.delete(path);
          },
        },
      };
    },
  };
}

// The open handler's shape around the claim (main.ts, CHANNELS.engineYDocOpen):
// it looks at the registry, awaits the daemon open, then claims the slot. The
// gate is that await, so a test can hold two opens inside it at once. The claim
// and the release are the shipped ones.
async function openUnderKey(input: {
  sessions: Map<string, TestEntry>;
  key: string;
  entry: TestEntry;
  gate: Promise<void>;
  onRefused: (message: string) => void;
}): Promise<{ available: boolean; engineMayHoldDocument: boolean }> {
  const { sessions, key, entry } = input;
  expect(sessions.get(key)).toBeUndefined();
  await input.gate;
  const claim = await claimEngineYDocSessionSlot({
    sessions,
    key,
    entry,
    release: (reason) =>
      releaseEngineYDocSession({
        sessions,
        sessionKey: key,
        entry,
        reason,
        onCloseFailed: () => undefined,
      }),
    onRefused: input.onRefused,
  });
  return {
    available: claim.claimed,
    engineMayHoldDocument: !claim.claimed && !claim.released,
  };
}

describe("engineYDocSessionKey", () => {
  it("keeps one renderer-minted id apart per sender", () => {
    // The id is the RENDERER's. Two windows minting the same one must not meet
    // in main's registry at all.
    expect(engineYDocSessionKey(1, "eyd-1")).not.toBe(
      engineYDocSessionKey(2, "eyd-1"),
    );
    expect(engineYDocSessionKey(1, "eyd-1")).toBe(engineYDocSessionKey(1, "eyd-1"));
  });
});

describe("claimEngineYDocSessionSlot", () => {
  it("refuses the later open instead of burying the live session", async () => {
    // Two opens under ONE id, for two documents. Both looked at an empty slot;
    // the second must not replace the first, whose daemon session would then be
    // live and unreachable — every later update and close for its document
    // would land on the second entry (#683).
    const engine = daemon();
    const sessions = new Map<string, TestEntry>();
    const key = engineYDocSessionKey(7, "eyd-1");
    const refusals: string[] = [];
    let openDaemon = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      openDaemon = resolve;
    });
    const first = engine.open("notes/a.md");
    const second = engine.open("notes/b.md");

    const opens = Promise.all([
      openUnderKey({ sessions, key, entry: first, gate, onRefused: (m) => refusals.push(m) }),
      openUnderKey({ sessions, key, entry: second, gate, onRefused: (m) => refusals.push(m) }),
    ]);
    openDaemon();
    const [a, b] = await opens;

    expect(a).toEqual({ available: true, engineMayHoldDocument: false });
    expect(b).toEqual({ available: false, engineMayHoldDocument: false });
    expect([...sessions.values()]).toEqual([first]);
    // The refused open let its own session go, so the daemon holds exactly the
    // one document the registry can still reach.
    expect([...engine.live]).toEqual(["notes/a.md"]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain(key);
    expect(refusals[0]).toContain("notes/a.md");
    expect(refusals[0]).toContain("notes/b.md");
  });

  it("keeps the refused session reachable when its close FAILS", async () => {
    // The refusal cannot pretend the document is free: the daemon may still
    // hold it, so the answer is engineMayHoldDocument and the session stays in
    // the registry — under a derived key, because the live owner holds this one
    // (engineYDocSessionRelease.ts).
    const engine = daemon();
    const sessions = new Map<string, TestEntry>();
    const key = engineYDocSessionKey(7, "eyd-1");
    const live = engine.open("notes/a.md");
    sessions.set(key, live);
    const refused = engine.open("notes/b.md", { closeFails: true });

    const claim = await claimEngineYDocSessionSlot({
      sessions,
      key,
      entry: refused,
      release: (reason) =>
        releaseEngineYDocSession({
          sessions,
          sessionKey: key,
          entry: refused,
          reason,
          onCloseFailed: () => undefined,
        }),
      onRefused: () => undefined,
    });

    expect(claim).toEqual({ claimed: false, released: false });
    expect(sessions.get(key)).toBe(live);
    expect(sessions.get(`${key}#failed-1`)).toBe(refused);
    expect(refused.closeFailed).toBe(true);
    expect([...engine.live]).toEqual(["notes/a.md", "notes/b.md"]);
  });

  it("lets two senders hold the same renderer-minted id", async () => {
    // Nothing is shared between windows here: each keeps its own session, and
    // neither open sees the other's slot.
    const engine = daemon();
    const sessions = new Map<string, TestEntry>();
    const refused = vi.fn();
    const gate = Promise.resolve();
    const one = engine.open("notes/a.md");
    const two = engine.open("notes/b.md");

    const answers = await Promise.all([
      openUnderKey({
        sessions,
        key: engineYDocSessionKey(1, "eyd-1"),
        entry: one,
        gate,
        onRefused: refused,
      }),
      openUnderKey({
        sessions,
        key: engineYDocSessionKey(2, "eyd-1"),
        entry: two,
        gate,
        onRefused: refused,
      }),
    ]);

    expect(answers).toEqual([
      { available: true, engineMayHoldDocument: false },
      { available: true, engineMayHoldDocument: false },
    ]);
    expect(sessions.get(engineYDocSessionKey(1, "eyd-1"))).toBe(one);
    expect(sessions.get(engineYDocSessionKey(2, "eyd-1"))).toBe(two);
    expect([...engine.live]).toEqual(["notes/a.md", "notes/b.md"]);
    expect(refused).not.toHaveBeenCalled();
  });
});
