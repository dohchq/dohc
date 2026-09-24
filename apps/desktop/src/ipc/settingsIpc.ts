import { join } from "node:path";
import { configuredRunnerCommand } from "../agents/agentToolCatalog";
import {
  DesktopUserSettingsResult, SetUserSettingsPayload, WorkspaceSettingsPayload,
  SetWorkspaceSettingsPayload, WorkspaceSettingsResult, WorkspaceIdPayload,
  GetWorkspaceUiStateResult, SetWorkspaceUiStatePayload,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../settings/userSettings";
import { watchSettingsFile } from "../settings/settingsFileWatcher";
import {
  ensureUserSettingsFile, readCachedUserSettingsFile, reloadUserSettingsFile,
  replaceUserSettingsFile, USER_SETTINGS_FILE, writeUserSettingsFile,
} from "../settings/userSettingsStore";
import { readWorkspaceSettingsFile, saveWorkspaceSettingsFile, resetWorkspaceSettingsFile } from "../workspaces/workspaceSettingsFile";
import { readUiStateFile, writeUiStateFile } from "../workspaces/workspaceUiState";
import type { createUserSettingsWriteQueue } from "../window/windowZoom";

// Long enough for an editor to finish a save, which is often a write, a
// rename, and a timestamp touch; short enough to feel like it applied at once.
const USER_SETTINGS_RELOAD_DEBOUNCE_MS = 150;

export function createSettingsIpc<
  Sender,
  Event extends { sender: Sender },
  Operation extends { readonly workspace: { readonly rootPath: string } },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  stateDir(): string;
  enqueueUserSettingsWrite: ReturnType<typeof createUserSettingsWriteQueue>;
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
    registerHandler, assertTrustedSender, stateDir, enqueueUserSettingsWrite,
    setCachedPreferredName, applyZoomLevelToWindows, refreshDispatchTray,
    openDispatchWorkspaces, chatDispatchService, withRendererWorkspaceOperation,
    broadcastUserSettings, notifyRenderer, openPath,
  } = dependencies;

  // Runs on the settings queue, once the file holds these settings. The
  // windows must match whatever zoom level was just persisted, however it got
  // into the file.
  function takeEffect(settings: DesktopUserSettings): void {
    setCachedPreferredName(settings.profile.preferredName, settings.profile.agentName);
    applyZoomLevelToWindows(settings.appearance.zoomLevel);
  }

  async function announce(result: DesktopUserSettingsResult): Promise<void> {
    broadcastUserSettings(result);
    await refreshDispatchTray();
    const { runner } = result.settings;
    if (!runner.enabled || !configuredRunnerCommand(runner)) return;
    for (const workspace of openDispatchWorkspaces()) {
      void chatDispatchService.scanWorkspace(workspace.workspaceId).then(() => {
        notifyRenderer({ workspaceId: workspace.workspaceId });
      }).catch((error) => {
        console.error("[desktop] runner-settings dispatch scan:", error);
      });
    }
  }

  async function saveUserSettings(
    write: () => Promise<DesktopUserSettingsResult>,
  ): Promise<DesktopUserSettingsResult> {
    const result = await enqueueUserSettingsWrite(async () => {
      const saved = DesktopUserSettingsResult.parse(await write());
      takeEffect(saved.settings);
      return saved;
    });
    await announce(result);
    return result;
  }

  /**
   * Applies the settings file after a change on disk, as a save from Settings
   * applies. It runs on the settings queue, so a save in progress is either
   * already in the file or not started, and dohc's own save reads as no change.
   */
  async function reloadUserSettings(): Promise<void> {
    const result = await enqueueUserSettingsWrite(async () => {
      const reloaded = await reloadUserSettingsFile(stateDir());
      if (!reloaded) return null;
      const parsed = DesktopUserSettingsResult.parse(reloaded);
      takeEffect(parsed.settings);
      return parsed;
    });
    if (result) await announce(result);
  }

  // The watch lasts as long as main, and never keeps it alive.
  function watchUserSettingsFile(): void {
    watchSettingsFile({
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

  function registerSettingsIpcHandlers(): void {
    registerHandler(CHANNELS.getUserSettings, async (event) => {
      assertTrustedSender(event);
      return DesktopUserSettingsResult.parse(
        await readCachedUserSettingsFile(stateDir()),
      );
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
      const path = await enqueueUserSettingsWrite(() => ensureUserSettingsFile(stateDir()));
      const failure = await openPath(path);
      if (failure) throw new Error(`dohc could not open ${path}. ${failure}`);
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
    watchUserSettingsFile, reloadUserSettings,
  };
}
