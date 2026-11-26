import { z } from "zod";
import {
  WorkspaceSecretName,
  WorkspaceSecretsState,
  WorkspaceSecretWriteInput,
} from "@dohc/workspace-contracts/workspace-secrets";
import type { OperationTable } from "./operationTable";

const WorkspaceSecretWorkspace = z.object({ workspaceId: z.string().min(1).max(256) }).strict();

export const workspaceSecretsOperations = {
  listWorkspaceSecrets: {
    capabilityId: "workspace.secrets.list",
    scope: "workspace",
    handlerCheck: {
      check: "workspaceSecretsHandlers.currentRendererSession",
      reason: "The sender must show this workspace; relay calls run without a workspace lease.",
    },
    channel: "desktop:list-workspace-secrets",
    payload: WorkspaceSecretWorkspace,
    result: WorkspaceSecretsState,
    guard: "trusted-sender",
  },
  setWorkspaceSecret: {
    capabilityId: "workspace.secrets.set",
    scope: "workspace",
    handlerCheck: {
      check: "workspaceSecretsHandlers.currentRendererSession",
      reason: "The sender must show this workspace; relay calls run without a workspace lease.",
    },
    channel: "desktop:set-workspace-secret",
    payload: WorkspaceSecretWorkspace.extend({ secret: WorkspaceSecretWriteInput }),
    result: WorkspaceSecretsState,
    guard: "trusted-sender",
  },
  deleteWorkspaceSecret: {
    capabilityId: "workspace.secrets.delete",
    scope: "workspace",
    handlerCheck: {
      check: "workspaceSecretsHandlers.currentRendererSession",
      reason: "The sender must show this workspace; relay calls run without a workspace lease.",
    },
    channel: "desktop:delete-workspace-secret",
    payload: WorkspaceSecretWorkspace.extend({ name: WorkspaceSecretName }),
    result: WorkspaceSecretsState,
    guard: "trusted-sender",
  },
  clearLocalWorkspaceSecrets: {
    capabilityId: "workspace.secrets.delete",
    scope: "workspace",
    handlerCheck: {
      check: "workspaceSecretsHandlers.currentRendererSession",
      reason: "The sender must show this workspace; the vault is this computer's copy.",
    },
    channel: "desktop:clear-local-workspace-secrets",
    payload: WorkspaceSecretWorkspace,
    result: WorkspaceSecretsState,
    guard: "trusted-sender",
  },
} as const satisfies OperationTable;
