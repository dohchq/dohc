import { setTimeout as delay } from "node:timers/promises";
import type { WatcherStatusResult } from "@dohc/workspace-engine-client";

const CAPTURE_READY_POLL_MS = 250;

type InitialCaptureStatus = Pick<WatcherStatusResult, "phase" | "terminal">;

export async function waitForReceivedShareCaptureReady(input: {
  readStatus: (() => Promise<InitialCaptureStatus>) | undefined;
  assertCurrent(): void;
  waitForPoll?: () => Promise<void>;
}): Promise<void> {
  if (!input.readStatus) return;
  for (;;) {
    input.assertCurrent();
    const status = await input.readStatus();
    input.assertCurrent();
    if (
      status.terminal ||
      (status.phase !== "starting" && status.phase !== "importing")
    ) {
      return;
    }
    await (input.waitForPoll?.() ?? delay(CAPTURE_READY_POLL_MS));
  }
}
