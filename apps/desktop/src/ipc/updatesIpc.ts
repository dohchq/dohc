import { UpdateActionResult, UpdateCheckResult, type UpdateStateEvent } from "./bridgeContract";
import { CHANNELS } from "./channels";
import type { AutoUpdateController } from "../updates/electronUpdater";
import type { createQuitGuard, createRecoveryChecker } from "../quitGuard";

export function registerUpdatesIpcHandlers<Event>(dependencies: {
  registerHandler(channel: string, handler: (event: Event) => unknown): void;
  assertTrustedSender(event: Event): void;
  currentUpdateState(): UpdateStateEvent;
  readonly autoUpdateController: Pick<AutoUpdateController, "checkForUpdates" | "installUpdate"> | null;
  recoveryChecker: Pick<ReturnType<typeof createRecoveryChecker>, "ask">;
  quitGuard: Pick<ReturnType<typeof createQuitGuard>, "approve" | "revoke">;
}): void {
  const { registerHandler, assertTrustedSender, currentUpdateState, recoveryChecker, quitGuard } = dependencies;

  registerHandler(CHANNELS.getUpdateState, (event) => {
    assertTrustedSender(event);
    return currentUpdateState();
  });

  registerHandler(CHANNELS.checkForUpdates, async (event) => {
    assertTrustedSender(event);
    if (!dependencies.autoUpdateController) {
      return UpdateCheckResult.parse({
        checked: false,
        state: currentUpdateState(),
      });
    }
    return UpdateCheckResult.parse(await dependencies.autoUpdateController.checkForUpdates());
  });

  registerHandler(CHANNELS.installUpdate, async (event) => {
    assertTrustedSender(event);
    if (!dependencies.autoUpdateController) {
      return UpdateActionResult.parse({
        accepted: false,
        state: currentUpdateState(),
      });
    }
    // Re-ask at the quit boundary: the renderer checked
    // before it called, and a reopen can set an edit aside in the gap. Only
    // once main has a fresh answer does it approve the quit that
    // quitAndInstall starts — the ask cannot veto it afterwards, because
    // that would burn the one-shot latch.
    if (await recoveryChecker.ask()) {
      return UpdateActionResult.parse({
        accepted: false,
        state: currentUpdateState(),
      });
    }
    quitGuard.approve();
    const result = UpdateActionResult.parse(
      await dependencies.autoUpdateController.installUpdate(),
    );
    if (!result.accepted) quitGuard.revoke();
    return result;
  });
}
