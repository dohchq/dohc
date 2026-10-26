import { agentKeyForGroup, agentColorChanges } from "../workspaces/actorPresentation";
import type { AgentColorChangedEvent } from "./bridgeContract";
import { join } from "node:path";
import { DesktopUserSettingsResult, WorkspaceSettingsResult, GetWorkspaceUiStateResult } from "./bridgeContract";
import type { settingsOperations } from "./settingsOperations";
import type { OperationHandlers } from "./operationTable";
import {
  DEFAULT_USER_SETTINGS,
  AgentColors, StoredUserSettingsResult, firstAgent, firstAgentWithLaunch, rendererUserSettingsResult,
  settingsDeepEqual,
  type DesktopUserSettings,
  type ThemeMode,
  type ZoomStep,
} from "../settings/userSettings";
import { withAppPinned } from "../settings/pinnedApps";
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
  previous: StoredUserSettingsResult;
  result: StoredUserSettingsResult;
};

export function createSettingsIpc<
  Sender,
  Event extends { sender: Sender },
  Operation extends {
    readonly workspace: { readonly workspaceId: string; readonly rootPath: string };
    assertCurrent(): void;
  },
>(dependencies: {
  stateDir(): string;
  setCachedPreferredName(preferredName: string | undefined, agentName: string | undefined): void;
  applyZoomLevelToWindows(zoomLevel: number): void;
  // The theme the OS draws dohc's menus, dialogs, and window background in.
  applyThemeMode(themeMode: ThemeMode): void;
  setSpellCheckerEnabled(enabled: boolean): void;
  refreshDispatchTray(): Promise<unknown>;
  openDispatchWorkspaces(): readonly { workspaceId: string }[];
  chatDispatchService: { scanWorkspace(workspaceId: string): Promise<unknown> };
  notifyRenderer(scope: { workspaceId: string }): void;
  // Tells every window the settings changed. The writer already has the
  // result; the other surfaces learn it here.
  broadcastAgentColor(event: AgentColorChangedEvent): void;
  broadcastUserSettings(result: DesktopUserSettingsResult): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, message: string,
    work: (operation: Operation) => Result | Promise<Result>,
  ): Promise<Result>;
  // The system's own opener; answers an error message, or "" when it opened.
  openPath(path: string): Promise<string>;
  // The workspaces dohc knows, so pins for any other workspace leave the file.
  knownWorkspaceIds(): readonly string[];
}) {
  const {
    stateDir,
    setCachedPreferredName, applyZoomLevelToWindows, applyThemeMode, setSpellCheckerEnabled, refreshDispatchTray,
    openDispatchWorkspaces, chatDispatchService, withRendererWorkspaceOperation,
    broadcastUserSettings, broadcastAgentColor, notifyRenderer, openPath, knownWorkspaceIds,
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

  // The windows must match whatever zoom level, theme and spellcheck are in
  // the file, however they got there.
  function takeEffect(settings: DesktopUserSettings): void {
    setCachedPreferredName(settings.profile.preferredName, firstAgent(settings)?.name);
    applyZoomLevelToWindows(settings.appearance.zoomLevel);
    applyThemeMode(settings.appearance.themeMode);
    setSpellCheckerEnabled(settings.editor.spellcheck);
  }

  async function announce({ previous, result }: UserSettingsChange): Promise<void> {
    for (const event of agentColorChanges(previous.settings.appearance.agentColors, result.settings.appearance.agentColors)) {
      broadcastAgentColor(event);
    }
    const publicResult = rendererUserSettingsResult(result);
    if (settingsDeepEqual(rendererUserSettingsResult(previous), publicResult)) return;
    broadcastUserSettings(publicResult);
    await refreshDispatchTray();
    const agent = firstAgentWithLaunch(result.settings);
    if (!agent?.enabled) return;
    // A scan finds messages that wait for the agent. Only a change to the
    // agent that answers can make one due, so a zoom step does not scan
    // every open workspace.
    if (settingsDeepEqual(firstAgentWithLaunch(previous.settings), agent)) return;
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
    write: () => Promise<StoredUserSettingsResult | null>,
  ): Promise<UserSettingsChange | null> {
    const change = await enqueueUserSettingsWrite(async () => {
      const previous = await readCachedUserSettingsFile(stateDir());
      const written = await write();
      if (!written) return null;
      const result = StoredUserSettingsResult.parse(written);
      if (!settingsDeepEqual(previous, result)) takeEffect(result.settings);
      return { previous, result };
    });
    if (change) await announce(change);
    return change;
  }

  async function saveUserSettings(
    write: () => Promise<StoredUserSettingsResult>,
  ): Promise<DesktopUserSettingsResult> {
    const change = await changeUserSettings(write);
    if (!change) throw new Error("dohc did not save settings.");
    return rendererUserSettingsResult(change.result);
  }

  /**
   * Applies the settings file after a change on disk, as a save applies. On
   * the queue, a save in progress is either already in the file or not
   * started, and dohc's own save reads as no change. Answers the settings in
   * effect afterwards.
   */
  async function reloadUserSettings(): Promise<DesktopUserSettingsResult> {
    const change = await changeUserSettings(() => reloadUserSettingsFile(stateDir()));
    return rendererUserSettingsResult(change?.result ?? await readCachedUserSettingsFile(stateDir()));
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

  const handlers = {
    getUserSettings: async () => {
      return rendererUserSettingsResult(await readCachedUserSettingsFile(stateDir()));
    },

    reloadUserSettings,

    setUserSettings: async (input) => {
      return saveUserSettings(() =>
        writeUserSettingsFile(stateDir(), input.settings, input.base));
    },

    // One pin at a time, applied to the file as it is now, so two quick pins
    // both land.
    setAppPinned: async (input) => {
      return saveUserSettings(() =>
        updateUserSettingsFile(stateDir(), (current) =>
          withAppPinned(current, input, knownWorkspaceIds())));
    },

    setAgentColor: async (input, { operation }) => {
      const key = agentKeyForGroup(input.workspaceId, input.group);
      await saveUserSettings(() => updateUserSettingsFile(stateDir(), current => {
        operation.assertCurrent();
        if ((current.appearance.agentColors?.[key] ?? null) === input.hue) return current;
        const agentColors = { ...current.appearance.agentColors };
        if (input.hue === null) delete agentColors[key];
        else agentColors[key] = input.hue;
        if (!AgentColors.safeParse(agentColors).success) {
          throw new Error("dohc could not save this agent color within the settings limits. Use the default color for this agent.");
        }
        return { ...current, appearance: { ...current.appearance, agentColors } };
      }));
    },

    resetUserSettings: async () => {
      return saveUserSettings(() => replaceUserSettingsFile(stateDir(), DEFAULT_USER_SETTINGS));
    },

    getUserSettingsFilePath: () => {
      return join(stateDir(), USER_SETTINGS_FILE);
    },

    // The file lives in dohc's own folder, outside every workspace, so it
    // opens in the person's editor rather than dohc's: dohc's editor writes
    // only inside a workspace. The watcher applies the save.
    openUserSettingsFile: async () => {
      await openSettingsFile(
        await enqueueUserSettingsWrite(() => ensureUserSettingsFile(stateDir())),
      );
    },

    // `.dohc` is dohc's own folder, which dohc's editor does not write, so
    // this file opens in the person's editor too.
    openWorkspaceSettingsFile: async (input, { event }) => {
      const path = await withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "Workspace settings stopped opening because this window changed workspaces.",
        (operation) => workspaceSettingsPath(operation.workspace.rootPath),
      );
      await openSettingsFile(path);
    },

    getWorkspaceSettings: async (_input, { operation }) =>
      WorkspaceSettingsResult.parse(
        await readWorkspaceSettingsFile(operation.workspace),
      ),

    // A save or reset before the engine prepared .dohc/local is refused with
    // words that say why, and writes nothing. Only on Windows does a read wait
    // for it, and only for an open under way.
    setWorkspaceSettings: async (input, { operation }) =>
      WorkspaceSettingsResult.parse(
        await saveWorkspaceSettingsFile(operation.workspace, input.patch),
      ),

    resetWorkspaceSettings: async (_input, { operation }) =>
      WorkspaceSettingsResult.parse(
        await resetWorkspaceSettingsFile(operation.workspace),
      ),

    // Per-workspace workbench UI state (.dohc/local/ui-state.json). The
    // renderer cannot write .dohc through writeWorkspaceText (reserved path),
    // so this narrow pair is the only writer. Both directions are zod-bounded;
    // a corrupt/foreign on-disk file reads as null ("no saved state"), never
    // an error. A Windows read without the engine's open is refused, and the
    // renderer then saves nothing. A write is refused unless the engine's
    // current open of the workspace prepared .dohc/local.
    getWorkspaceUiState: async (_input, { operation }) => {
      const parsed = GetWorkspaceUiStateResult.safeParse(
        await readUiStateFile(operation.workspace.rootPath),
      );
      return parsed.success ? parsed.data : null;
    },

    setWorkspaceUiState: async (input, { operation }) => writeUiStateFile(operation.workspace, input.state),
  } satisfies OperationHandlers<typeof settingsOperations, Event, Operation>;

  return {
    ...handlers,
    watchUserSettingsFile, stepWindowZoom,
  };
}
