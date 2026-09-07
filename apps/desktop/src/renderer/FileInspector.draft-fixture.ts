import { act } from "@testing-library/react";
import { vi } from "vitest";
import { orphanedDraftStoreVersionForTests, resetOrphanedDrafts } from "./orphanedDrafts";

// Unmounting a dirty editor starts a write — that is the unmount flush, and it
// is meant to outlive the component. Its promise chain therefore settles a turn
// or more after `cleanup()` returns, so a teardown that clears the mocks right
// away hands that write to the next test, whose beforeEach has already
// re-stubbed the same bridge object. The next test then sees a call it never
// made and fails on a count or an argument that has nothing to do with it.
//
// Turning the event loop until that work goes quiet keeps every call inside the
// test that caused it. Quiescence is the condition, not a fixed number of
// turns: a test that deliberately holds a write unresolved makes no further
// calls, so the loop still ends on the next turn.
//
// The bridge is not the only thing the flush can end in. When writes are
// blocked it sets the draft aside instead, which touches no mock at all and
// notifies the draft store a microtask later — re-rendering the recovery notice
// inside the next test, under the button it was about to click. So the wait
// covers both: bridge calls and draft-store mutations.
export async function settleAfterUnmount(): Promise<void> {
  const activity = () => {
    const stubbed = window.dohcDesktop as unknown as
      | Record<string, unknown>
      | undefined;
    const calls = stubbed
      ? Object.values(stubbed).reduce(
          (total: number, value) =>
            total + (vi.isMockFunction(value) ? value.mock.calls.length : 0),
          0,
        )
      : 0;
    return calls + orphanedDraftStoreVersionForTests();
  };
  await act(async () => {
    let previous = -1;
    while (previous !== activity()) {
      previous = activity();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

// `resetOrphanedDrafts` notifies through a microtask of its own, so the reset
// has to be drained too — otherwise teardown's own notification is what lands
// mid-click in the next test.
export async function resetOrphanedDraftsAndSettle(): Promise<void> {
  resetOrphanedDrafts();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export const TEST_CONTENT_HASH = "a".repeat(64);
