import { z } from "zod";
import {
  AcceptShareHandoffPayload, DismissShareHandoffPayload, ShareHandoffStatus,
  MountSharePayload, MountShareResult, RefreshShareMountsPayload,
  RefreshShareMountsResult, UnmountSharePayload, UnmountShareResult,
} from "./bridgeContract";
import type { OperationTable } from "./operationTable";

export const shareHandoffOperations = {
  getShareHandoffStatus: {
    capabilityId: "share.handoff.status.read", channel: "desktop:get-share-handoff-status",
    scope: "device", guard: "trusted-sender",
    payload: z.void(), result: ShareHandoffStatus,
  },
  acceptShareHandoff: {
    capabilityId: "share.handoff.accept", channel: "desktop:accept-share-handoff",
    scope: "device", guard: "trusted-sender",
    payload: AcceptShareHandoffPayload,
  },
  retryShareHandoff: {
    capabilityId: "share.handoff.retry", channel: "desktop:retry-share-handoff",
    scope: "device", guard: "trusted-sender",
    payload: z.void(),
  },
  dismissShareHandoff: {
    capabilityId: "share.handoff.dismiss", channel: "desktop:dismiss-share-handoff",
    scope: "device", guard: "trusted-sender",
    payload: DismissShareHandoffPayload,
  },
} as const satisfies OperationTable;

export const shareMountOperations = {
  mountShare: {
    capabilityId: "share.mount.add", channel: "desktop:mount-share",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Share update stopped because this window changed workspaces.",
    payload: MountSharePayload, result: MountShareResult,
  },
  refreshShareMounts: {
    capabilityId: "share.mounts.refresh", channel: "desktop:refresh-share-mounts",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Share update stopped because this window changed workspaces.",
    payload: RefreshShareMountsPayload, result: RefreshShareMountsResult,
  },
  unmountShare: {
    capabilityId: "share.mount.remove", channel: "desktop:unmount-share",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Share update stopped because this window changed workspaces.",
    payload: UnmountSharePayload, result: UnmountShareResult,
  },
} as const satisfies OperationTable;
