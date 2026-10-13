import { expect, it, vi } from "vitest";
import { systemMotionOperations } from "./bridgeContract";
import { registerSystemMotionIpc } from "./systemMotionIpc";

it("checks the sender and payload before reading and validating the native preference", async () => {
  let handle!: (trusted: boolean, payload: unknown) => Promise<unknown>;
  const getAnimationSettings = vi.fn(() => ({ prefersReducedMotion: false }));
  registerSystemMotionIpc<boolean, never>({
    handle(channel, handler) {
      expect(channel).toBe(systemMotionOperations.getSystemReducedMotion.channel);
      handle = handler;
    },
    assertTrustedSender(trusted) { if (!trusted) throw new Error("Untrusted sender"); },
    withActiveWorkspace: vi.fn(() => { throw new Error("Device operation must not enter a workspace"); }),
  }, getAnimationSettings);
  await expect(handle(false, {})).rejects.toThrow("Untrusted sender");
  expect(getAnimationSettings).not.toHaveBeenCalled();
  await expect(handle(true, null)).rejects.toThrow();
  expect(getAnimationSettings).not.toHaveBeenCalled();
  await expect(handle(true, {})).resolves.toBe(false);
  getAnimationSettings.mockReturnValue({ prefersReducedMotion: true });
  await expect(handle(true, {})).resolves.toBe(true);
  getAnimationSettings.mockReturnValue({ prefersReducedMotion: "true" as never });
  await expect(handle(true, {})).rejects.toThrow();
});
