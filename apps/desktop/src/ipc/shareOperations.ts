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
  ListOwnerLiveDocumentsPayload, OwnerLiveDocumentsResult,
  ListOwnerLiveRefusalsPayload, OwnerLiveRefusalsResult,
  OwnerLiveDocumentActionPayload, StopOwnerLiveDocumentPayload, StopOwnerLiveDocumentResult, RetryOwnerLiveQuarantinePayload,
  SaveOwnerLiveRecoveryCopyPayload, SaveOwnerLiveRecoveryCopyResult,
  ListRelaySharesResult, GetRelayReceivedSharePayload, GetRelayReceivedShareResult,
  RevokeRelaySharePayload, RevokeRelayShareResult, UndoRelaySharePayload, UndoRelayShareResult,
  PollRelayShareDiscussionActivityPayload, PollRelayShareDiscussionActivityResult,
  CancelRelayShareDiscussionActivityPayload,
  RetryOwnerLiveSharePayload,
  CreateRelaySharePayload, CreateRelayShareResult,
  CreateRelayShareLinkPayload, CreateRelayShareLinkResult,
  AddRelayShareLinkPayload, AddRelayShareLinkResult,
  ListRelayShareLinksPayload, ListRelayShareLinksResult,
  RetuneRelayShareLinkPayload, RetuneRelayShareLinkResult,
  RotateRelayShareLinkPayload, RotateRelayShareLinkResult,
  RevokeRelayShareLinkPayload, RevokeRelayShareLinkResult,
  ListRelayShareDiscussionPayload, ListRelayShareDiscussionResult,
  AppendRelayShareDiscussionPayload, AppendRelayShareDiscussionResult,
  DeleteRelayShareDiscussionMessagePayload, DeleteRelayShareDiscussionMessageResult,
  BlockRelayShareDiscussionPrincipalPayload, BlockRelayShareDiscussionPrincipalResult,
  UnblockRelayShareDiscussionPrincipalPayload, UnblockRelayShareDiscussionPrincipalResult,
  PauseRelayShareDiscussionPayload, PauseRelayShareDiscussionResult,
  ResumeRelayShareDiscussionPayload, ResumeRelayShareDiscussionResult,
  PromoteRelayShareGrantPayload, PromoteRelayShareGrantResult,
  RevokeRelayShareGrantPayload, RevokeRelayShareGrantResult,
} from "./bridgeContract";
import type { OperationTable } from "./operationTable";
import { OwnerRestoreRequest, OwnerRestoreActionResponse } from "./ownerRestoreContract";

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

