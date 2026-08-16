// What main does when a web app start consumed the plugin's one-time
// credential and then failed on its way to a rendered guest: a destroyed
// window, a rejected navigation, a request the renderer moved on from. The
// decisions live here, where a test can watch them; main.ts supplies the
// Electron effects.

export type WebAppRecoveryStage = "unpair" | "stop";

/**
 * Recovers one failed start. Three steps, in this order:
 *
 * 1. Tell the page. It is sitting on a `ready` state in front of an empty
 *    frame, and it must leave that state even if the teardown below hangs.
 * 2. Unpair. The credential is spent and no guest session cookie replaced it,
 *    so the plugin must retire the session it paired or every later open
 *    reaches its server with an empty cookie jar. This runs before the view
 *    stop, which may take the plugin's host — and the transport this needs —
 *    down with it.
 * 3. Stop the view, releasing the guest and this open's claim on the host.
 *
 * Neither teardown step may skip the other: an unpair that throws still
 * leaves a view to release, and a plugin that is already gone still leaves a
 * record in the registry.
 */
export async function recoverConsumedWebAppCredential(input: {
  notifyFailed: () => void;
  unpair: () => Promise<void>;
  stopView: () => Promise<void>;
  onError: (stage: WebAppRecoveryStage, error: unknown) => void;
}): Promise<void> {
  input.notifyFailed();
  try {
    await input.unpair();
  } catch (error) {
    input.onError("unpair", error);
  }
  try {
    await input.stopView();
  } catch (error) {
    input.onError("stop", error);
  }
}
