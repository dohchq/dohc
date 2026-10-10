import { expect, it, vi } from "vitest";
import { CHANNELS } from "./channels";
import { SystemReducedMotionResult } from "./bridgeContract";
import { registerSystemMotionIpc } from "./systemMotionIpc";

it("checks the sender before reading the current native preference", () => {
  let handle!: (trusted: boolean) => boolean;
  const getAnimationSettings = vi.fn(() => ({ prefersReducedMotion: false }));
  registerSystemMotionIpc<boolean>({
    registerHandler(channel, handler) {
      expect(channel).toBe(CHANNELS.getSystemReducedMotion);
      handle = handler;
    },
    assertTrustedSender(trusted) { if (!trusted) throw new Error("Untrusted sender"); },
    getAnimationSettings,
  });
  expect(() => handle(false)).toThrow("Untrusted sender");
  expect(getAnimationSettings).not.toHaveBeenCalled();
  expect(handle(true)).toBe(false);
  getAnimationSettings.mockReturnValue({ prefersReducedMotion: true });
  expect(handle(true)).toBe(true);
  expect(SystemReducedMotionResult.parse(true)).toBe(true);
  expect(SystemReducedMotionResult.safeParse("true").success).toBe(false);
});
