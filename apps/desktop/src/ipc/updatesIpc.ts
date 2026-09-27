import { UpdateActionResult, UpdateCheckResult, type UpdateStateEvent } from "./bridgeContract";
import { CHANNELS } from "./channels";
import type { AutoUpdateController } from "../updates/electronUpdater";
import type { createExitRounds, createQuitGuard } from "../quitGuard";

/**
 * Restarts into a downloaded update once every workspace window agrees. The
 * renderer's Restart and main's offer after a failure both go through it.
 */
export function createUpdateInstall<Participant = unknown>(dependencies: {
  currentUpdateState(): UpdateStateEvent;
  readonly autoUpdateController: Pick<AutoUpdateController, "installUpdate"> | null;
  exitRounds: Pick<ReturnType<typeof createExitRounds<Participant>>, "begin" | "retract">;
  quitGuard: Pick<ReturnType<typeof createQuitGuard>, "approve" | "revoke">;
}): () => Promise<UpdateActionResult> {
  const { currentUpdateState, exitRounds, quitGuard } = dependencies;
  // One install at a time. A second request while the round is open joins
  // it and shares its answer, so two windows asking to restart never race
  // two stagings.
  let staging: Promise<UpdateActionResult> | null = null;

  return async () => {
    const controller = dependencies.autoUpdateController;
    if (!controller) {
      return UpdateActionResult.parse({
        accepted: false,
        state: currentUpdateState(),
      });
    }
    if (staging) return staging;
    // Ask every workspace window at the quit boundary: the requesting
    // renderer checked before it called, another window may hold drafts of
    // its own, and a reopen can set an edit aside in the gap. Only once
    // every window is clear does main approve the quit that quitAndInstall
    // starts — the round cannot veto it afterwards, because that would burn
    // the one-shot latch.
    const round = exitRounds.begin("update");
    // Every window in the round holds a restart intent and an approval for
    // it, and the round retracts both if the staging fails.
    const install = round.outcome.then(async (outcome) => {
      if (outcome !== "proceed") {
        return UpdateActionResult.parse({
          accepted: false,
          cancelled: true,
          state: currentUpdateState(),
        });
      }
      quitGuard.approve();
      let result: UpdateActionResult;
      try {
        result = UpdateActionResult.parse(await controller.installUpdate());
      } catch (error) {
        quitGuard.revoke();
        exitRounds.retract(round.roundId);
        throw error;
      }
      if (!result.accepted) {
        quitGuard.revoke();
        exitRounds.retract(round.roundId);
      }
      return result;
    });
    staging = install;
    const release = () => {
      if (staging === install) staging = null;
    };
    void install.then(release, release);
    return install;
  };
}

export function registerUpdatesIpcHandlers<Event>(dependencies: {
  registerHandler(channel: string, handler: (event: Event) => unknown): void;
  assertTrustedSender(event: Event): void;
  currentUpdateState(): UpdateStateEvent;
  readonly autoUpdateController: Pick<AutoUpdateController, "checkForUpdates"> | null;
  installUpdate(): Promise<UpdateActionResult>;
}): void {
  const { registerHandler, assertTrustedSender, currentUpdateState, installUpdate } = dependencies;

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
    return await installUpdate();
  });
}
