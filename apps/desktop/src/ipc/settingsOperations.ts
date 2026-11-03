import { z } from "zod";
import {
  SetAgentColorPayload, DesktopUserSettingsResult, OrderAgentsPayload, SetAppPinnedPayload, SetUserSettingsPayload,
  WorkspaceSettingsPayload, SetWorkspaceSettingsPayload, WorkspaceSettingsResult,
  WorkspaceIdPayload, GetWorkspaceUiStateResult, SetWorkspaceUiStatePayload,
} from "./bridgeContract";
import type { OperationTable } from "./operationTable";

export const settingsOperations = {
  getUserSettings: {
    capabilityId: "settings.user.read", channel: "desktop:get-user-settings",
    scope: "device", guard: "trusted-sender",
    payload: z.void(), result: DesktopUserSettingsResult,
  },
  reloadUserSettings: {
    capabilityId: "settings.user.reload", channel: "desktop:reload-user-settings",
    scope: "device", guard: "trusted-sender",
    payload: z.void(), result: DesktopUserSettingsResult,
  },
  setUserSettings: {
    capabilityId: "settings.user.write", channel: "desktop:set-user-settings",
    scope: "device", guard: "trusted-sender",
    payload: SetUserSettingsPayload, result: DesktopUserSettingsResult,
  },
  // Its workspaceId selects a pin in the device's user settings, not workspace access.
  setAppPinned: {
    capabilityId: "app.pin.set", channel: "desktop:set-app-pinned",
    scope: "device", guard: "trusted-sender",
    payload: SetAppPinnedPayload, result: DesktopUserSettingsResult,
  },
  orderAgents: {
    capabilityId: "settings.agents.order", channel: "desktop:order-agents",
    scope: "device", guard: "trusted-sender",
    payload: OrderAgentsPayload, result: DesktopUserSettingsResult,
  },
  setAgentColor: {
    capabilityId: "agent.color.set", channel: "desktop:set-agent-color",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Agent color save stopped because this window changed workspaces.",
    payload: SetAgentColorPayload,
  },
  resetUserSettings: {
    capabilityId: "settings.user.reset", channel: "desktop:reset-user-settings",
    scope: "device", guard: "trusted-sender",
    payload: z.void(), result: DesktopUserSettingsResult,
  },
  getUserSettingsFilePath: {
    capabilityId: "settings.user.path.read", channel: "desktop:get-user-settings-file-path",
    scope: "device", guard: "trusted-sender",
    payload: z.void(), result: z.string(),
  },
  openUserSettingsFile: {
    capabilityId: "settings.user.file.open", channel: "desktop:open-user-settings-file",
    scope: "device", guard: "trusted-sender",
    payload: z.void(),
  },
  openWorkspaceSettingsFile: {
    capabilityId: "settings.workspace.file.open", channel: "desktop:open-workspace-settings-file",
    scope: "workspace", guard: "trusted-sender",
    handlerCheck: {
      check: "withRendererWorkspaceOperation",
      reason: "Only path resolution holds the workspace operation; the system editor opens after it ends.",
    },
    payload: WorkspaceSettingsPayload,
  },
  getWorkspaceSettings: {
    capabilityId: "settings.workspace.read", channel: "desktop:get-workspace-settings",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Workspace settings read stopped because this window changed workspaces.",
    payload: WorkspaceSettingsPayload, result: WorkspaceSettingsResult,
  },
  setWorkspaceSettings: {
    capabilityId: "settings.workspace.write", channel: "desktop:set-workspace-settings",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Workspace settings save stopped because this window changed workspaces.",
    payload: SetWorkspaceSettingsPayload, result: WorkspaceSettingsResult,
  },
  resetWorkspaceSettings: {
    capabilityId: "settings.workspace.reset", channel: "desktop:reset-workspace-settings",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Workspace settings reset stopped because this window changed workspaces.",
    payload: WorkspaceSettingsPayload, result: WorkspaceSettingsResult,
  },
  getWorkspaceUiState: {
    capabilityId: "workspace.ui.read", channel: "desktop:get-workspace-ui-state",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "UI state read stopped because this window changed workspaces.",
    payload: WorkspaceIdPayload, result: GetWorkspaceUiStateResult,
  },
  setWorkspaceUiState: {
    capabilityId: "workspace.ui.write", channel: "desktop:set-workspace-ui-state",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "UI state write stopped because this window changed workspaces.",
    payload: SetWorkspaceUiStatePayload,
  },
} satisfies OperationTable;
