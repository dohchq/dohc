import { describe, expect, it } from "vitest";

import { createPresencePollRegistry } from "./presencePollRegistry";

// Sender ids stand in for Electron webContents ids (one per window).
const WINDOW_A = 1;
const WINDOW_B = 2;

describe("createPresencePollRegistry", () => {
  it("aborts a poll only for its OWNING sender (cross-window cancel is a no-op)", () => {
    const registry = createPresencePollRegistry();
    const a = registry.begin(WINDOW_A, "p", "key-a");

    // Window B cancels using window A's pollId: it owns no such poll, so A's
    // long-poll keeps running.
    registry.cancel(WINDOW_B, "p");
    expect(a.signal.aborted).toBe(false);

    // The owning window's cancel does abort it.
    registry.cancel(WINDOW_A, "p");
    expect(a.signal.aborted).toBe(true);
  });

  it("keeps a pollId collision across two senders independently cancellable", () => {
    const registry = createPresencePollRegistry();
    const a = registry.begin(WINDOW_A, "p", "key-a");
    const b = registry.begin(WINDOW_B, "p", "key-b");

    // A finishing (release) must not remove B's controller: each handle only
    // ever deletes its OWN entry, so B stays cancellable.
    a.release();
    expect(b.signal.aborted).toBe(false);
    registry.cancel(WINDOW_B, "p");
    expect(b.signal.aborted).toBe(true);
  });

  it("supersedes a prior poll for the same (sender, scope, topic)", () => {
    const registry = createPresencePollRegistry();
    const first = registry.begin(WINDOW_A, "p1", "same-key");
    const second = registry.begin(WINDOW_A, "p2", "same-key");

    // One long-poll per scope+topic per window: the new poll aborts the old.
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(registry.activeCount()).toBe(1);
  });

  it("a superseded poll's release does not remove the superseding entry", () => {
    const registry = createPresencePollRegistry();
    const first = registry.begin(WINDOW_A, "p1", "same-key");
    const second = registry.begin(WINDOW_A, "p2", "same-key");

    // The old poll's finally runs after it was superseded; it must be a no-op
    // for the map so the new poll stays cancellable.
    first.release();
    registry.cancel(WINDOW_A, "p2");
    expect(second.signal.aborted).toBe(true);
  });

  it("bounds concurrent polls per sender (unique keys can't grow unboundedly)", () => {
    const registry = createPresencePollRegistry({ maxPerSender: 8 });
    for (let i = 0; i < 100; i += 1) {
      registry.begin(WINDOW_A, `p${i}`, `key-${i}`);
    }
    expect(registry.activeCount()).toBeLessThanOrEqual(8);
  });

  it("aborts a poll cancelled during setup (before its body runs)", () => {
    const registry = createPresencePollRegistry();
    // Models the handler registering the controller BEFORE awaiting scope
    // resolution: a cancel arriving during that await must abort promptly.
    const handle = registry.begin(WINDOW_A, "p", "key-a");
    registry.cancel(WINDOW_A, "p");
    expect(handle.signal.aborted).toBe(true);
  });

  it("aborts every outstanding poll when a sender's window is destroyed", () => {
    const registry = createPresencePollRegistry();
    const one = registry.begin(WINDOW_A, "p1", "key-1");
    const two = registry.begin(WINDOW_A, "p2", "key-2");
    const other = registry.begin(WINDOW_B, "p3", "key-3");

    registry.disposeSender(WINDOW_A);

    expect(one.signal.aborted).toBe(true);
    expect(two.signal.aborted).toBe(true);
    // A different window is untouched.
    expect(other.signal.aborted).toBe(false);
    expect(registry.activeCount()).toBe(1);
  });

  it("release removes the poll from the active count", () => {
    const registry = createPresencePollRegistry();
    const handle = registry.begin(WINDOW_A, "p", "key-a");
    expect(registry.activeCount()).toBe(1);
    handle.release();
    expect(registry.activeCount()).toBe(0);
  });
});
