import { describe, expect, it, vi } from "vitest";
import { waitForReceivedShareCaptureReady } from "./receivedShareCaptureReady";

describe("waitForReceivedShareCaptureReady", () => {
  it("waits through an early import and rechecks renderer authority", async () => {
    const events: string[] = [];
    const readStatus = vi
      .fn()
      .mockImplementationOnce(async () => {
        events.push("status:importing");
        return { phase: "importing" as const, terminal: false };
      })
      .mockImplementationOnce(async () => {
        events.push("status:ready");
        return { phase: "ready" as const, terminal: false };
      });

    await waitForReceivedShareCaptureReady({
      readStatus,
      assertCurrent: () => events.push("current"),
      waitForPoll: async () => {
        events.push("wait");
      },
    });

    expect(events).toEqual([
      "current",
      "status:importing",
      "current",
      "wait",
      "current",
      "status:ready",
      "current",
    ]);
  });

  it("stops before another status read when the renderer switches workspaces", async () => {
    const switched = new Error("renderer switched workspaces");
    const readStatus = vi.fn(async () => ({
      phase: "starting" as const,
      terminal: false,
    }));
    let currentChecks = 0;

    await expect(
      waitForReceivedShareCaptureReady({
        readStatus,
        assertCurrent: () => {
          currentChecks += 1;
          if (currentChecks === 3) throw switched;
        },
        waitForPoll: async () => undefined,
      }),
    ).rejects.toBe(switched);
    expect(readStatus).toHaveBeenCalledTimes(1);
  });

  it("does not wait forever when capture has stopped terminally", async () => {
    const waitForPoll = vi.fn(async () => undefined);

    await waitForReceivedShareCaptureReady({
      readStatus: async () => ({ phase: "starting", terminal: true }),
      assertCurrent: () => undefined,
      waitForPoll,
    });

    expect(waitForPoll).not.toHaveBeenCalled();
  });
});
