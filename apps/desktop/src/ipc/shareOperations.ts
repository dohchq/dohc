import { z } from "zod";
import {
  AcceptShareHandoffPayload, DismissShareHandoffPayload, ShareHandoffStatus,
  MountSharePayload, MountShareResult, RefreshShareMountsPayload,
  RefreshShareMountsResult, UnmountSharePayload, UnmountShareResult,
  ListShareProposalsPayload, ListShareProposalsResult,
  ReadShareProposalChangesPayload, ReadShareProposalChangesResult,
  ReadShareProposalFileContentPayload, ReadShareProposalFileContentResult,
  SettleShareProposalPayload, SettleShareProposalResult,
  SubmitShareChangesPayload, SubmitShareChangesResult,
  PushShareDirectWritesPayload,
  ListMyShareChangesPayload, ListMyShareChangesResult,
  WithdrawShareChangesPayload, WithdrawShareChangesResult,
  ShareChatChannelPayload, ShareChatChannelResult,
  ListJoinedSharedChannelsPayload, ListJoinedSharedChannelsResult,
  ListChatChannelSharesPayload, ListChatChannelSharesResult,
  JoinSharedChannelPayload, JoinSharedChannelResult,
  LeaveSharedChannelPayload,
  DismissShareSkipsPayload,
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

export const shareProposalOperations = {
  listShareProposals: {
    capabilityId: "share.proposals.list", channel: "desktop:list-share-proposals",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Share changes stopped because this window changed workspaces.",
    payload: ListShareProposalsPayload, result: ListShareProposalsResult,
  },
  readShareProposalChanges: {
    capabilityId: "share.proposal.read", channel: "desktop:read-share-proposal-changes",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Share changes stopped because this window changed workspaces.",
    payload: ReadShareProposalChangesPayload, result: ReadShareProposalChangesResult,
  },
  readShareProposalFileContent: {
    capabilityId: "share.proposal.file.read", channel: "desktop:read-share-proposal-file-content",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Share changes stopped because this window changed workspaces.",
    payload: ReadShareProposalFileContentPayload, result: ReadShareProposalFileContentResult,
  },
  settleShareProposal: {
    capabilityId: "share.proposal.settle", channel: "desktop:settle-share-proposal",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Share changes stopped because this window changed workspaces.",
    payload: SettleShareProposalPayload, result: SettleShareProposalResult,
  },
  submitShareChanges: {
    capabilityId: "share.proposal.submit", channel: "desktop:submit-share-changes",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Share changes stopped because this window changed workspaces.",
    payload: SubmitShareChangesPayload, result: SubmitShareChangesResult,
  },
  pushShareDirectWrites: {
    capabilityId: "share.direct.writes.push", channel: "desktop:push-share-direct-writes",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Share changes stopped because this window changed workspaces.",
    payload: PushShareDirectWritesPayload,
  },
  listMyShareChanges: {
    capabilityId: "share.proposals.sent.list", channel: "desktop:list-my-share-changes",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Share changes stopped because this window changed workspaces.",
    payload: ListMyShareChangesPayload, result: ListMyShareChangesResult,
  },
  withdrawShareChanges: {
    capabilityId: "share.proposal.withdraw", channel: "desktop:withdraw-share-changes",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Share changes stopped because this window changed workspaces.",
    payload: WithdrawShareChangesPayload, result: WithdrawShareChangesResult,
  },
} as const satisfies OperationTable;

export const sharedChannelOperations = {
  shareChatChannel: {
    capabilityId: "group.share", channel: "desktop:share-chat-channel",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: ShareChatChannelPayload, result: ShareChatChannelResult,
  },
  listJoinedSharedChannels: {
    capabilityId: "group.joined.list", channel: "desktop:list-joined-shared-channels",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: ListJoinedSharedChannelsPayload, result: ListJoinedSharedChannelsResult,
  },
  listChatChannelShares: {
    capabilityId: "group.shares.list", channel: "desktop:list-chat-channel-shares",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: ListChatChannelSharesPayload, result: ListChatChannelSharesResult,
  },
  joinSharedChannel: {
    capabilityId: "group.join", channel: "desktop:join-shared-channel",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Joining stopped because this window changed workspaces.",
    payload: JoinSharedChannelPayload, result: JoinSharedChannelResult,
  },
  leaveSharedChannel: {
    capabilityId: "group.leave", channel: "desktop:leave-shared-channel",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Leaving stopped because this window changed workspaces.",
    payload: LeaveSharedChannelPayload,
  },
  dismissShareSkips: {
    capabilityId: "share.skips.dismiss", channel: "desktop:dismiss-share-skips",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Share warning update stopped because this window changed workspaces.",
    payload: DismissShareSkipsPayload,
  },
} as const satisfies OperationTable;