export const relayShareOperations = {
  ownerRestore: {
    capabilityId: "share.live.restore", channel: "desktop:owner-restore",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: OwnerRestoreRequest, result: z.union([
      OwnerRestoreActionResponse.options, OwnerRestoreActionResponse.plan,
      OwnerRestoreActionResponse.begin, OwnerRestoreActionResponse.prepare,
      OwnerRestoreActionResponse.review, OwnerRestoreActionResponse.confirm,
      OwnerRestoreActionResponse.decline, OwnerRestoreActionResponse.unfinished,
    ]),
  },
  listOwnerLiveDocuments: {
    capabilityId: "share.live.documents.list", channel: "desktop:list-owner-live-documents",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: ListOwnerLiveDocumentsPayload, result: OwnerLiveDocumentsResult,
  },
  listOwnerLiveRefusals: {
    capabilityId: "share.live.refusals.list", channel: "desktop:list-owner-live-refusals",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: ListOwnerLiveRefusalsPayload, result: OwnerLiveRefusalsResult,
  },
  retryOwnerLiveShare: {
    capabilityId: "share.live.retry", channel: "desktop:retry-owner-live-share",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: RetryOwnerLiveSharePayload,
  },
  stopOwnerLiveDocument: {
    capabilityId: "share.live.document.stop", channel: "desktop:stop-owner-live-document",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Live editing stopped because this window changed workspaces.",
    payload: StopOwnerLiveDocumentPayload, result: StopOwnerLiveDocumentResult,
  },
  resumeOwnerLiveDocument: {
    capabilityId: "share.live.document.resume", channel: "desktop:resume-owner-live-document",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Live editing stopped because this window changed workspaces.",
    payload: OwnerLiveDocumentActionPayload,
  },
  // The owner's Try again for one document whose edits the server refused.
  retryOwnerLiveQuarantine: {
    capabilityId: "share.live.document.retry", channel: "desktop:retry-owner-live-quarantine",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Live editing stopped because this window changed workspaces.",
    payload: RetryOwnerLiveQuarantinePayload,
  },
  // Writes a document's kept edits next to its file. The edits stay queued.
  saveOwnerLiveRecoveryCopy: {
    capabilityId: "share.live.document.recovery.save", channel: "desktop:save-owner-live-recovery-copy",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Save recovery copy stopped because this window changed workspaces.",
    payload: SaveOwnerLiveRecoveryCopyPayload, result: SaveOwnerLiveRecoveryCopyResult,
  },
  createRelayShare: {
    capabilityId: "share.create", channel: "desktop:create-relay-share",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: CreateRelaySharePayload, result: CreateRelayShareResult,
  },
  listRelayShares: {
    capabilityId: "share.list", channel: "desktop:list-relay-shares",
    scope: "device", guard: "trusted-sender",
    payload: z.void(), result: ListRelaySharesResult,
  },
  getRelayReceivedShare: {
    capabilityId: "share.received.read", channel: "desktop:get-relay-received-share",
    scope: "device", guard: "trusted-sender",
    payload: GetRelayReceivedSharePayload, result: GetRelayReceivedShareResult,
  },
  revokeRelayShare: {
    capabilityId: "share.revoke", channel: "desktop:revoke-relay-share",
    scope: "device", guard: "trusted-sender",
    payload: RevokeRelaySharePayload, result: RevokeRelayShareResult,
  },
  undoRelayShare: {
    capabilityId: "share.revoke.undo", channel: "desktop:undo-relay-share",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: UndoRelaySharePayload, result: UndoRelayShareResult,
  },
  createRelayShareLink: {
    capabilityId: "share.link.create", channel: "desktop:create-relay-share-link",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: CreateRelayShareLinkPayload, result: CreateRelayShareLinkResult,
  },
  addRelayShareLink: {
    capabilityId: "share.link.add", channel: "desktop:add-relay-share-link",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: AddRelayShareLinkPayload, result: AddRelayShareLinkResult,
  },
  listRelayShareLinks: {
    capabilityId: "share.links.list", channel: "desktop:list-relay-share-links",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: ListRelayShareLinksPayload, result: ListRelayShareLinksResult,
  },
  retuneRelayShareLink: {
    capabilityId: "share.link.access.set", channel: "desktop:retune-relay-share-link",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: RetuneRelayShareLinkPayload, result: RetuneRelayShareLinkResult,
  },
  rotateRelayShareLink: {
    capabilityId: "share.link.rotate", channel: "desktop:rotate-relay-share-link",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: RotateRelayShareLinkPayload, result: RotateRelayShareLinkResult,
  },
  revokeRelayShareLink: {
    capabilityId: "share.link.revoke", channel: "desktop:revoke-relay-share-link",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: RevokeRelayShareLinkPayload, result: RevokeRelayShareLinkResult,
  },
  listRelayShareDiscussion: {
    capabilityId: "share.discussion.read", channel: "desktop:list-relay-share-discussion",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: ListRelayShareDiscussionPayload, result: ListRelayShareDiscussionResult,
  },
  pollRelayShareDiscussionActivity: {
    capabilityId: "share.discussion.activity.wait", channel: "desktop:poll-relay-share-discussion-activity",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: PollRelayShareDiscussionActivityPayload, result: PollRelayShareDiscussionActivityResult,
  },
  cancelRelayShareDiscussionActivity: {
    capabilityId: "share.discussion.activity.cancel", channel: "desktop:cancel-relay-share-discussion-activity",
    scope: "device", guard: "trusted-sender",
    payload: CancelRelayShareDiscussionActivityPayload,
  },
  appendRelayShareDiscussion: {
    capabilityId: "share.discussion.post", channel: "desktop:append-relay-share-discussion",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: AppendRelayShareDiscussionPayload, result: AppendRelayShareDiscussionResult,
  },
  deleteRelayShareDiscussionMessage: {
    capabilityId: "share.discussion.message.delete", channel: "desktop:delete-relay-share-discussion-message",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: DeleteRelayShareDiscussionMessagePayload, result: DeleteRelayShareDiscussionMessageResult,
  },
  blockRelayShareDiscussionPrincipal: {
    capabilityId: "share.discussion.principal.block", channel: "desktop:block-relay-share-discussion-principal",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: BlockRelayShareDiscussionPrincipalPayload, result: BlockRelayShareDiscussionPrincipalResult,
  },
  unblockRelayShareDiscussionPrincipal: {
    capabilityId: "share.discussion.principal.unblock", channel: "desktop:unblock-relay-share-discussion-principal",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: UnblockRelayShareDiscussionPrincipalPayload, result: UnblockRelayShareDiscussionPrincipalResult,
  },
  pauseRelayShareDiscussion: {
    capabilityId: "share.discussion.pause", channel: "desktop:pause-relay-share-discussion",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: PauseRelayShareDiscussionPayload, result: PauseRelayShareDiscussionResult,
  },
  resumeRelayShareDiscussion: {
    capabilityId: "share.discussion.resume", channel: "desktop:resume-relay-share-discussion",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: ResumeRelayShareDiscussionPayload, result: ResumeRelayShareDiscussionResult,
  },
  promoteRelayShareGrant: {
    capabilityId: "share.grant.promote", channel: "desktop:promote-relay-share-grant",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: PromoteRelayShareGrantPayload, result: PromoteRelayShareGrantResult,
  },
  revokeRelayShareGrant: {
    capabilityId: "share.grant.revoke", channel: "desktop:revoke-relay-share-grant",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Sharing stopped because this window changed workspaces.",
    payload: RevokeRelayShareGrantPayload, result: RevokeRelayShareGrantResult,
  },
} as const satisfies OperationTable;
