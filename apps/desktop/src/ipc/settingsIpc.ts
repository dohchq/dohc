import { join } from "node:path";
import { configuredRunnerCommand } from "../agents/agentToolCatalog";
import {
  DesktopUserSettingsResult, SetUserSettingsPayload, WorkspaceSettingsPayload,
  SetWorkspaceSettingsPayload, WorkspaceSettingsResult, WorkspaceIdPayload,
  GetWorkspaceUiStateResult, SetWorkspaceUiStatePayload,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import {
  DEFAULT_USER_SETTINGS,
  settingsDeepEqual,
  type DesktopUserSettings,
  type ZoomStep,
} from "../settings/userSettings";
import { watchSettingsFile } from "../settings/settingsFileWatcher";
import {
  ensureUserSettingsFile, readCachedUserSettingsFile, reloadUserSettingsFile,
  replaceUserSettingsFile, updateUserSettingsFile, USER_SETTINGS_FILE, writeUserSettingsFile,
} from "../settings/userSettingsStore";
import {
  readWorkspaceSettingsFile, resetWorkspaceSettingsFile, saveWorkspaceSettingsFile,
  workspaceSettingsPath,
} from "../workspaces/workspaceSettingsFile";
import { readUiStateFile, writeUiStateFile } from "../workspaces/workspaceUiState";
import { nextZoomLevel } from "../window/windowZoom";

// Long enough for an editor to finish a save, which is often a write, a
// rename, and a timestamp touch; short enough to feel like it applied at once.
const USER_SETTINGS_RELOAD_DEBOUNCE_MS = 150;

type UserSettingsChange = {
  // What the file held before, whose effects were in place.
  previous: DesktopUserSettings;
  result: DesktopUserSettingsResult;
};

export function createSettingsIpc<
  Sender,
  Event extends { sender: Sender },
  Operation extends { readonly workspace: { readonly rootPath: string } },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  stateDir(): string;
  setCachedPreferredName(preferredName: string | undefined, agentName: string | undefined): void;
  applyZoomLevelToWindows(zoomLevel: number): void;
  refreshDispatchTray(): Promise<unknown>;
  openDispatchWorkspaces(): readonly { workspaceId: string }[];
  chatDispatchService: { scanWorkspace(workspaceId: string): Promise<unknown> };
  notifyRenderer(scope: { workspaceId: string }): void;
  // Tells every window the settings changed. The writer already has the
  // result; the other surfaces learn it here.
  broadcastUserSettings(result: DesktopUserSettingsResult): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, message: string,
    work: (operation: Operation) => Result | Promise<Result>,
  ): Promise<Result>;
  // The system's own opener; answers an error message, or "" when it opened.
  openPath(path: string): Promise<string>;
}) {
  const {
    registerHandler, assertTrustedSender, stateDir,
    setCachedPreferredName, applyZoomLevelToWindows, refreshDispatchTray,
    openDispatchWorkspaces, chatDispatchService, withRendererWorkspaceOperation,
    broadcastUserSettings, notifyRenderer, openPath,
  } = dependencies;

  // Every change to the user settings file runs here, one at a time, and each
  // one takes effect before the next starts. So what the store last read or
  // wrote is always what is in effect.
  let tail: Promise<unknown> = Promise.resolve();
  function enqueueUserSettingsWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  }

  // The windows must match whatever zoom level is in the file, however it got
  // there.
  function takeEffect(settings: DesktopUserSettings): void {
    setCachedPreferredName(settings.profile.preferredName, settings.profile.agentName);
    applyZoomLevelToWindows(settings.appearance.zoomLevel);
  }

  async function announce({ previous, result }: UserSettingsChange): Promise<void> {
    broadcastUserSettings(result);
    await refreshDispatchTray();
    const { runner, profile } = result.settings;
    if (!runner.enabled || !configuredRunnerCommand(runner)) return;
    // A scan finds messages that wait for the runner. Only a change to the
    // runner or to the agent's name can make one due, so a zoom step does not
    // scan every open workspace.
    if (
      settingsDeepEqual(previous.runner, runner) &&
      previous.profile.agentName === profile.agentName
    ) {
      return;
    }
    for (const workspace of openDispatchWorkspaces()) {
      void chatDispatchService.scanWorkspace(workspace.workspaceId).then(() => {
        notifyRenderer({ workspaceId: workspace.workspaceId });
      }).catch((error) => {
        console.error("[desktop] runner-settings dispatch scan:", error);
      });
    }
  }

  // The one way the user settings change: a save from Settings, a zoom step,
  // a reset, or an edit in the file. `write` answers null when nothing changed.
  async function changeUserSettings(
    write: () => Promise<DesktopUserSettingsResult | null>,
  ): Promise<UserSettingsChange | null> {
    const change = await enqueueUserSettingsWrite(async () => {
      const previous = (await readCachedUserSettingsFile(stateDir())).settings;
      const written = await write();
      if (!written) return null;
      const result = DesktopUserSettingsResult.parse(written);
      takeEffect(result.settings);
      return { previous, result };
    });
    if (change) await announce(change);
    return change;
  }

  async function saveUserSettings(
    write: () => Promise<DesktopUserSettingsResult>,
  ): Promise<DesktopUserSettingsResult> {
    const change = await changeUserSettings(write);
    if (!change) throw new Error("dohc did not save settings.");
    return change.result;
  }

  /**
   * Applies the settings file after a change on disk, as a save applies. On
   * the queue, a save in progress is either already in the file or not
   * started, and dohc's own save reads as no change. Answers the settings in
   * effect afterwards.
   */
  async function reloadUserSettings(): Promise<DesktopUserSettingsResult> {
    const change = await changeUserSettings(() => reloadUserSettingsFile(stateDir()));
    return change?.result ?? DesktopUserSettingsResult.parse(
      await readCachedUserSettingsFile(stateDir()),
    );
  }

  // One zoom step, from the zoom level in the file as it is now.
  function stepWindowZoom(step: ZoomStep): Promise<DesktopUserSettingsResult> {
    return saveUserSettings(() =>
      updateUserSettingsFile(stateDir(), (current) => ({
        ...current,
        appearance: {
          ...current.appearance,
          zoomLevel: nextZoomLevel(current.appearance.zoomLevel, step),
        },
      })));
  }

  // Answers the function that stops the watch. It never keeps main alive.
  function watchUserSettingsFile(): () => void {
    return watchSettingsFile({
      directory: stateDir(),
      fileName: USER_SETTINGS_FILE,
      debounceMs: USER_SETTINGS_RELOAD_DEBOUNCE_MS,
      onChange: () => {
        void reloadUserSettings().catch((error) => {
          console.error("[desktop] settings file reload:", error);
        });
      },
      onError: (error) => console.error("[desktop] settings file watch:", error),
    });
  }

  async function openSettingsFile(path: string): Promise<void> {
    const failure = await openPath(path);
    if (failure) {
      throw new Error(`dohc could not open ${path}. ${failure} Open the file in a text editor.`);
    }
  }

  function registerSettingsIpcHandlers(): void {
    registerHandler(CHANNELS.getUserSettings, async (event) => {
      assertTrustedSender(event);
      return DesktopUserSettingsResult.parse(
        await readCachedUserSettingsFile(stateDir()),
      );
    });

    registerHandler(CHANNELS.reloadUserSettings, async (event) => {
      assertTrustedSender(event);
      return reloadUserSettings();
    });

    registerHandler(CHANNELS.setUserSettings, async (event, payload) => {
      assertTrustedSender(event);
      const input = SetUserSettingsPayload.parse(payload);
      return saveUserSettings(() =>
        writeUserSettingsFile(stateDir(), input.settings, input.base));
    });

    registerHandler(CHANNELS.resetUserSettings, async (event) => {
      assertTrustedSender(event);
      return saveUserSettings(() => replaceUserSettingsFile(stateDir(), DEFAULT_USER_SETTINGS));
    });

    registerHandler(CHANNELS.getUserSettingsFilePath, (event) => {
      assertTrustedSender(event);
      return join(stateDir(), USER_SETTINGS_FILE);
    });

    // The file lives in dohc's own folder, outside every workspace, so it
    // opens in the person's editor rather than dohc's: dohc's editor writes
    // only inside a workspace. The watcher applies the save.
    registerHandler(CHANNELS.openUserSettingsFile, async (event) => {
      assertTrustedSender(event);
      await openSettingsFile(
        await enqueueUserSettingsWrite(() => ensureUserSettingsFile(stateDir())),
      );
    });

    // `.dohc` is dohc's own folder, which dohc's editor does not write, so
    // this file opens in the person's editor too.
    registerHandler(CHANNELS.openWorkspaceSettingsFile, async (event, payload) => {
      assertTrustedSender(event);
      const input = WorkspaceSettingsPayload.parse(payload);
      const path = await withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "Workspace settings stopped opening because this window changed workspaces.",
        (operation) => workspaceSettingsPath(operation.workspace.rootPath),
      );
      await openSettingsFile(path);
    });

    registerHandler(CHANNELS.getWorkspaceSettings, async (event, payload) => {
      assertTrustedSender(event);
      const input = WorkspaceSettingsPayload.parse(payload);
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "Workspace settings read stopped because this window changed workspaces.",
        async (operation) =>
          WorkspaceSettingsResult.parse(
            await readWorkspaceSettingsFile(operation.workspace.rootPath),
          ),
      );
    });

    registerHandler(CHANNELS.setWorkspaceSettings, async (event, payload) => {
      assertTrustedSender(event);
      const input = SetWorkspaceSettingsPayload.parse(payload);
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "Workspace settings save stopped because this window changed workspaces.",
        async (operation) =>
          WorkspaceSettingsResult.parse(
            await saveWorkspaceSettingsFile(
              operation.workspace.rootPath,
              input.patch,
            ),
          ),
      );
    });

    registerHandler(CHANNELS.resetWorkspaceSettings, async (event, payload) => {
      assertTrustedSender(event);
      const input = WorkspaceSettingsPayload.parse(payload);
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "Workspace settings reset stopped because this window changed workspaces.",
        async (operation) =>
          WorkspaceSettingsResult.parse(
            await resetWorkspaceSettingsFile(operation.workspace.rootPath),
          ),
      );
    });
  }

  function registerWorkspaceUiStateIpcHandlers(): void {
    // Per-workspace workbench UI state (.dohc/ui-state.json). The renderer
    // cannot write .dohc through writeWorkspaceText (reserved path) — this
    // narrow pair is the only writer, same pattern as agent-runs.json. Both
    // directions are zod-bounded; a corrupt/foreign on-disk file reads as null
    // ("no saved state"), never an error.
    registerHandler(CHANNELS.getWorkspaceUiState, async (event, payload) => {
      assertTrustedSender(event);
      const input = WorkspaceIdPayload.parse(payload);
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "UI state read stopped because this window changed workspaces.",
        async (operation) => {
          const parsed = GetWorkspaceUiStateResult.safeParse(
            await readUiStateFile(operation.workspace.rootPath),
          );
          return parsed.success ? parsed.data : null;
        },
      );
    });

    registerHandler(CHANNELS.setWorkspaceUiState, async (event, payload) => {
      assertTrustedSender(event);
      const input = SetWorkspaceUiStatePayload.parse(payload);
      await withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "UI state write stopped because this window changed workspaces.",
        (operation) => writeUiStateFile(operation.workspace.rootPath, input.state),
      );
    });
  }

  return {
    registerSettingsIpcHandlers, registerWorkspaceUiStateIpcHandlers,
    watchUserSettingsFile, reloadUserSettings, stepWindowZoom,
  };
}
