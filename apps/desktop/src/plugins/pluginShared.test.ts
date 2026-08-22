import { describe, expect, it, vi } from "vitest";
import {
  awaitCommandClaimsDrainedWithDeadline,
  COMMAND_CLAIMS_DRAIN_DEADLINE_MS,
} from "./pluginShared";

describe("awaitCommandClaimsDrainedWithDeadline", () => {
  it("resolves with the real lower the instant the drain settles, without ever logging", async () => {
    let lowered = false;
    const warn = vi.fn();

    const result = await awaitCommandClaimsDrainedWithDeadline(
      "example-plugin",
      Promise.resolve(() => {
        lowered = true;
      }),
      warn,
    );
    result();

    expect(lowered).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it(
    "logs which plugin overran and proceeds with a no-op lower once the deadline elapses, then still lowers the real claim once the command finally settles (round-15 finding 3)",
    async () => {
      vi.useFakeTimers();
      try {
        let lowered = false;
        let resolveDrain!: (lower: () => void) => void;
        const drained = new Promise<() => void>((resolve) => {
          resolveDrain = resolve;
        });
        const warn = vi.fn();

        const resultPromise = awaitCommandClaimsDrainedWithDeadline(
          "example-plugin",
          drained,
          warn,
        );

        // A settling command still completes cleanly first: short of the
        // full deadline, nothing has fired yet.
        await vi.advanceTimersByTimeAsync(COMMAND_CLAIMS_DRAIN_DEADLINE_MS - 1);
        expect(warn).not.toHaveBeenCalled();

        // The deadline itself elapses: the caller proceeds to stop the
        // host, and the overrun is logged by name.
        await vi.advanceTimersByTimeAsync(1);
        const result = await resultPromise;
        expect(warn).toHaveBeenCalledTimes(1);
        const [message] = warn.mock.calls[0] as [string];
        expect(message).toContain("example-plugin");
        expect(message).toContain(String(COMMAND_CLAIMS_DRAIN_DEADLINE_MS));

        // The no-op lower handed back to the caller must never touch the
        // real claim.
        result();
        expect(lowered).toBe(false);

        // The hung command's handler eventually settles (the host
        // teardown that followed the deadline terminated it) — the real
        // lower still fires then, so the barrier never leaks.
        resolveDrain(() => {
          lowered = true;
        });
        await drained;
        await Promise.resolve();
        expect(lowered).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    "never produces an unhandled rejection when the drain itself rejects after the deadline already elapsed (#779 round 22 finding 13)",
    async () => {
      vi.useFakeTimers();
      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);
      try {
        let rejectDrain!: (error: unknown) => void;
        const drained = new Promise<() => void>((_resolve, reject) => {
          rejectDrain = reject;
        });
        const warn = vi.fn();

        const resultPromise = awaitCommandClaimsDrainedWithDeadline(
          "example-plugin",
          drained,
          warn,
        );
        await vi.advanceTimersByTimeAsync(COMMAND_CLAIMS_DRAIN_DEADLINE_MS);
        await resultPromise;
        expect(warn).toHaveBeenCalledTimes(1);

        // The deferred `drained.then((lower) => lower())` chain this
        // deadline attached above has no lower to call once the drain
        // itself rejects instead of ever settling — only itself to
        // swallow. Rejecting it here, after the deadline already fired,
        // is what actually exercises that swallow.
        rejectDrain(new Error("drain rejected after the deadline"));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
        vi.useRealTimers();
      }
    },
  );
});
