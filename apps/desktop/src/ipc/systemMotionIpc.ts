import { CHANNELS } from "./channels";

export function registerSystemMotionIpc<Event>(deps: {
  registerHandler(channel: string, handler: (event: Event) => boolean): void;
  assertTrustedSender(event: Event): void;
  getAnimationSettings(): { prefersReducedMotion: boolean };
}): void {
  deps.registerHandler(CHANNELS.getSystemReducedMotion, (event) => {
    deps.assertTrustedSender(event);
    return deps.getAnimationSettings().prefersReducedMotion;
  });
}
