import { configuredRunnerCommand } from "../agents/agentToolCatalog";
import {
  DesktopUserSettingsResult, SetUserSettingsPayload, WorkspaceSettingsPayload,
  SetWorkspaceSettingsPayload, WorkspaceSettingsResult, WorkspaceIdPayload,
  GetWorkspaceUiStateResult, SetWorkspaceUiStatePayload,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import { readCachedUserSettingsFile, writeUserSettingsFile } from "../settings/userSettingsStore";
import { readWorkspaceSettingsFile, saveWorkspaceSettingsFile, resetWorkspaceSettingsFile } from "../workspaces/workspaceSettingsFile";
import { readUiStateFile, writeUiStateFile } from "../workspaces/workspaceUiState";
import type { createUserSettingsWriteQueue } from "../window/windowZoom";

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
  // Tells every window the settings changed. The writer already has the
  // result; the other surfaces learn it here.
  broadcastUserSettings(result: DesktopUserSettingsResult): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, message: string,
    work: (operation: Operation) => Result | Promise<Result>,
  ): Promise<Result>;
}) {
  const {
    registerHandler, assertTrustedSender, stateDir, enqueueUserSettingsWrite,
    setCachedPreferredName, applyZoomLevelToWindows, refreshDispatchTray,
    openDispatchWorkspaces, chatDispatchService, withRendererWorkspaceOperation,
    broadcastUserSettings,
  } = dependencies;

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
      const result = await enqueueUserSettingsWrite(async () => {
        await writeUserSettingsFile(stateDir(), input.settings);
        setCachedPreferredName(input.settings.profile.preferredName, input.settings.profile.agentName);
        // The windows must match whatever zoom level was just persisted, however
        // it got into the saved object.
        applyZoomLevelToWindows(input.settings.appearance.zoomLevel);
        return DesktopUserSettingsResult.parse({
          settings: input.settings,
          source: "stored",
        });
      });
      broadcastUserSettings(result);
      await refreshDispatchTray();
      if (input.settings.runner.enabled && configuredRunnerCommand(input.settings.runner)) {
        for (const workspace of openDispatchWorkspaces()) {
          void chatDispatchService.scanWorkspace(workspace.workspaceId).catch((error) => {
            console.error("[desktop] runner-settings dispatch scan:", error);
          });
        }
      }
      return result;
    });

    registerHandler(CHANNELS.resetUserSettings, async (event) => {
      assertTrustedSender(event);
      const result = await enqueueUserSettingsWrite(async () => {
        await writeUserSettingsFile(stateDir(), DEFAULT_USER_SETTINGS);
        setCachedPreferredName(undefined, undefined);
        applyZoomLevelToWindows(DEFAULT_USER_SETTINGS.appearance.zoomLevel);
        return DesktopUserSettingsResult.parse({
          settings: DEFAULT_USER_SETTINGS,
          source: "stored",
        });
      });
      broadcastUserSettings(result);
      await refreshDispatchTray();
      return result;
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

  return { registerSettingsIpcHandlers, registerWorkspaceUiStateIpcHandlers };
}
