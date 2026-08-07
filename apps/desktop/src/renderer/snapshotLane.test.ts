// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useSnapshotLane } from "./snapshotLane";

// One issue counter per group, shared by every lane in it — the same order the
// shell's snapshot reads are numbered by.
function lane<T>(initial: T) {
  const issue = { current: 0 };
  const view = renderHook(() => useSnapshotLane<T>(issue, initial));
  return {
    issue,
    take: () => ++issue.current,
    value: () => view.result.current[0],
    handle: () => view.result.current[1],
  };
}

describe("snapshot lane", () => {
  // Latest-COMMITTED-wins. A request that is merely in flight has answered
  // nothing, and one that FAILS never will, so only an answer OLDER than what
  // is displayed is dropped.
  it("writes a newer answer and drops an older one", () => {
    const it0 = lane<string | null>(null);
    const older = it0.take();
    const newer = it0.take();

    act(() => it0.handle().commit(newer, "newer"));
    expect(it0.value()).toBe("newer");
    expect(it0.handle().latest()).toBe("newer");

    act(() => it0.handle().commit(older, "older"));
    expect(it0.value()).toBe("newer");
    expect(it0.handle().latest()).toBe("newer");
  });

  // The user acted AFTER every request in flight was issued, so counting only
  // responses would let one of those answers undo what they just did.
  it("keeps a local write from being undone by a request already in flight", async () => {
    const it0 = lane(false);
    const inFlight = it0.take();

    act(() => it0.handle().set(true));
    expect(it0.value()).toBe(true);

    await act(async () => {
      it0.handle().settle(
        inFlight,
        Promise.resolve({ running: false }),
        (answer) => answer.running,
        () => expect.unreachable("a resolved read does not report"),
      );
      await Promise.resolve();
    });
    expect(it0.value()).toBe(true);
  });

  // Unmount, in the shell. Everything outstanding is stale, and a lane that
  // still believed nothing had answered would let any of it write.
  it("stops every read in flight from writing after an invalidation", async () => {
    const it0 = lane<string | null>(null);
    const outstanding = it0.take();

    act(() => it0.handle().invalidate());
    await act(async () => {
      it0.handle().settle(
        outstanding,
        Promise.resolve("late"),
        (answer) => answer,
        () => expect.unreachable("a resolved read does not report"),
      );
      await Promise.resolve();
    });
    expect(it0.value()).toBeNull();
  });
});
