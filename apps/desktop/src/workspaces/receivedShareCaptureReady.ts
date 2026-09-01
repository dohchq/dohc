import { setTimeout as delay } from "node:timers/promises";

const CAPTURE_READY_POLL_MS = 250;

type InitialCaptureStatus = {
  phase: "starting" | "importing" | "ready" | "degraded";
  terminal: boolean;
};

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
