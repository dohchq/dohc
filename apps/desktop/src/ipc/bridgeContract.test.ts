import { MAX_SHARE_PROPOSAL_OPS } from "@dohc/security-contract/share-proposal-bound";
import { describe, expect, it } from "vitest";
import {
  ENGINE_YDOC_UPDATE_MAX_BYTES,
  EXPLORER_MENU_COMMANDS,
  MENU_COMMANDS,
  WORKBENCH_MENU_COMMANDS,
} from "./channels";
import { UPDATE_STATUSES } from "../updates/updateMachine";
import { DEFAULT_DRIVER_ID_MAX_LENGTH } from "@dohc/workspace-contracts/workspace-settings-values";
import { DohcPluginManifest } from "../plugins/pluginManifestSchema";
import { pluginViewId } from "../renderer/workbench/workbenchState";
import {
  ListChatChannelsResult,
  ListPersonalChatFeedResult,
  ListChatFileMentionsResult,
  ChatChannelRecord,
  ChatAttachmentRecord,
  ChatBookmarkRecord,
  ChatFileReferenceInput,
  ChannelThreadRecord,
  ChatRunRecordsForThreadResult,
  ChatDispatchStateForThreadPayload,
  ChatDispatchStateForThreadResult,
  ChatReactionRecord,
  DatabaseEditResult,
  DatabasePageResult,
  DatabaseSnapshotResult,
  GetCollectionResult,
  QueryCollectionRecordsPayload,
  QueryCollectionRecordsResult,
  CollectionRecordSchema,
  COLLECTION_VALUE_MAX_DEPTH,
  DesktopMarksResult,
  CreateWorkspaceFilePayload,
  CreateFileChatPayload,
  CreateWorkspaceVersionPayload,
  EngineMomentDetailRecord,
  ApplyEngineYDocUpdatePayload,
  ApplyEngineYDocUpdateResult,
  AcknowledgeEngineYDocLineageReplacementResult,
  OpenEngineYDocSessionResult,
  OpenWorkspaceRequestPayload,
  ReloadRendererRequestPayload,
  ReadWorkspaceDatabasePagePayload,
  ReadEngineYDocArtifactAssetResult,
  ExportDocumentFilePayload,
  ExportDocumentFileResult,
  InvokePluginPanelSdkPayload,
  PluginPanelSdkEvent,
  ListEngineMomentsPayload,
  ListEngineMomentsResult,
  WorkspaceSummary,
  ListFileChatsPayload,
  PRESENCE_STATE_MAX_BYTES,
  SDK_PARAMS_MAX_BYTES,
  SDK_PARAMS_MAX_DEPTH,
  SDK_PARAMS_MAX_VALUES,
  PresencePublishPayload,
  PresencePublishRequestPayload,
  presenceStateWithinCap,
  RestoreEngineMomentFileResult,
  RunnerSelfTestPayload,
  RunnerSelfTestResult,
  StopAgentRunPayload,
  ResumeThreadDispatchPayload,
  SendChatMessagePayload,
  SendChatMessageResult,
  SetChatReactionPayload,
  ShowWorkbenchMenuPayload,
  AcceptDmPayload,
  DeclineDmPayload,
  RequestDmAgainPayload,
  StartDmPayload,
  SyncDmsResult,
  SyncStatusResult,
  engineStoreRefusalCopy,
  engineStoreRefusalRecovery,
  ListWorkspaceVersionsResult,
  ResolveWorkspaceVersionConflictPayload,
  SwitchWorkspaceVersionPayload,
  TryInVersionRunState,
  TryInVersionStateResult,
  AgentPanelSnapshotResult,
  TryInWorkspaceVersionPayload,
  GetWorkspaceUiStateResult,
  WorkspaceUiState,
  WorkspaceGraphResult,
  WorkspaceVersionConflict,
  ListSitesResult,
  GetSitePreviewLogsPayload,
  GetSitePreviewLogsResult,
  StartSitePreviewPayload,
  StartSitePreviewResult,
  StopSitePreviewPayload,
  SetUserSettingsPayload,
  SetWorkspaceSettingsPayload,
  OpenPluginPanelPayload,
  OpenPluginPanelResult,
  PluginPanelOpenedEvent,
  PluginPanelInvalidatedEvent,
  StartPluginPanelPayload,
  StartPluginPanelResult,
  StopPluginPanelPayload,
  UpdateActionResult,
  UpdateCheckResult,
  UpdateStateEvent,
  EngineYDocRemoteUpdateEvent,
  EngineYDocSaveStateEvent,
  ExplorerMenuCommand,
  isSafeRelativePath,
  MenuCommand,
  SearchResultsEvent,
  WorkbenchMenuCommand,
  WriteClipboardTextPayload,
  ReadWorkspaceTextResult,
  WriteWorkspaceTextPayload,
  WriteWorkspaceTextResult,
  parseInvokePluginPanelSdkPayloadForIpc,
  parsePluginPanelInvalidatedEventForIpc,
  parsePluginPanelSdkEventForIpc,
  CloudJoinWorkspacePayload,
  AddRelayShareLinkPayload,
  AddRelayShareLinkResult,
  AppendRelayShareDiscussionPayload,
  AppendRelayShareDiscussionResult,
  BlockRelayShareDiscussionPrincipalPayload,
  BlockRelayShareDiscussionPrincipalResult,
  CancelRelayShareDiscussionActivityPayload,
  CreateRelayShareLinkPayload,
  CreateRelayShareLinkResult,
  DeleteRelayShareDiscussionMessagePayload,
  DeleteRelayShareDiscussionMessageResult,
  ListRelayShareDiscussionPayload,
  ListRelayShareDiscussionResult,
  ListRelayShareLinksPayload,
  ListRelayShareLinksResult,
  PauseRelayShareDiscussionPayload,
  PauseRelayShareDiscussionResult,
  PollRelayShareDiscussionActivityPayload,
  PollRelayShareDiscussionActivityResult,
  PromoteRelayShareGrantPayload,
  PromoteRelayShareGrantResult,
  RelayShareDiscussionAppendResponse,
  RelayShareDiscussionActivityResponse,
  RelayShareDiscussionBlockResponse,
  RelayShareDiscussionDeleteResponse,
  RelayShareDiscussionPageResponse,
  RelayShareDiscussionPauseResponse,
  RelayShareGrantPromotionResponse,
  RelayShareGrantRevokeResponse,
  ResumeRelayShareDiscussionPayload,
  ResumeRelayShareDiscussionResult,
  RevokeRelayShareGrantPayload,
  RevokeRelayShareGrantResult,
  RotateRelayShareLinkPayload,
  RotateRelayShareLinkResult,
  RevokeRelayShareLinkPayload,
  RevokeRelayShareLinkResult,
  RetuneRelayShareLinkPayload,
  RetuneRelayShareLinkResult,
  UnblockRelayShareDiscussionPrincipalPayload,
  UnblockRelayShareDiscussionPrincipalResult,
  ReadShareProposalFileContentPayload,
  ReadShareProposalFileContentResult,
  ListShareProposalsPayload,
  ListShareProposalsResult,
  ListMyShareChangesPayload,
  ListMyShareChangesResult,
  GetRelayReceivedSharePayload,
  GetRelayReceivedShareResult,
  ListRelaySharesResult,
  RelayShareGrantedRow,
  RelayShareReceivedRow,
  RelayShareSelector,
  ReadShareProposalChangesResult,
  RefreshSharedViewResult,
  SettleShareProposalPayload,
  SubmitShareChangesPayload,
  SubmitShareChangesResult,
  resolveSubmitShareChangesResult,
  WithdrawShareChangesPayload,
  WithdrawShareChangesResult,
} from "./bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import {
  CHATS_TAB_PATH,
  MAX_EDITOR_GROUPS,
  MAX_EDITOR_GROUP_ID_CHARS,
  pluginPanelTabPath,
  siteTabPath,
} from "../renderer/workbench/workbenchState";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { WORKSPACE_TEXT_EDITOR_MAX_BYTES } from "../workspaces/workspaceTextLimits";

describe("owner relay share link IPC contract", () => {
  const readable = {
    shareId: "share-1",
    grantId: "grant-1",
    selector: { paths: ["docs"], versionId: null },
    access: "view" as const,
    generation: 2,
    status: "active" as const,
    createdAtMs: 10,
    revokedAtMs: null,
    lastUsedAtMs: 20,
    urlIssuedAtMs: 15,
    dependents: [
      {
        grantId: "dependent-1",
        recipientUserId: "user-1",
        recipientEmail: "reader@example.test",
        access: "view" as const,
        generation: 1,
        createdAtMs: 12,
      },
    ],
  };
  const damaged = {
    ...readable,
    shareId: "share-2",
    grantId: "grant-2",
    selector: null,
    access: "damaged-access",
    damaged: true as const,
    status: "revoked" as const,
    revokedAtMs: 30,
    lastUsedAtMs: null,
    urlIssuedAtMs: null,
    dependents: [],
  };

  it("parses readable and damaged inventory rows while stripping bearer fields", () => {
    const parsed = ListRelayShareLinksResult.parse({
      ok: true,
      nextCursor: "next-page",
      nextIndependentGrantCursor: "next-grant-page",
      links: [
        {
          ...readable,
          url: "https://share.example.test/s/#must-not-cross",
          secret: "must-not-cross",
          credential: { token: "must-not-cross" },
        },
        {
          ...damaged,
          selectorKind: "chat-channel",
          url: "https://share.example.test/s/#must-not-cross",
          secret: "must-not-cross",
          credentialId: "must-not-cross",
        },
      ],
      supportedLinkAccess: ["view", "comment"],
      independentGrants: [
        {
          shareId: "share-1",
          grantId: "independent-1",
          recipientUserId: "user-1",
          recipientEmail: "reader@example.test",
        },
      ],
    });

    expect(parsed).toEqual({
      links: [readable, damaged],
      supportedLinkAccess: ["view", "comment"],
      independentGrants: [
        {
          shareId: "share-1",
          grantId: "independent-1",
          recipientUserId: "user-1",
          recipientEmail: "reader@example.test",
        },
      ],
      nextCursor: "next-page",
      nextIndependentGrantCursor: "next-grant-page",
    });
    for (const row of parsed.links) {
      expect(row).not.toHaveProperty("url");
      expect(row).not.toHaveProperty("secret");
      expect(row).not.toHaveProperty("credential");
      expect(row).not.toHaveProperty("credentialId");
    }
    expect(
      ListRelayShareLinksPayload.parse({
        workspaceId: "workspace-1",
        cursor: "next-page",
        independentGrantCursor: "next-grant-page",
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      cursor: "next-page",
      independentGrantCursor: "next-grant-page",
    });
    expect(
      ListRelayShareLinksPayload.safeParse({
        workspaceId: "workspace-1",
        cursor: "x".repeat(1_025),
      }).success,
    ).toBe(false);
    expect(
      ListRelayShareLinksResult.safeParse({
        links: Array.from({ length: 1_001 }, () => readable),
        supportedLinkAccess: ["view", "comment"],
        independentGrants: [],
      }).success,
    ).toBe(false);
    expect(
      ListRelayShareLinksResult.safeParse({
        links: [],
        supportedLinkAccess: ["view", "comment"],
        independentGrants: [],
        nextCursor: "x".repeat(1_025),
      }).success,
    ).toBe(false);
    expect(
      ListRelayShareLinksResult.safeParse({
        links: [],
        supportedLinkAccess: ["view", "comment"],
        independentGrants: [],
        nextIndependentGrantCursor: "x".repeat(1_025),
      }).success,
    ).toBe(false);
    expect(
      ListRelayShareLinksResult.safeParse({
        links: [],
        supportedLinkAccess: ["view", "comment"],
        independentGrants: [
          {
            shareId: "share-1",
            grantId: "independent-1",
            recipientUserId: "user-1",
            recipientEmail: "reader@example.test",
            secret: "must-not-cross",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires an explicit access level and excludes Edit on pinned versions", () => {
    expect(
      CreateRelayShareLinkPayload.safeParse({
        workspaceId: "workspace-1",
        paths: ["docs"],
        access: "view",
      }).success,
    ).toBe(true);
    expect(
      CreateRelayShareLinkPayload.safeParse({
        workspaceId: "workspace-1",
        versionId: "version-1",
        access: "comment",
      }).success,
    ).toBe(true);
    for (const payload of [
      { workspaceId: "workspace-1" },
      { workspaceId: "workspace-1", paths: ["docs"] },
      {
        workspaceId: "workspace-1",
        paths: ["docs"],
        versionId: "version-1",
        access: "view",
      },
      { workspaceId: "workspace-1", versionId: "version-1", access: "edit" },
      {
        workspaceId: "workspace-1",
        paths: ["docs"],
        access: "view",
        ownerUserId: "must-not-cross",
      },
    ]) {
      expect(CreateRelayShareLinkPayload.safeParse(payload).success).toBe(false);
    }
  });

  it("adds a link only to one real share with an explicit public level", () => {
    for (const access of ["view", "comment", "edit"] as const) {
      const payload = {
        workspaceId: "workspace-1",
        shareId: "share-1",
        access,
      };
      expect(AddRelayShareLinkPayload.parse(payload)).toEqual(payload);
    }
    for (const payload of [
      { workspaceId: "workspace-1", shareId: "share-1" },
      { workspaceId: "workspace-1", shareId: "share-1", access: "invalid" },
      {
        workspaceId: "workspace-1",
        shareId: "share-1",
        access: "view",
        paths: ["docs"],
      },
      {
        workspaceId: "workspace-1",
        shareId: "share-1",
        access: "comment",
        versionId: "version-1",
      },
    ]) {
      expect(AddRelayShareLinkPayload.safeParse(payload).success).toBe(false);
    }
  });

  it("retunes one displayed link with the exact dependent set", () => {
    const payload = {
      workspaceId: "workspace-1",
      shareId: "share-1",
      grantId: "grant-1",
      access: "comment" as const,
      expectedDependentGrantIds: ["dependent-1"],
    };
    expect(RetuneRelayShareLinkPayload.parse(payload)).toEqual(payload);
    for (const invalid of [
      { ...payload, access: "invalid" },
      { ...payload, access: undefined },
      { ...payload, expectedDependentGrantIds: undefined },
      { ...payload, expectedDependentGrantIds: "dependent-1" },
      { ...payload, selector: { paths: ["docs"], versionId: null } },
      { ...payload, principalUserId: "must-not-cross" },
    ]) {
      expect(RetuneRelayShareLinkPayload.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires the exact expected-dependent array for reset and end", () => {
    const payload = {
      workspaceId: "workspace-1",
      shareId: "share-1",
      grantId: "grant-1",
      expectedDependentGrantIds: [],
    };
    expect(RotateRelayShareLinkPayload.parse(payload)).toEqual(payload);
    expect(RevokeRelayShareLinkPayload.parse(payload)).toEqual(payload);
    for (const schema of [RotateRelayShareLinkPayload, RevokeRelayShareLinkPayload]) {
      expect(
        schema.safeParse({
          workspaceId: "workspace-1",
          shareId: "share-1",
          grantId: "grant-1",
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...payload, expectedDependentGrantIds: "grant-2" })
          .success,
      ).toBe(false);
      expect(schema.safeParse({ ...payload, access: "view" }).success).toBe(false);
    }
  });

  it("discriminates lifecycle outcomes and rejects malformed projections", () => {
    expect(
      RotateRelayShareLinkResult.parse({
        outcome: "rotated",
        url: "https://share.example.test/s/#new-bearer",
      }),
    ).toEqual({
      outcome: "rotated",
      url: "https://share.example.test/s/#new-bearer",
    });
    for (const schema of [
      RotateRelayShareLinkResult,
      RevokeRelayShareLinkResult,
      RetuneRelayShareLinkResult,
    ]) {
      expect(
        schema.parse({ outcome: "dependents-changed", dependents: readable.dependents }),
      ).toEqual({ outcome: "dependents-changed", dependents: readable.dependents });
      expect(
        schema.safeParse({
          outcome: "dependents-changed",
          dependents: [{ ...readable.dependents[0], generation: 0 }],
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          outcome: "dependents-changed",
          dependents: [{ grantId: "dependent-1" }],
        }).success,
      ).toBe(false);
    }
    expect(RevokeRelayShareLinkResult.parse({ outcome: "ended" })).toEqual({
      outcome: "ended",
    });
    expect(
      RetuneRelayShareLinkResult.parse({
        outcome: "widened",
        url: "https://share.example.test/s/#new-bearer",
      }),
    ).toEqual({
      outcome: "widened",
      url: "https://share.example.test/s/#new-bearer",
    });
    expect(RetuneRelayShareLinkResult.parse({ outcome: "narrowed" })).toEqual({
      outcome: "narrowed",
    });
    for (const malformed of [
      { outcome: "widened" },
      { outcome: "widened", url: "https://share.example.test/s/#new", access: "comment" },
      { outcome: "narrowed", url: "https://share.example.test/s/#must-not-cross" },
      { outcome: "narrowed", dependents: [] },
      { outcome: "dependents-changed", dependents: [], url: "https://share.example.test/s/#must-not-cross" },
    ]) {
      expect(RetuneRelayShareLinkResult.safeParse(malformed).success).toBe(false);
    }
  });

  it("allows a URL only on create, add, reset, and widening", () => {
    for (const schema of [CreateRelayShareLinkResult, AddRelayShareLinkResult]) {
      expect(
        schema.parse({
          shareId: "share-1",
          grantId: "grant-1",
          url: "https://share.example.test/s/#new-bearer",
          secret: "stripped",
        }),
      ).toEqual({
        shareId: "share-1",
        grantId: "grant-1",
        url: "https://share.example.test/s/#new-bearer",
      });
    }
    expect(
      RevokeRelayShareLinkResult.safeParse({
        outcome: "ended",
        url: "https://share.example.test/s/#must-not-cross",
      }).success,
    ).toBe(false);
    expect(
      RotateRelayShareLinkResult.safeParse({
        outcome: "dependents-changed",
        dependents: [],
        url: "https://share.example.test/s/#must-not-cross",
      }).success,
    ).toBe(false);
    expect(
      RetuneRelayShareLinkResult.safeParse({
        outcome: "narrowed",
        url: "https://share.example.test/s/#must-not-cross",
      }).success,
    ).toBe(false);
  });
});

describe("owner relay share discussion IPC contract", () => {
  const namedAuthor = { kind: "named" as const, displayName: "Owner Name" };
  const linkAuthor = {
    kind: "link" as const,
    displayName: "Visitor Name",
    unverified: true as const,
  };
  const moderation = {
    linkGrantId: "link-grant-1",
    linkPrincipalId: "principal-1",
    blocked: false,
  };
  const namedLive = {
    messageId: "message-1",
    createdAtMs: 10,
    deleted: false as const,
    body: "Named message",
    author: namedAuthor,
  };
  const linkLive = {
    messageId: "message-2",
    createdAtMs: 11,
    deleted: false as const,
    body: "Link message",
    author: linkAuthor,
    moderation,
  };
  const namedDeleted = {
    messageId: "message-3",
    createdAtMs: 12,
    deleted: true as const,
    author: namedAuthor,
  };
  const linkDeleted = {
    messageId: "message-4",
    createdAtMs: 13,
    deleted: true as const,
    author: linkAuthor,
    moderation: { ...moderation, blocked: true },
  };

  it("accepts only the closed owner page and message projections", () => {
    const result = {
      activityRevision: 7,
      linkCommentsPaused: true,
      messages: [namedLive, linkLive, namedDeleted, linkDeleted],
      nextCursor: "eyJ2ZXJzaW9uIjoxfQ",
    };
    expect(ListRelayShareDiscussionResult.parse(result)).toEqual(result);
    expect(
      ListRelayShareDiscussionResult.parse({
        activityRevision: 0,
        linkCommentsPaused: false,
        messages: [],
        nextCursor: null,
      }),
    ).toEqual({
      activityRevision: 0,
      linkCommentsPaused: false,
      messages: [],
      nextCursor: null,
    });
    expect(RelayShareDiscussionPageResponse.parse({ ok: true, ...result })).toEqual({
      ok: true,
      ...result,
    });
    expect(
      RelayShareDiscussionPageResponse.safeParse({
        ok: true,
        ...result,
        credential: "must-not-cross",
      }).success,
    ).toBe(false);
    expect(
      ListRelayShareDiscussionResult.safeParse({ ok: true, ...result }).success,
    ).toBe(false);

    for (const malformed of [
      { ...result, ownerUserId: "must-not-cross" },
      { ...result, activityRevision: -1 },
      { ...result, activityRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...result, nextCursor: "not+base64" },
      { ...result, nextCursor: "x".repeat(1_025) },
      { ...result, messages: Array.from({ length: 101 }, () => namedLive) },
      { ...result, messages: [{ ...namedLive, moderation }] },
      { ...result, messages: [{ ...linkLive, moderation: undefined }] },
      { ...result, messages: [{ ...linkLive, author: namedAuthor }] },
      { ...result, messages: [{ ...linkDeleted, body: "must-not-cross" }] },
      { ...result, messages: [{ ...namedDeleted, authorUserId: "must-not-cross" }] },
      { ...result, messages: [{ ...linkLive, moderation: { ...moderation, blocked: null } }] },
      { ...result, messages: [{ ...linkLive, author: { ...linkAuthor, unverified: false } }] },
      { ...result, messages: [{ ...namedLive, body: "" }] },
      {
        ...result,
        messages: [
          { ...namedLive, author: { ...namedAuthor, displayName: "x".repeat(513) } },
        ],
      },
      { ...result, messages: [{ ...namedLive, messageId: "x".repeat(513) }] },
    ]) {
      expect(ListRelayShareDiscussionResult.safeParse(malformed).success).toBe(false);
    }
  });

  it("bounds the opaque list cursor and exact append payload before main", () => {
    expect(
      ListRelayShareDiscussionPayload.parse({
        workspaceId: "workspace-1",
        shareId: "share-1",
        direction: "newest-first",
        cursor: "cursor_1",
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      shareId: "share-1",
      direction: "newest-first",
      cursor: "cursor_1",
    });
    expect(
      ListRelayShareDiscussionPayload.parse({
        workspaceId: "workspace-1",
        shareId: "share-1",
        direction: "newest-first",
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      shareId: "share-1",
      direction: "newest-first",
    });
    for (const malformed of [
      { workspaceId: "workspace-1", shareId: "share-1" },
      {
        workspaceId: "workspace-1",
        shareId: "share-1",
        direction: "oldest-first",
      },
      {
        workspaceId: "workspace-1",
        shareId: "share-1",
        direction: "newest-first",
        cursor: "",
      },
      {
        workspaceId: "workspace-1",
        shareId: "share-1",
        direction: "newest-first",
        cursor: "bad+cursor",
      },
      {
        workspaceId: "workspace-1",
        shareId: "share-1",
        direction: "newest-first",
        cursor: "cursor_1",
        limit: 100,
      },
    ]) {
      expect(ListRelayShareDiscussionPayload.safeParse(malformed).success).toBe(false);
    }

    const exact = {
      workspaceId: "workspace-1",
      shareId: "share-1",
      body: "e\u0301",
      idempotencyKey: "~".repeat(64),
    };
    expect(AppendRelayShareDiscussionPayload.parse(exact)).toEqual(exact);
    expect(
      AppendRelayShareDiscussionPayload.safeParse({
        ...exact,
        body: "\u1100\u1161\u11a8".repeat(889),
      }).success,
    ).toBe(false);
    for (const malformed of [
      { ...exact, body: "\u0000hello" },
      { ...exact, body: "hello\u0000world" },
      { ...exact, idempotencyKey: "" },
      { ...exact, idempotencyKey: "x".repeat(65) },
      { ...exact, idempotencyKey: "line\nbreak" },
      { ...exact, idempotencyKey: "non-ascii-é" },
      { ...exact, actorUserId: "must-not-cross" },
      { ...exact, displayName: "must-not-cross" },
      { ...exact, author: namedAuthor },
      { ...exact, grantId: "must-not-cross" },
      { ...exact, profile: { id: "must-not-cross" } },
    ]) {
      expect(AppendRelayShareDiscussionPayload.safeParse(malformed).success).toBe(false);
    }
  });

  it("closes and bounds owner discussion activity polls and responses", () => {
    const poll = {
      workspaceId: "workspace-1",
      shareId: "share-1",
      since: 7,
      hold: 30_000,
      limit: 100,
      pollId: "2cdeeb8f-f0ba-4d72-bd4a-b8f3f279ea18",
    };
    expect(PollRelayShareDiscussionActivityPayload.parse(poll)).toEqual(poll);
    expect(
      CancelRelayShareDiscussionActivityPayload.parse({ pollId: poll.pollId }),
    ).toEqual({ pollId: poll.pollId });

    for (const malformed of [
      { ...poll, since: -1 },
      { ...poll, since: Number.MAX_SAFE_INTEGER + 1 },
      { ...poll, hold: 30_001 },
      { ...poll, limit: 101 },
      { ...poll, pollId: "not-a-uuid" },
      { ...poll, cursor: "must-not-cross" },
    ]) {
      expect(PollRelayShareDiscussionActivityPayload.safeParse(malformed).success).toBe(
        false,
      );
    }
    expect(
      CancelRelayShareDiscussionActivityPayload.safeParse({
        pollId: poll.pollId,
        workspaceId: "must-not-cross",
      }).success,
    ).toBe(false);

    const activity = {
      latestRevision: 11,
      cursorRevision: 9,
      hasMore: true,
      messages: [linkLive, namedDeleted],
      principals: [{ principalId: "principal-1", blocked: true }],
      linkCommentsPaused: true,
    };
    expect(PollRelayShareDiscussionActivityResult.parse(activity)).toEqual(activity);
    expect(
      RelayShareDiscussionActivityResponse.parse({ ok: true, ...activity }),
    ).toEqual({ ok: true, ...activity });

    const malformedActivity = [
      { ...activity, latestRevision: -1 },
      { ...activity, latestRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...activity, cursorRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...activity, cursorRevision: 12 },
      { ...activity, cursorRevision: 10, hasMore: false },
      { ...activity, cursorRevision: 11, latestRevision: 11, hasMore: true },
      {
        ...activity,
        principals: [{ linkPrincipalId: "wrong-field", blocked: true }],
      },
      {
        ...activity,
        principals: [{ principalId: "principal-1", blocked: true, userId: "leak" }],
      },
      { ...activity, messages: Array.from({ length: 101 }, () => namedLive) },
      { ...activity, credential: "must-not-cross" },
    ];
    for (const malformed of malformedActivity) {
      for (const parsed of [
        PollRelayShareDiscussionActivityResult.safeParse(malformed),
        RelayShareDiscussionActivityResponse.safeParse({
          ok: true,
          ...malformed,
        }),
      ]) {
        expect(parsed.success).toBe(false);
      }
    }
  });

  it("parses only an appended owner message without relay sentinels", () => {
    expect(AppendRelayShareDiscussionResult.parse({ message: linkLive })).toEqual({
      message: linkLive,
    });
    expect(
      RelayShareDiscussionAppendResponse.parse({ ok: true, message: namedLive }),
    ).toEqual({ ok: true, message: namedLive });
    expect(
      RelayShareDiscussionAppendResponse.safeParse({
        ok: true,
        message: namedLive,
        requestHash: "must-not-cross",
      }).success,
    ).toBe(false);
    for (const malformed of [
      { message: namedLive, ok: true },
      { message: { ...namedLive, credential: "must-not-cross" } },
      { message: namedLive, actor: { userId: "must-not-cross" } },
    ]) {
      expect(AppendRelayShareDiscussionResult.safeParse(malformed).success).toBe(false);
    }
  });

  it("keeps each finalized moderation action and result exact", () => {
    const target = { workspaceId: "workspace-1", shareId: "share-1" };
    expect(
      DeleteRelayShareDiscussionMessagePayload.parse({
        ...target,
        messageId: "message-1",
      }),
    ).toEqual({ ...target, messageId: "message-1" });
    expect(
      BlockRelayShareDiscussionPrincipalPayload.parse({
        ...target,
        principalId: "principal-1",
      }),
    ).toEqual({ ...target, principalId: "principal-1" });
    expect(
      UnblockRelayShareDiscussionPrincipalPayload.parse({
        ...target,
        principalId: "principal-1",
      }),
    ).toEqual({ ...target, principalId: "principal-1" });
    expect(PauseRelayShareDiscussionPayload.parse(target)).toEqual(target);
    expect(ResumeRelayShareDiscussionPayload.parse(target)).toEqual(target);

    for (const [schema, malformed] of [
      [DeleteRelayShareDiscussionMessagePayload, { ...target, messageId: "" }],
      [
        DeleteRelayShareDiscussionMessagePayload,
        { ...target, messageId: "message-1", principalId: "principal-1" },
      ],
      [BlockRelayShareDiscussionPrincipalPayload, { ...target, principalId: "" }],
      [
        UnblockRelayShareDiscussionPrincipalPayload,
        { ...target, principalId: "principal-1", actorUserId: "must-not-cross" },
      ],
      [PauseRelayShareDiscussionPayload, { ...target, action: "pause" }],
      [ResumeRelayShareDiscussionPayload, { ...target, capability: "must-not-cross" }],
    ] as const) {
      expect(schema.safeParse(malformed).success).toBe(false);
    }

    const tombstone = { messageId: "message-1", createdAtMs: 10, deleted: true as const };
    expect(DeleteRelayShareDiscussionMessageResult.parse({ message: tombstone })).toEqual({
      message: tombstone,
    });
    expect(RelayShareDiscussionDeleteResponse.parse({ ok: true, message: tombstone })).toEqual({
      ok: true,
      message: tombstone,
    });
    expect(
      RelayShareDiscussionDeleteResponse.safeParse({
        ok: true,
        message: tombstone,
        deletedByUserId: "must-not-cross",
      }).success,
    ).toBe(false);
    expect(BlockRelayShareDiscussionPrincipalResult.parse({ blocked: true })).toEqual({
      blocked: true,
    });
    expect(UnblockRelayShareDiscussionPrincipalResult.parse({ blocked: false })).toEqual({
      blocked: false,
    });
    expect(RelayShareDiscussionBlockResponse.parse({ ok: true, blocked: true })).toEqual({
      ok: true,
      blocked: true,
    });
    expect(
      RelayShareDiscussionBlockResponse.safeParse({
        ok: true,
        blocked: true,
        principalId: "must-not-cross",
      }).success,
    ).toBe(false);
    expect(PauseRelayShareDiscussionResult.parse({ linkCommentsPaused: true })).toEqual({
      linkCommentsPaused: true,
    });
    expect(ResumeRelayShareDiscussionResult.parse({ linkCommentsPaused: false })).toEqual({
      linkCommentsPaused: false,
    });
    expect(
      RelayShareDiscussionPauseResponse.parse({
        ok: true,
        linkCommentsPaused: false,
      }),
    ).toEqual({ ok: true, linkCommentsPaused: false });
    expect(
      RelayShareDiscussionPauseResponse.safeParse({
        ok: true,
        linkCommentsPaused: false,
        shareId: "must-not-cross",
      }).success,
    ).toBe(false);

    for (const [schema, malformed] of [
      [DeleteRelayShareDiscussionMessageResult, { message: { ...tombstone, body: "secret" } }],
      [BlockRelayShareDiscussionPrincipalResult, { blocked: true, ok: true }],
      [UnblockRelayShareDiscussionPrincipalResult, { blocked: "false" }],
      [PauseRelayShareDiscussionResult, { linkCommentsPaused: true, shareId: "share-1" }],
      [ResumeRelayShareDiscussionResult, { linkCommentsPaused: null }],
    ] as const) {
      expect(schema.safeParse(malformed).success).toBe(false);
    }
  });

  it("pins promotion and direct named revoke to closed permanent transitions", () => {
    const promotion = {
      workspaceId: "workspace-1",
      shareId: "share-1",
      grantId: "named-grant-1",
      expectedParentGrantId: "link-grant-1",
      expectedParentGeneration: 2,
    };
    expect(PromoteRelayShareGrantPayload.parse(promotion)).toEqual(promotion);
    const revoke = {
      workspaceId: "workspace-1",
      shareId: "share-1",
      grantId: "named-grant-1",
    };
    expect(RevokeRelayShareGrantPayload.parse(revoke)).toEqual(revoke);
    for (const malformed of [
      { ...promotion, expectedParentGeneration: 0 },
      { ...promotion, expectedDependentGrantIds: [] },
      { ...promotion, recipientUserId: "must-not-cross" },
      { ...revoke, workspaceBody: "must-not-cross" },
      { ...revoke, dependentGrantIds: [] },
      { ...revoke, actor: { id: "must-not-cross" } },
    ]) {
      const schema = "expectedParentGrantId" in malformed
        ? PromoteRelayShareGrantPayload
        : RevokeRelayShareGrantPayload;
      expect(schema.safeParse(malformed).success).toBe(false);
    }

    const promoted = {
      grantId: "named-grant-1",
      access: "comment" as const,
      generation: 2,
      status: "active" as const,
      revokedAtMs: null,
      parentGrantId: null,
    };
    const revoked = {
      ...promoted,
      generation: 3,
      status: "revoked" as const,
      revokedAtMs: 20,
    };
    expect(PromoteRelayShareGrantResult.parse(promoted)).toEqual(promoted);
    expect(RevokeRelayShareGrantResult.parse(revoked)).toEqual(revoked);
    expect(RelayShareGrantPromotionResponse.parse({ ok: true, ...promoted })).toEqual({
      ok: true,
      ...promoted,
    });
    expect(RelayShareGrantRevokeResponse.parse({ ok: true, ...revoked })).toEqual({
      ok: true,
      ...revoked,
    });
    expect(
      RelayShareGrantPromotionResponse.safeParse({
        ok: true,
        ...promoted,
        recipientUserId: "must-not-cross",
      }).success,
    ).toBe(false);
    expect(
      RelayShareGrantRevokeResponse.safeParse({
        ok: true,
        ...revoked,
        credential: "must-not-cross",
      }).success,
    ).toBe(false);
    for (const [schema, malformed] of [
      [PromoteRelayShareGrantResult, { ...promoted, ok: true }],
      [PromoteRelayShareGrantResult, { ...promoted, status: "revoked" }],
      [PromoteRelayShareGrantResult, { ...promoted, access: "owner" }],
      [PromoteRelayShareGrantResult, { ...promoted, parentGrantId: "link-grant-1" }],
      [RevokeRelayShareGrantResult, { ...revoked, revokedAtMs: null }],
      [RevokeRelayShareGrantResult, { ...revoked, url: "https://must-not-cross.test" }],
      [RevokeRelayShareGrantResult, { ...revoked, principalUserId: "must-not-cross" }],
    ] as const) {
      expect(schema.safeParse(malformed).success).toBe(false);
    }
  });
});

describe("relay share listing IPC contract", () => {
  const selector = { paths: ["docs"], versionId: null };
  const grant = { access: "edit" as const, grantId: "grant-1", generation: 2 };

  it("keeps stored selector scope separate from grant fields", () => {
    expect(RelayShareSelector.parse(selector)).toEqual(selector);
    expect(
      ListRelaySharesResult.parse({
        granted: [
          {
            shareId: "share-1",
            workspaceId: "remote-1",
            recipientUserId: "recipient-1",
            recipientEmail: "recipient@example.test",
            selector,
            ...grant,
            createdAtMs: 1,
            revokedAtMs: null,
            shareCode: "dohc-share:share-1:https://relay.test",
          },
        ],
        received: [
          {
            shareId: "share-2",
            granterEmail: "owner@example.test",
            genericChatWritable: true,
            selector,
            ...grant,
            createdAtMs: 1,
            shareCode: "dohc-share:share-2:https://relay.test",
          },
        ],
      }),
    ).toMatchObject({
      granted: [{ selector, ...grant }],
      received: [{ selector, ...grant }],
    });
  });

  it("keeps the 1,000-row inventory caps", () => {
    const received = Array.from({ length: 1_000 }, (_, index) => ({
      shareId: `share-received-${index}`,
      granterEmail: "owner@example.test",
      genericChatWritable: true,
      selector,
      ...grant,
      createdAtMs: 1,
      shareCode: `dohc-share:share-received-${index}:https://relay.test`,
    }));
    const granted = Array.from({ length: 1_000 }, (_, index) => ({
      shareId: `share-granted-${index}`,
      workspaceId: "remote-1",
      recipientUserId: "recipient-1",
      recipientEmail: "recipient@example.test",
      selector,
      ...grant,
      createdAtMs: 1,
      revokedAtMs: null,
      shareCode: `dohc-share:share-granted-${index}:https://relay.test`,
    }));

    expect(ListRelaySharesResult.safeParse({ granted, received }).success).toBe(
      true,
    );
    expect(
      ListRelaySharesResult.safeParse({
        granted: [...granted, granted[0]],
        received,
      }).success,
    ).toBe(false);
    expect(
      ListRelaySharesResult.safeParse({
        granted,
        received: [...received, received[0]],
      }).success,
    ).toBe(false);
  });

  it("keeps a damaged row listable when its raw access belongs to another selector kind", () => {
    expect(
      ListRelaySharesResult.parse({
        granted: [
          {
            shareId: "share-damaged-granted",
            workspaceId: "remote-1",
            recipientUserId: "recipient-1",
            recipientEmail: "recipient@example.test",
            selector: null,
            access: "read-write",
            grantId: "grant-damaged-granted",
            generation: 1,
            damaged: true,
            createdAtMs: 1,
            revokedAtMs: null,
            shareCode: "dohc-share:share-damaged-granted:https://relay.test",
          },
        ],
        received: [
          {
            shareId: "share-damaged-received",
            granterEmail: "owner@example.test",
            genericChatWritable: false,
            selector: null,
            access: "read-write",
            grantId: "grant-damaged-received",
            generation: 1,
            damaged: true,
            createdAtMs: 1,
            shareCode: "dohc-share:share-damaged-received:https://relay.test",
          },
        ],
      }),
    ).toMatchObject({
      granted: [{ selector: null, access: "read-write", damaged: true }],
      received: [{ selector: null, access: "read-write", damaged: true }],
    });
  });

  it("refuses chat access on readable path rows and bounds damaged raw access", () => {
    const granted = {
      shareId: "share-1",
      workspaceId: "remote-1",
      recipientUserId: "recipient-1",
      recipientEmail: "recipient@example.test",
      selector,
      access: "read-write",
      grantId: "grant-1",
      generation: 1,
      createdAtMs: 1,
      revokedAtMs: null,
      shareCode: "dohc-share:share-1:https://relay.test",
    };
    const received = {
      shareId: "share-2",
      granterEmail: "owner@example.test",
      genericChatWritable: false,
      selector,
      access: "read-write",
      grantId: "grant-2",
      generation: 1,
      createdAtMs: 1,
      shareCode: "dohc-share:share-2:https://relay.test",
    };

    expect(RelayShareGrantedRow.safeParse(granted).success).toBe(false);
    expect(RelayShareReceivedRow.safeParse(received).success).toBe(false);
    expect(
      RelayShareGrantedRow.safeParse({
        ...granted,
        selector: null,
        damaged: true,
        access: "x".repeat(65),
      }).success,
    ).toBe(false);
    expect(
      RelayShareReceivedRow.safeParse({
        ...received,
        selector: null,
        damaged: true,
        access: "x".repeat(65),
      }).success,
    ).toBe(false);
  });

  it("refuses the retired nested-access listing shape and incomplete grant fields", () => {
    const oldSelector = { ...selector, access: "edit" };
    const granted = {
      shareId: "share-1",
      workspaceId: "remote-1",
      recipientUserId: "recipient-1",
      recipientEmail: "recipient@example.test",
      selector: oldSelector,
      createdAtMs: 1,
      revokedAtMs: null,
      shareCode: "dohc-share:share-1:https://relay.test",
    };
    const received = {
      shareId: "share-2",
      granterEmail: "owner@example.test",
      selector: oldSelector,
      createdAtMs: 1,
      shareCode: "dohc-share:share-2:https://relay.test",
    };

    expect(RelayShareGrantedRow.safeParse(granted).success).toBe(false);
    expect(RelayShareReceivedRow.safeParse(received).success).toBe(false);
    expect(RelayShareGrantedRow.safeParse({ ...granted, ...grant, generation: 0 }).success).toBe(
      false,
    );
  });
});

describe("exact received relay share IPC contract", () => {
  const received = {
    shareId: "share-exact",
    granterEmail: "owner@example.test",
    genericChatWritable: true,
    grantId: "grant-exact",
    generation: 1,
    createdAtMs: 1,
    shareCode: "dohc-share:share-exact:https://relay.test",
    selector: { paths: ["docs"], versionId: null },
    access: "view" as const,
  };

  it("accepts one strict share id and an explicit missing result", () => {
    expect(
      GetRelayReceivedSharePayload.parse({ shareId: "share-exact" }),
    ).toEqual({ shareId: "share-exact" });
    expect(GetRelayReceivedShareResult.parse({ found: false })).toEqual({
      found: false,
    });

    for (const payload of [
      undefined,
      {},
      { shareId: "" },
      { shareId: "x".repeat(201) },
      { shareId: "share-exact", relayUrl: "https://attacker.test" },
    ]) {
      expect(GetRelayReceivedSharePayload.safeParse(payload).success).toBe(false);
    }
    expect(
      GetRelayReceivedShareResult.safeParse({
        found: false,
        share: received,
      }).success,
    ).toBe(false);
  });

  it("returns only the existing received-share schema", () => {
    const parsed = GetRelayReceivedShareResult.parse({
      found: true,
      share: {
        ...received,
        workspaceId: "forbidden-owner-workspace",
        recipientUserId: "forbidden-recipient-user",
        recipientEmail: "forbidden-recipient@example.test",
        url: "https://share.example.test/s/#forbidden-link",
      },
    });

    expect(parsed).toEqual({ found: true, share: received });
    expect(
      GetRelayReceivedShareResult.safeParse({
        found: true,
        share: { ...received, shareCode: undefined },
      }).success,
    ).toBe(false);
    expect(
      GetRelayReceivedShareResult.safeParse({
        found: true,
        share: { ...received, genericChatWritable: undefined },
      }).success,
    ).toBe(false);
    expect(
      GetRelayReceivedShareResult.safeParse({
        found: true,
        share: { ...received, genericChatWritable: "yes" },
      }).success,
    ).toBe(false);
  });
});

describe("shared view refresh IPC contract", () => {
  it("preserves pull exclusions and unjournalable paths independently", () => {
    expect(
      RefreshSharedViewResult.parse({
        ok: true,
        status: "unchanged",
        changedPaths: 0,
        excludedPaths: ["docs/pull-excluded.md"],
        unjournalablePaths: [
          { path: "docs/oversized.md", reason: "oversized-text" },
          { path: "docs/local.md", reason: "local-collision" },
        ],
        refusedOps: 0,
        refusedDetail: null,
      }),
    ).toEqual({
      ok: true,
      status: "unchanged",
      changedPaths: 0,
      excludedPaths: ["docs/pull-excluded.md"],
      unjournalablePaths: [
        { path: "docs/oversized.md", reason: "oversized-text" },
        { path: "docs/local.md", reason: "local-collision" },
      ],
      refusedOps: 0,
      refusedDetail: null,
    });
  });

  it("carries changed paths when the pull fails after local repair", () => {
    expect(
      RefreshSharedViewResult.parse({
        ok: false,
        changedPaths: 2,
        errorMessage: "relay failed",
      }),
    ).toEqual({
      ok: false,
      changedPaths: 2,
      errorMessage: "relay failed",
    });
  });
});

describe("workbench menu IPC contract", () => {
  it("carries a bounded editor group ID and the group-close capability", () => {
    const payload = {
      workspaceId: "workspace-1",
      context: "tab" as const,
      path: "notes/a.md",
    };

    expect(
      ShowWorkbenchMenuPayload.parse({
        ...payload,
        groupId: "primary",
        canCloseEditorGroup: true,
      }),
    ).toEqual({ ...payload, groupId: "primary", canCloseEditorGroup: true });
    expect(ShowWorkbenchMenuPayload.parse(payload)).toEqual(payload);
    expect(
      ShowWorkbenchMenuPayload.safeParse({ ...payload, groupId: "" }).success,
    ).toBe(false);
    expect(
      ShowWorkbenchMenuPayload.safeParse({
        ...payload,
        groupId: "g".repeat(MAX_EDITOR_GROUP_ID_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      ShowWorkbenchMenuPayload.safeParse({
        ...payload,
        groupId: "g".repeat(MAX_EDITOR_GROUP_ID_CHARS),
      }).success,
    ).toBe(true);
  });
});

describe("workspace text IPC contract", () => {
  const hash = "a".repeat(64);

  it("bounds new and existing file writes by exact UTF-8 bytes", () => {
    const exact = "\ud83d\udca1".repeat(WORKSPACE_TEXT_EDITOR_MAX_BYTES / 4);
    const over = `${exact}x`;
    const base = {
      workspaceId: "workspace-a",
      relativePath: "notes/a.md",
    };

    expect(
      CreateWorkspaceFilePayload.safeParse({
        ...base,
        initialText: exact,
      }).success,
    ).toBe(true);
    expect(
      WriteWorkspaceTextPayload.safeParse({
        ...base,
        text: exact,
        expectedContentHash: hash,
      }).success,
    ).toBe(true);

    for (const result of [
      CreateWorkspaceFilePayload.safeParse({ ...base, initialText: over }),
      WriteWorkspaceTextPayload.safeParse({
        ...base,
        text: over,
        expectedContentHash: hash,
      }),
    ]) {
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "Workspace text exceeds WORKSPACE_TEXT_EDITOR_MAX_BYTES: " +
            `limit ${WORKSPACE_TEXT_EDITOR_MAX_BYTES} bytes, observed ${WORKSPACE_TEXT_EDITOR_MAX_BYTES + 1} bytes`,
        );
      }
    }
  });

  it("ties complete and truncated reads to an unambiguous content hash", () => {
    expect(
      ReadWorkspaceTextResult.parse({
        text: "complete",
        truncated: false,
        contentHash: hash,
      }),
    ).toEqual({ text: "complete", truncated: false, contentHash: hash });
    expect(
      ReadWorkspaceTextResult.parse({
        text: "partial",
        truncated: true,
        contentHash: null,
      }),
    ).toEqual({ text: "partial", truncated: true, contentHash: null });
    expect(
      ReadWorkspaceTextResult.safeParse({
        text: "complete",
        truncated: false,
        contentHash: null,
      }).success,
    ).toBe(false);
    expect(
      ReadWorkspaceTextResult.safeParse({
        text: "partial",
        truncated: true,
        contentHash: hash,
      }).success,
    ).toBe(false);
  });

  it("requires a lowercase SHA-256 precondition and validates both write outcomes", () => {
    expect(
      WriteWorkspaceTextPayload.parse({
        workspaceId: "workspace-a",
        relativePath: "notes/a.md",
        text: "next",
        expectedContentHash: hash,
      }).expectedContentHash,
    ).toBe(hash);
    expect(
      WriteWorkspaceTextPayload.safeParse({
        workspaceId: "workspace-a",
        relativePath: "notes/a.md",
        text: "next",
      }).success,
    ).toBe(false);
    expect(
      WriteWorkspaceTextPayload.safeParse({
        workspaceId: "workspace-a",
        relativePath: "notes/a.md",
        text: "next",
        expectedContentHash: hash.toUpperCase(),
      }).success,
    ).toBe(false);

    expect(
      WriteWorkspaceTextResult.parse({ status: "written", contentHash: hash }),
    ).toEqual({ status: "written", contentHash: hash });
    expect(
      WriteWorkspaceTextResult.parse({
        status: "conflict",
        currentContentHash: null,
      }),
    ).toEqual({ status: "conflict", currentContentHash: null });
    expect(
      WriteWorkspaceTextResult.parse({
        status: "conflict",
        currentContentHash: hash,
      }),
    ).toEqual({ status: "conflict", currentContentHash: hash });
  });
});

describe("chat IPC contract", () => {
  it("validates DM request lanes and their account/workspace mutations", () => {
    const request = { shareId: "share-1", granterEmail: "sender@example.com" };
    expect(
      SyncDmsResult.parse({
        available: true,
        dms: [],
        pending: [request],
        declined: [{ shareId: "share-2", granterEmail: null }],
        failed: false,
      }),
    ).toMatchObject({ pending: [request], failed: false });
    expect(
      AcceptDmPayload.parse({ workspaceId: "workspace-a", shareId: "share-1" }),
    ).toEqual({ workspaceId: "workspace-a", shareId: "share-1" });
    expect(DeclineDmPayload.parse({ shareId: "share-1" })).toEqual({
      shareId: "share-1",
    });
    expect(RequestDmAgainPayload.parse({ shareId: "share-1" })).toEqual({
      shareId: "share-1",
    });
    expect(SyncDmsResult.safeParse({ available: true, dms: [] }).success).toBe(false);
  });

  it("accepts an opaque shared attachment without local object metadata", () => {
    expect(
      ChatAttachmentRecord.parse({
        attachmentId: "attachment-redacted",
        threadId: "thread-1",
        messageId: "message-1",
        targetKind: "file",
        createdAtMs: 1,
      }),
    ).toEqual({
      attachmentId: "attachment-redacted",
      threadId: "thread-1",
      messageId: "message-1",
      targetKind: "file",
      createdAtMs: 1,
    });
  });

  it("keeps DM file references and stored heading metadata on the same bounds", () => {
    expect(
      StartDmPayload.parse({
        workspaceId: "workspace-a",
        recipients: "bob@example.com",
        body: "Read @[docs/plan.md#scope]",
        fileReferences: [{ path: "docs/plan.md", headingAnchor: "scope" }],
      }).fileReferences,
    ).toEqual([{ path: "docs/plan.md", headingAnchor: "scope" }]);

    const attachment = {
      attachmentId: "attachment-1",
      threadId: "thread-1",
      messageId: "message-1",
      targetKind: "file" as const,
      headingText: "t".repeat(300),
      headingAnchor: "a".repeat(400),
      headingOccurrence: 0,
      createdAtMs: 1,
    };
    expect(ChatAttachmentRecord.safeParse(attachment).success).toBe(true);
    expect(
      ChatAttachmentRecord.safeParse({ ...attachment, headingText: "t".repeat(301) }).success,
    ).toBe(false);
    expect(
      ChatAttachmentRecord.safeParse({ ...attachment, headingAnchor: "a".repeat(401) }).success,
    ).toBe(false);
    expect(
      ChatAttachmentRecord.safeParse({
        ...attachment,
        headingAnchor: undefined,
        headingOccurrence: 0,
      }).success,
    ).toBe(false);
    expect(
      ChatFileReferenceInput.safeParse({
        path: "docs/plan.md",
        headingOccurrence: 0,
      }).success,
    ).toBe(false);
  });

  it("keeps bookmark discriminator ids internally consistent", () => {
    const common = {
      bookmarkId: "bookmark-1",
      mode: "live" as const,
      destinationPath: "Bookmarks/thread.md",
      state: "active" as const,
      projectionState: "ready" as const,
      generation: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    expect(
      ChatBookmarkRecord.safeParse({
        ...common,
        targetKind: "thread",
        targetId: "thread-1",
        threadId: "thread-1",
      }).success,
    ).toBe(true);
    expect(
      ChatBookmarkRecord.safeParse({
        ...common,
        targetKind: "thread",
        targetId: "thread-other",
        threadId: "thread-1",
      }).success,
    ).toBe(false);
    expect(
      ChatBookmarkRecord.safeParse({
        ...common,
        targetKind: "message",
        targetId: "message-1",
        threadId: "thread-1",
        messageId: "message-1",
      }).success,
    ).toBe(true);
    expect(
      ChatBookmarkRecord.safeParse({
        ...common,
        targetKind: "message",
        targetId: "message-1",
        threadId: "thread-1",
      }).success,
    ).toBe(false);
    expect(
      ChatBookmarkRecord.safeParse({
        ...common,
        targetKind: "message",
        targetId: "message-other",
        threadId: "thread-1",
        messageId: "message-1",
      }).success,
    ).toBe(false);
  });

  it("accepts additive channel-feed previews and batched run records", () => {
    expect(
      ChannelThreadRecord.parse({
        id: "thread-1",
        title: "Launch",
        createdAtMs: 1,
        updatedAtMs: 2,
        channelId: "channel-1",
        messageCount: 2,
        lastReadSequence: 1,
        unreadCount: 1,
        openingMessage: {
          id: "message-1",
          authorKind: "agent",
          authorDisplayName: "Sam",
          createdAtMs: 1,
          bodySnippet: "Launch checks are green.",
          reactions: [
            {
              reactionId: "reaction-1",
              messageId: "message-1",
              threadId: "thread-1",
              emoji: "👍",
              authorId: "user-1",
              authorKind: "human",
              authorDisplayName: "Sam",
            },
          ],
        },
      }).openingMessage,
    ).toMatchObject({ id: "message-1", bodySnippet: "Launch checks are green." });

    expect(
      ChatRunRecordsForThreadResult.parse({
        runs: {
          "message-2": {
            runId: "run-1",
            threadId: "thread-1",
            triggerMessageId: "message-1",
            command: "codex exec",
            startedAtMs: 2,
          },
        },
      }).runs["message-2"]?.runId,
    ).toBe("run-1");
  });
});

describe("workspace graph IPC contract", () => {
  const graph = (node: Record<string, unknown>) => ({
    nodes: [node],
    edges: [],
    unresolvedLinks: 0,
    scannedFileCount: 1,
    omittedFileCount: 0,
    truncatedFileCount: 0,
  });
  const common = { path: "node", title: "Node", incoming: 0, outgoing: 0 };

  it("keeps legacy file nodes while requiring navigable metadata for typed nodes", () => {
    expect(WorkspaceGraphResult.safeParse(graph({ ...common, path: "a.md" })).success)
      .toBe(true);
    expect(
      WorkspaceGraphResult.safeParse(
        graph({
          ...common,
          kind: "heading",
          filePath: "a.md",
          headingAnchor: "scope",
        }),
      ).success,
    ).toBe(true);
    expect(
      WorkspaceGraphResult.safeParse(
        graph({ ...common, kind: "chat-thread", threadId: "thread-1" }),
      ).success,
    ).toBe(true);

    expect(
      WorkspaceGraphResult.safeParse(
        graph({ ...common, kind: "heading", filePath: "a.md" }),
      ).success,
    ).toBe(false);
    expect(
      WorkspaceGraphResult.safeParse(graph({ ...common, kind: "chat-thread" })).success,
    ).toBe(false);
    expect(
      WorkspaceGraphResult.safeParse(
        graph({ ...common, path: "a.md", threadId: "thread-on-file" }),
      ).success,
    ).toBe(false);
  });
});

describe("collection IPC contracts", () => {
  it("round-trips a queried record with a bigint value and a flagged validation", () => {
    const result = QueryCollectionRecordsResult.parse({
      collection: { path: "tasks", status: "valid", reasons: [] },
      records: [
        {
          id: "rec-1",
          path: "tasks/one.md",
          conflicted: false,
          values: [
            {
              field: "estimate",
              value: 9223372036854775807n,
              validation: {
                status: "flagged",
                reason: { code: "expected-number", path: "estimate" },
              },
              resolvedRelations: [{ recordId: "rec-2", label: "Other" }],
            },
          ],
        },
      ],
      groups: null,
      nextCursor: null,
    });
    expect(result.records[0]?.values[0]?.value).toBe(9223372036854775807n);
  });

  it("keeps every field kind and view definition through the details result", () => {
    const details = GetCollectionResult.parse({
      path: "tasks",
      status: "degraded",
      reasons: [{ code: "unknown-field-type", path: "fields.mystery" }],
      schema: {
        name: "Tasks",
        description: null,
        fields: [
          { name: "title", type: "text" },
          { name: "status", type: "select", options: ["open", "done"] },
          { name: "blocks", type: "relation", collection: "projects", many: true },
        ],
        views: [
          {
            name: "Board",
            kind: "board",
            groupBy: "status",
            sort: [{ field: "title", direction: "asc" }],
            visibleFields: ["title"],
            dateField: null,
          },
        ],
      },
      recordCount: 3,
    });
    expect(details.schema.fields).toHaveLength(3);
    expect(details.schema.views[0]?.kind).toBe("board");
  });

  it("accepts a collection schema with more than 500 fields", () => {
    const fields = Array.from({ length: 501 }, (_, index) => ({
      name: `field-${index}`,
      type: "text" as const,
    }));

    const details = GetCollectionResult.parse({
      path: "tasks",
      status: "valid",
      reasons: [],
      schema: {
        name: "Tasks",
        description: null,
        fields,
        views: [],
      },
      recordCount: 0,
    });

    expect(details.schema.fields).toHaveLength(501);
  });

  it("accepts more than 1,000 canonical schema reasons", () => {
    const details = GetCollectionResult.parse({
      path: "tasks",
      status: "degraded",
      reasons: Array.from({ length: 1_001 }, (_, index) => ({
        code: "unknown-property",
        path: `/property-${index}`,
      })),
      schema: {
        name: "Tasks",
        description: null,
        fields: [],
        views: [],
      },
      recordCount: 0,
    });

    expect(details.reasons).toHaveLength(1_001);
  });

  it("rejects a query payload outside the contract's bounds", () => {
    const base = { workspaceId: "workspace-1", collectionPath: "tasks" };
    expect(QueryCollectionRecordsPayload.parse(base)).toEqual(base);
    expect(() =>
      QueryCollectionRecordsPayload.parse({ ...base, limit: 0 }),
    ).toThrow();
    expect(() =>
      QueryCollectionRecordsPayload.parse({
        ...base,
        filter: { field: "status", operator: "matches", value: "x" },
      }),
    ).toThrow();
    expect(() =>
      GetCollectionResult.parse({
        path: "tasks",
        status: "valid",
        reasons: [],
        schema: {
          name: null,
          description: null,
          fields: [{ name: "mystery", type: "unknown-kind" }],
          views: [],
        },
        recordCount: 0,
      }),
    ).toThrow();
  });

  it("accepts a record populated up to the shared schema field limit", () => {
    // An agent-authored collection can legally carry more than 1,000 fields;
    // the transport cap follows MAX_SCHEMA_COLLECTION_ITEMS, not a private
    // bound.
    const values = Array.from({ length: 1_500 }, (_, index) => ({
      field: `field_${index}`,
      value: index,
      validation: { status: "valid" },
      resolvedRelations: [],
    }));
    const parsed = CollectionRecordSchema.safeParse({
      id: "rec_abcdefghijklmnopqrstuvwxyz",
      path: "tasks/wide.md",
      conflicted: false,
      values,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects thousands-deep nested values with a validation error, not a stack overflow", () => {
    const base = { workspaceId: "workspace-1", collectionPath: "tasks" };
    const nested = (depth: number): unknown => {
      let value: unknown = "leaf";
      for (let level = 0; level < depth; level += 1) value = [value];
      return value;
    };
    const query = (value: unknown) => ({
      ...base,
      filter: { field: "status", operator: "equals", value },
    });
    const record = (value: unknown) => ({
      id: "rec-1",
      path: "tasks/one.md",
      conflicted: false,
      values: [
        {
          field: "status",
          value,
          validation: { status: "valid" },
          resolvedRelations: [],
        },
      ],
    });

    for (const deep of [nested(COLLECTION_VALUE_MAX_DEPTH + 1), nested(5_000)]) {
      expect(QueryCollectionRecordsPayload.safeParse(query(deep)).success).toBe(false);
      expect(CollectionRecordSchema.safeParse(record(deep)).success).toBe(false);
    }

    const atCap = nested(COLLECTION_VALUE_MAX_DEPTH);
    expect(QueryCollectionRecordsPayload.safeParse(query(atCap)).success).toBe(true);
    expect(CollectionRecordSchema.safeParse(record(atCap)).success).toBe(true);
  });
});

describe("record IPC contracts", () => {
  it("accepts string-keyed records and validates each value", () => {
    expect(
      DatabaseSnapshotResult.parse({
        path: "workspace.db",
        tables: [
          {
            name: "tasks",
            columns: [],
            rows: [{ "task title": "Ship Zod 4", priority: 1, done: false }],
            nextOffset: 1000,
          },
        ],
      }).tables[0]?.rows[0],
    ).toEqual({ "task title": "Ship Zod 4", priority: 1, done: false });

    expect(
      ReadWorkspaceDatabasePagePayload.parse({
        workspaceId: "workspace-1",
        relativePath: "workspace.db",
        table: "tasks",
        offset: 1000,
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      relativePath: "workspace.db",
      table: "tasks",
      offset: 1000,
    });
    expect(
      DatabasePageResult.parse({
        path: "workspace.db",
        table: "tasks",
        offset: 1000,
        rows: [{ "task title": "Keep paging" }],
        nextOffset: null,
      }),
    ).toEqual({
      path: "workspace.db",
      table: "tasks",
      offset: 1000,
      rows: [{ "task title": "Keep paging" }],
      nextOffset: null,
    });
    expect(
      DatabaseEditResult.parse({
        path: "workspace.db",
        table: "tasks",
        page: {
          offset: 0,
          rows: [{ "task title": "Ship the worker" }],
          nextOffset: null,
        },
        version: 2,
      }),
    ).toEqual({
      path: "workspace.db",
      table: "tasks",
      page: {
        offset: 0,
        rows: [{ "task title": "Ship the worker" }],
        nextOffset: null,
      },
      version: 2,
    });

    expect(
      ReadWorkspaceDatabasePagePayload.safeParse({
        workspaceId: "workspace-1",
        relativePath: "workspace.db",
        table: "tasks",
        offset: -1,
      }).success,
    ).toBe(false);

    expect(
      DesktopMarksResult.safeParse({
        marks: { appReady: 100 },
        measures: { startup: "fast" },
      }).success,
    ).toBe(false);
  });
});

describe("settings IPC contract", () => {
  it("accepts bounded user and workspace settings payloads", () => {
    expect(
      SetUserSettingsPayload.parse({ settings: DEFAULT_USER_SETTINGS, base: DEFAULT_USER_SETTINGS }).settings
        .appearance.themeMode,
    ).toBe("system");
    // A save carries only the changed controls: main merges them onto the
    // file, so a whole-settings body is not what this channel takes.
    expect(
      SetWorkspaceSettingsPayload.parse({
        workspaceId: "ws-settings",
        patch: { sites: { defaultPreviewMode: "auto" } },
      }).patch.sites?.defaultPreviewMode,
    ).toBe("auto");
    expect(
      SetWorkspaceSettingsPayload.safeParse({
        workspaceId: "ws-settings",
        settings: DEFAULT_WORKSPACE_SETTINGS,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown settings keys, invalid values, bounds, and oversized strings", () => {
    expect(
      SetUserSettingsPayload.safeParse({
        base: DEFAULT_USER_SETTINGS,
        settings: {
          ...DEFAULT_USER_SETTINGS,
          secretToken: "nope",
        },
      }).success,
    ).toBe(false);
    expect(
      SetUserSettingsPayload.safeParse({
        base: DEFAULT_USER_SETTINGS,
        settings: {
          ...DEFAULT_USER_SETTINGS,
          appearance: {
            ...DEFAULT_USER_SETTINGS.appearance,
            themeMode: "sepia",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      SetUserSettingsPayload.safeParse({
        base: DEFAULT_USER_SETTINGS,
        settings: {
          ...DEFAULT_USER_SETTINGS,
          editor: {
            ...DEFAULT_USER_SETTINGS.editor,
            fontSize: 25,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      SetWorkspaceSettingsPayload.safeParse({
        workspaceId: "WS-settings",
        settings: DEFAULT_WORKSPACE_SETTINGS,
      }).success,
    ).toBe(false);
    expect(
      SetWorkspaceSettingsPayload.safeParse({
        workspaceId: "",
        settings: DEFAULT_WORKSPACE_SETTINGS,
      }).success,
    ).toBe(false);
    expect(
      SetWorkspaceSettingsPayload.safeParse({
        workspaceId: "ws-settings",
        settings: {
          ...DEFAULT_WORKSPACE_SETTINGS,
          agents: {
            ...DEFAULT_WORKSPACE_SETTINGS.agents,
            defaultModel: "x".repeat(201),
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts only a scoped runner self-test request and bounded result", () => {
    expect(RunnerSelfTestPayload.parse({ workspaceId: "ws-settings" })).toEqual({
      workspaceId: "ws-settings",
    });
    expect(
      RunnerSelfTestPayload.safeParse({
        workspaceId: "ws-settings",
        command: "untrusted command",
      }).success,
    ).toBe(false);
    expect(
      RunnerSelfTestResult.parse({ ok: true, detail: "self-test ok" }),
    ).toEqual({ ok: true, detail: "self-test ok" });
    expect(
      RunnerSelfTestResult.safeParse({
        ok: false,
        detail: "Runner timed out.",
        logPath: "/tmp/log",
      }).success,
    ).toBe(false);
    expect(
      RunnerSelfTestResult.safeParse({ ok: false, detail: "" }).success,
    ).toBe(false);
  });

  it("keeps chat-run stop and resume controls workspace scoped", () => {
    expect(
      StopAgentRunPayload.parse({
        workspaceId: "ws-settings",
        runId: "run-1",
      }),
    ).toEqual({ workspaceId: "ws-settings", runId: "run-1" });
    expect(
      StopAgentRunPayload.safeParse({
        workspaceId: "ws-settings",
        pid: 42,
      }).success,
    ).toBe(false);
    expect(
      ResumeThreadDispatchPayload.parse({
        workspaceId: "ws-settings",
        threadId: "thread-1",
      }),
    ).toEqual({ workspaceId: "ws-settings", threadId: "thread-1" });
    expect(
      ResumeThreadDispatchPayload.safeParse({
        workspaceId: "ws-settings",
        threadId: "thread-1",
        paused: false,
      }).success,
    ).toBe(false);
    expect(
      ChatDispatchStateForThreadPayload.parse({
        workspaceId: "ws-settings",
        threadId: "thread-1",
      }),
    ).toEqual({ workspaceId: "ws-settings", threadId: "thread-1" });
    expect(
      ChatDispatchStateForThreadResult.parse({
        liveRunId: "run-1",
        pendingCount: 2,
        paused: false,
      }),
    ).toEqual({ liveRunId: "run-1", pendingCount: 2, paused: false });
    expect(
      ChatDispatchStateForThreadResult.safeParse({
        liveRunId: null,
        pendingCount: -1,
        paused: true,
      }).success,
    ).toBe(false);
  });
});

describe("workspace UI state IPC contract", () => {
  const validState = {
    version: 2,
    activeView: "explorer",
    sidebarVisible: true,
    sidebarWidth: 320,
    editorGroups: [
      {
        id: "primary",
        tabs: ["notes/a.md"],
        activeTab: "notes/a.md",
        size: 1,
      },
    ],
    activeEditorGroup: "primary",
    chatsVisible: true,
  };

  it("drops invalid open editor heights without rejecting the saved state", () => {
    for (const openEditorsHeight of [7, "tall"]) {
      const parsed = WorkspaceUiState.parse({ ...validState, openEditorsHeight });
      const height: number | undefined = parsed.openEditorsHeight;
      expect(height).toBeUndefined();
    }
  });

  it("falls back to Explorer when a saved view no longer exists", () => {
    const parsed = WorkspaceUiState.parse({
      ...validState,
      activeView: "retired-view",
    });
    expect(parsed.activeView).toBe("explorer");
    expect(parsed.editorGroups).toEqual(validState.editorGroups);
  });

  it("carries a plugin-contributed view across the persistence boundary", () => {
    const activeView = pluginViewId("dohc-sites", "sites");
    expect(
      WorkspaceUiState.parse({ ...validState, activeView }).activeView,
    ).toBe(activeView);
  });

  it.each([
    ["a bare prefix", "plugin-view:"],
    ["a missing panel segment", "plugin-view:dohc-sites"],
    ["an over-long id", `plugin-view:${"a".repeat(4096)}/sites`],
    ["a NUL byte in either segment", "plugin-view:%00/%00"],
    [
      "a segment past the plugin id cap",
      `plugin-view:${encodeURIComponent("a".repeat(215))}/sites`,
    ],
    [
      "a segment past the panel id cap",
      `plugin-view:dohc-sites/${encodeURIComponent("a".repeat(121))}`,
    ],
  ])("falls back to Explorer for %s", (_case, activeView) => {
    expect(
      WorkspaceUiState.parse({ ...validState, activeView }).activeView,
    ).toBe("explorer");
  });

  it("rejects the replaced version-1 flat-tab contract", () => {
    expect(
      WorkspaceUiState.safeParse({
        ...validState,
        version: 1,
        tabs: ["notes/a.md"],
        activeTab: "notes/a.md",
      }).success,
    ).toBe(false);
  });

  it("allows a path in several groups while requiring group-local uniqueness", () => {
    expect(
      WorkspaceUiState.safeParse({
        ...validState,
        editorGroups: [
          { ...validState.editorGroups[0], size: 0.5 },
          {
            id: "right",
            tabs: ["notes/a.md"],
            activeTab: "notes/a.md",
            size: 0.5,
          },
        ],
      }).success,
    ).toBe(true);
    const duplicateInGroup = WorkspaceUiState.safeParse({
      ...validState,
      editorGroups: [
        {
          ...validState.editorGroups[0],
          tabs: ["notes/a.md", "notes/a.md"],
        },
      ],
    });
    expect(duplicateInGroup.success).toBe(false);
    if (!duplicateInGroup.success) {
      expect(duplicateInGroup.error.issues.map((issue) => issue.message)).toEqual([
        "Editor group tabs must be unique.",
      ]);
    }
  });

  it("rejects Chats in several editor groups with an exact issue", () => {
    const result = WorkspaceUiState.safeParse({
      ...validState,
      editorGroups: [
        {
          id: "left",
          tabs: [CHATS_TAB_PATH, "notes/a.md"],
          activeTab: CHATS_TAB_PATH,
          size: 0.5,
        },
        {
          id: "right",
          tabs: ["notes/a.md", CHATS_TAB_PATH],
          activeTab: CHATS_TAB_PATH,
          size: 0.5,
        },
      ],
      activeEditorGroup: "left",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["editorGroups", 1, "tabs", 1],
          message: "Each chat can be open in only one editor group.",
        }),
      ]);
    }
  });

  it.each([
    ["site preview", siteTabPath("client-portal"), "dohc://app/%63lient-portal"],
    [
      "plugin panel",
      pluginPanelTabPath("hello-plugin", "main"),
      "dohc://plugin-panel/%68ello-plugin/main",
    ],
  ])("rejects one %s path in several editor groups", (_label, path, alias) => {
    const result = WorkspaceUiState.safeParse({
      ...validState,
      editorGroups: [
        {
          id: "left",
          tabs: [path, "notes/a.md"],
          activeTab: path,
          size: 0.5,
        },
        {
          id: "right",
          tabs: ["notes/a.md", alias],
          activeTab: alias,
          size: 0.5,
        },
      ],
      activeEditorGroup: "left",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["editorGroups", 1, "tabs", 1],
        }),
      );
    }
  });

  it("requires valid focus and normalized sizes", () => {
    expect(
      WorkspaceUiState.safeParse({
        ...validState,
        activeEditorGroup: "missing",
      }).success,
    ).toBe(false);
    expect(
      WorkspaceUiState.safeParse({
        ...validState,
        editorGroups: [{ ...validState.editorGroups[0], size: 0.5 }],
      }).success,
    ).toBe(false);
  });

  it("accepts valid populated and empty editor groups", () => {
    for (const right of [
      {
        id: "right",
        tabs: ["notes/b.md"],
        activeTab: "notes/b.md",
        size: 0.5,
      },
      { id: "right", tabs: [], activeTab: null, size: 0.5 },
    ]) {
      expect(
        WorkspaceUiState.safeParse({
          ...validState,
          editorGroups: [
            { ...validState.editorGroups[0], size: 0.5 },
            right,
          ],
          activeEditorGroup: "right",
        }).success,
      ).toBe(true);
    }
  });

  it("enforces the total open-tab cap across editor groups", () => {
    const result = WorkspaceUiState.safeParse({
        ...validState,
        editorGroups: [
          {
            id: "left",
            tabs: Array.from({ length: 60 }, (_, index) => `left-${index}.md`),
            activeTab: "left-0.md",
            size: 0.5,
          },
          {
            id: "right",
            tabs: Array.from({ length: 41 }, (_, index) => `right-${index}.md`),
            activeTab: "right-0.md",
            size: 0.5,
          },
        ],
        activeEditorGroup: "right",
      });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "Open tabs exceed the configured limit of 100 tabs (observed 101 tabs).",
      );
    }
  });

  it("accepts every model-constructible group and rejects one more before validation", () => {
    const groups = Array.from({ length: MAX_EDITOR_GROUPS }, (_, index) => ({
      id: `group-${index}`,
      tabs: index === MAX_EDITOR_GROUPS - 1 ? [] : [`file-${index}.md`],
      activeTab:
        index === MAX_EDITOR_GROUPS - 1 ? null : `file-${index}.md`,
      size: 1 / MAX_EDITOR_GROUPS,
    }));
    expect(
      WorkspaceUiState.safeParse({
        ...validState,
        editorGroups: groups,
        activeEditorGroup: groups[0].id,
      }).success,
    ).toBe(true);

    const oversized = [...groups, null];
    const rejected = WorkspaceUiState.safeParse({
      ...validState,
      editorGroups: oversized,
      activeEditorGroup: groups[0].id,
    });
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(rejected.error.issues.map((issue) => issue.message)).toEqual([
        `Editor groups exceed the configured limit of ${MAX_EDITOR_GROUPS} groups (observed ${MAX_EDITOR_GROUPS + 1} groups).`,
      ]);
    }
  });

  it("preserves stale stored focus for the tolerant renderer parser", () => {
    const stale = {
      ...validState,
      editorGroups: [
        { ...validState.editorGroups[0], activeTab: "missing.md" },
      ],
      activeEditorGroup: "missing",
    };
    expect(GetWorkspaceUiStateResult.parse(stale)).toEqual(stale);
  });
});

describe("clipboard IPC contract", () => {
  it("accepts bounded text and rejects empty or oversized writes", () => {
    expect(WriteClipboardTextPayload.parse({ text: "copy me" }).text).toBe(
      "copy me",
    );
    expect(WriteClipboardTextPayload.safeParse({ text: "" }).success).toBe(false);
    expect(
      WriteClipboardTextPayload.safeParse({ text: "x".repeat(20_001) }).success,
    ).toBe(false);
    expect(
      WriteClipboardTextPayload.safeParse({ text: "copy", secret: "nope" }).success,
    ).toBe(false);
  });
});

// The preload boundary for main→renderer events. These cases are the review
// attack set: a schema must accept only exact primitive members of its closed
// set — not String objects, toString tricks, case variants, or lookalikes —
// because the parse is all that stands between an ipc payload and renderer code.
describe("menu command boundaries", () => {
  it("accept every member of their closed tuples", () => {
    for (const command of MENU_COMMANDS) expect(MenuCommand.parse(command)).toBe(command);
    for (const command of EXPLORER_MENU_COMMANDS) {
      expect(ExplorerMenuCommand.parse(command)).toBe(command);
    }
    for (const command of WORKBENCH_MENU_COMMANDS) {
      expect(WorkbenchMenuCommand.parse(command)).toBe(command);
    }
  });

  it("reject case variants, unknown ids, and non-primitive impostors", () => {
    for (const value of [
      "NEW-FILE",
      "New-File",
      "new-file ",
      "delete-everything",
      "",
      new String("new-file"),
      { toString: () => "new-file" },
      Object.assign(Object.create(null), { valueOf: () => "new-file" }),
      ["new-file"],
      null,
      undefined,
      0,
      Symbol("new-file"),
    ]) {
      expect(MenuCommand.safeParse(value).success).toBe(false);
    }
    for (const value of ["RENAME", "rename ", "rm -rf", "", new String("rename"), ["rename"]]) {
      expect(ExplorerMenuCommand.safeParse(value).success).toBe(false);
    }
    for (const value of ["CLOSE-TAB", "close-tab ", "open-terminal", new String("close-tab")]) {
      expect(WorkbenchMenuCommand.safeParse(value).success).toBe(false);
    }
  });
});

describe("workspace activated event boundary", () => {
  const activated = {
    workspaceId: "ws-123",
    rootPath: "/home/sam/dohc",
    kind: "personal",
    mode: "local-first",
  };

  it("accepts a workspace summary and strips extra fields", () => {
    expect(WorkspaceSummary.parse({ ...activated, extra: "ignored" })).toEqual(activated);
  });

  it("rejects malformed ids, kinds, modes, and impostors", () => {
    expect(WorkspaceSummary.safeParse({ ...activated, workspaceId: "WS-123" }).success).toBe(
      false,
    );
    expect(WorkspaceSummary.safeParse({ ...activated, kind: "admin" }).success).toBe(false);
    expect(
      WorkspaceSummary.safeParse({ ...activated, mode: "remote-code-exec" }).success,
    ).toBe(false);
    expect(WorkspaceSummary.safeParse(["ws-123"]).success).toBe(false);
    expect(WorkspaceSummary.safeParse(new String("ws-123")).success).toBe(false);
  });
});

describe("update state event boundary", () => {
  it("accepts every closed-tuple status and strips unknown fields", () => {
    for (const status of UPDATE_STATUSES) {
      expect(UpdateStateEvent.parse({ status, message: "m" })).toEqual({ status, message: "m" });
    }
    expect(UpdateStateEvent.parse({ status: "ready", message: "m", evil: "x" })).toEqual({
      status: "ready",
      message: "m",
    });
  });

  it("rejects unknown/case-variant statuses and non-primitive impostors", () => {
    for (const status of ["READY", "pwn", new String("ready"), { toString: () => "ready" }]) {
      expect(UpdateStateEvent.safeParse({ status, message: "m" }).success).toBe(false);
    }
  });

  it("rejects missing, empty, oversized, or non-string messages", () => {
    expect(UpdateStateEvent.safeParse({ status: "ready" }).success).toBe(false);
    expect(UpdateStateEvent.safeParse({ status: "ready", message: "" }).success).toBe(false);
    expect(
      UpdateStateEvent.safeParse({ status: "ready", message: "x".repeat(501) }).success,
    ).toBe(false);
    expect(UpdateStateEvent.safeParse({ status: "ready", message: 42 }).success).toBe(false);
  });

  it("rejects malformed public update metadata", () => {
    const base = { status: "ready", message: "m" };
    for (const bad of [
      { currentVersion: "" },
      { currentVersion: "x".repeat(201) },
      { version: "" },
      { channel: "beta" },
      { canCheck: "true" },
      { canInstall: 1 },
      { percent: -1 },
      { percent: 101 },
      { percent: Infinity },
      { percent: Number.NaN },
    ]) {
      expect(UpdateStateEvent.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
    expect(UpdateStateEvent.parse({ ...base, percent: 0 })).toEqual({ ...base, percent: 0 });
  });

  it("rejects non-objects, null, and arrays", () => {
    expect(UpdateStateEvent.safeParse(null).success).toBe(false);
    expect(UpdateStateEvent.safeParse("ready").success).toBe(false);
    expect(UpdateStateEvent.safeParse([{ status: "ready", message: "m" }]).success).toBe(false);
  });

  it("requires the action and check envelopes to carry a boolean and a state", () => {
    expect(UpdateCheckResult.safeParse({ checked: "yes", state: null }).success).toBe(false);
    expect(UpdateActionResult.safeParse({ accepted: true }).success).toBe(false);
  });
});

describe("search results event boundary", () => {
  const entry = {
    path: "notes/a.md",
    line: 3,
    column: 5,
    preview: "one needle two",
    matchStart: 4,
    matchEnd: 10,
  };
  const batch = { searchId: "s1", entries: [entry], done: false, limitHit: false };

  it("accepts a well-formed batch and keeps only the validated fields", () => {
    const parsed = SearchResultsEvent.parse({
      ...batch,
      entries: [{ ...entry, extra: "dropped" }],
      injected: true,
    });
    expect(parsed).toEqual(batch);
    expect(parsed.entries[0]).not.toHaveProperty("extra");
    expect(parsed).not.toHaveProperty("injected");
  });

  it("accepts optional engine result fields", () => {
    const engineEntry = {
      ...entry,
      surface: "chat",
      threadId: "thread-1",
      objectId: "object-1",
      title: "Planning chat",
    };
    const engineBatch = { searchId: "s-engine", entries: [engineEntry], done: true, limitHit: false };
    expect(SearchResultsEvent.parse(engineBatch)).toEqual(engineBatch);
  });

  it("accepts an empty done batch (the final flush)", () => {
    const flush = { searchId: "s2", entries: [], done: true, limitHit: true };
    expect(SearchResultsEvent.parse(flush)).toEqual(flush);
  });

  it("accepts an optional fail-closed notice and rejects a bad one", () => {
    const noticed = { ...batch, entries: [], done: true, notice: "Search paused: policy error" };
    expect(SearchResultsEvent.parse(noticed)).toEqual(noticed);
    expect(SearchResultsEvent.safeParse({ ...batch, notice: "" }).success).toBe(false);
    expect(SearchResultsEvent.safeParse({ ...batch, notice: "x".repeat(501) }).success).toBe(
      false,
    );
    expect(SearchResultsEvent.safeParse({ ...batch, notice: 7 }).success).toBe(false);
  });

  it("rejects unsafe paths: absolute, traversal, backslash, null byte, drive letter", () => {
    for (const path of [
      "/etc/passwd",
      "../escape.md",
      "a/../b.md",
      "a\\b.md",
      "a\0b.md",
      "C:evil.md",
      "",
      "x".repeat(5000),
    ]) {
      expect(
        SearchResultsEvent.safeParse({ ...batch, entries: [{ ...entry, path }] }).success,
        JSON.stringify(path),
      ).toBe(false);
    }
  });

  it("rejects out-of-bounds offsets, non-integer lines, oversized previews", () => {
    for (const bad of [
      { matchEnd: 999 },
      { matchStart: -1 },
      { matchEnd: 2, matchStart: 4 },
      { line: 0 },
      { line: 1.5 },
      { preview: "x".repeat(251), matchStart: 0, matchEnd: 1 },
      { surface: "agent" },
      { threadId: "" },
    ]) {
      expect(
        SearchResultsEvent.safeParse({ ...batch, entries: [{ ...entry, ...bad }] }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("rejects oversized batches, bad ids, and non-primitive impostors", () => {
    for (const bad of [
      { entries: Array.from({ length: 51 }, () => entry) },
      { searchId: "" },
      { searchId: "x".repeat(65) },
      { searchId: new String("s1") },
      { done: "false" },
      { entries: entry },
    ]) {
      expect(SearchResultsEvent.safeParse({ ...batch, ...bad }).success).toBe(false);
    }
    expect(SearchResultsEvent.safeParse(null).success).toBe(false);
    expect(SearchResultsEvent.safeParse([batch]).success).toBe(false);
    expect(SearchResultsEvent.safeParse("batch").success).toBe(false);
  });
});

describe("isSafeRelativePath", () => {
  it("accepts plain relative forward-slashed paths", () => {
    expect(isSafeRelativePath("a.md")).toBe(true);
    expect(isSafeRelativePath("notes/deep/file.txt")).toBe(true);
    expect(isSafeRelativePath(".hidden.md")).toBe(true);
  });

  it("rejects traversal, absolute, and separators in disguise", () => {
    for (const path of ["..", "a//b", "a/./b", "/a", "D:stuff", "a\\b", "a\0b"]) {
      expect(isSafeRelativePath(path), path).toBe(false);
    }
  });
});

describe("engine Y.Doc event boundaries", () => {
  it("accept a bounded sessionId, real Uint8Array, and lineage generation", () => {
    const update = new Uint8Array([1, 2, 3]);
    const parsed = EngineYDocRemoteUpdateEvent.parse({
      sessionId: "s-1",
      update,
      lineageGeneration: 2,
      evil: "drop me",
    });
    expect(parsed).toEqual({ sessionId: "s-1", update, lineageGeneration: 2 });
    expect(parsed).not.toHaveProperty("evil");
  });

  it("reject a missing field, a bad sessionId, and a non-Uint8Array update", () => {
    const update = new Uint8Array([1]);
    for (const bad of [
      { update, lineageGeneration: 1 },
      { sessionId: "s", update: [1, 2, 3], lineageGeneration: 1 },
      { sessionId: "s", update: update.buffer, lineageGeneration: 1 },
      { sessionId: "", update, lineageGeneration: 1 },
      { sessionId: "s", update, lineageGeneration: 0 },
      null,
      [{ sessionId: "s", update }],
    ]) {
      expect(EngineYDocRemoteUpdateEvent.safeParse(bad).success).toBe(false);
    }
  });

  it("reject an empty or over-bound update", () => {
    for (const update of [new Uint8Array(0), new Uint8Array(ENGINE_YDOC_UPDATE_MAX_BYTES + 1)]) {
      expect(
        EngineYDocRemoteUpdateEvent.safeParse({ sessionId: "s", update, lineageGeneration: 1 })
          .success,
      ).toBe(false);
    }
  });

  it("accept the deleted state that turns a live editor read-only", () => {
    expect(
      EngineYDocSaveStateEvent.parse({ sessionId: "session-1", state: "deleted", seq: 4 }),
    ).toEqual({ sessionId: "session-1", state: "deleted", seq: 4 });
  });
});

describe("update IPC contract", () => {
  const readyState = {
    status: "ready",
    message: "Update 1.2.4 is ready",
    currentVersion: "1.2.3",
    channel: "latest",
    canCheck: false,
    canInstall: true,
    version: "1.2.4",
  };

  it("accepts public update state and action results", () => {
    expect(UpdateStateEvent.parse(readyState)).toEqual(readyState);
    expect(
      UpdateCheckResult.parse({ checked: false, state: readyState }).state,
    ).toEqual(readyState);
    expect(
      UpdateActionResult.parse({
        accepted: true,
        state: readyState,
      }).accepted,
    ).toBe(true);
  });

  it("strips feed/config fields and rejects malformed progress", () => {
    const parsed = UpdateStateEvent.parse({ ...readyState, feedUrl: "https://x" });
    expect(parsed).not.toHaveProperty("feedUrl");
    expect(UpdateStateEvent.safeParse({ ...readyState, percent: 101 }).success).toBe(
      false,
    );
    expect(UpdateStateEvent.safeParse({ ...readyState, channel: "beta" }).success).toBe(
      false,
    );
  });
});

describe("site IPC contract", () => {
  it("accepts detected normal website metadata", () => {
    expect(
      ListSitesResult.parse({
        sites: [
          {
            root: "client-portal",
            title: "Client Portal",
            kind: "package",
            confidence: "high",
            entryPath: "client-portal/index.html",
            configPath: "client-portal/vite.config.ts",
            packagePath: "client-portal/package.json",
            packageManager: "pnpm",
            scripts: { dev: "vite", build: "vite build" },
            configuredScripts: {},
            configuredPreviewMode: "build",
            configuredBuildOutput: null,
            buildOutputs: ["dist"],
            sourceFiles: ["client-portal/index.html", "client-portal/package.json"],
            shareManifest: { ok: false, reason: "no-runnable-artifact" },
            diagnostics: [],
            authority: { kind: "workspace" },
          },
        ],
      }).sites[0],
    ).toMatchObject({
      root: "client-portal",
      configuredPreviewMode: "build",
    });
    expect(ListSitesResult.parse({ sites: [] }).sites).toEqual([]);
    expect(
      ListSitesResult.parse({
        sites: [
          {
            root: "static",
            title: "Static",
            kind: "static",
            confidence: "medium",
            entryPath: null,
            configPath: null,
            packagePath: null,
            packageManager: null,
            scripts: {},
            configuredScripts: {},
            configuredPreviewMode: null,
            configuredBuildOutput: null,
            buildOutputs: [],
            sourceFiles: [],
            shareManifest: { ok: false, reason: "no-runnable-artifact" },
            diagnostics: [],
            authority: { kind: "workspace" },
          },
        ],
      }).sites[0]?.entryPath,
    ).toBeNull();
  });

  it("accepts a site with more than 1000 discovered source files", () => {
    const sourceFiles = Array.from(
      { length: 1001 },
      (_, index) => `large-site/assets/${index}.js`,
    );

    expect(
      ListSitesResult.parse({
        sites: [
          {
            root: "large-site",
            title: "Large site",
            kind: "package",
            confidence: "high",
            entryPath: null,
            configPath: null,
            packagePath: null,
            packageManager: "pnpm",
            scripts: { dev: "vite" },
            configuredScripts: {},
            configuredPreviewMode: null,
            configuredBuildOutput: null,
            buildOutputs: [],
            sourceFiles,
            shareManifest: { ok: false, reason: "no-runnable-artifact" },
            diagnostics: [],
            authority: { kind: "workspace" },
          },
        ],
      }).sites[0]?.sourceFiles,
    ).toHaveLength(1001);
  });

  it("keeps package script names while removing the deleted configured preview slot", () => {
    const parsed = ListSitesResult.parse({
      sites: [
        {
          root: "configured-site",
          title: "Configured site",
          kind: "configured",
          confidence: "high",
          entryPath: "configured-site/index.html",
          configPath: "configured-site/dohc.json",
          packagePath: null,
          packageManager: null,
          scripts: { preview: "npm run preview" },
          configuredScripts: { preview: "serve dist" },
          configuredPreviewMode: null,
          configuredBuildOutput: null,
          buildOutputs: [],
          sourceFiles: ["configured-site/index.html"],
          shareManifest: {
            ok: true,
            manifest: {
              entryPath: "configured-site/index.html",
              assets: [],
            },
          },
          diagnostics: [],
          authority: { kind: "workspace" },
        },
      ],
    }).sites[0];

    expect(parsed?.scripts).toEqual({ preview: "npm run preview" });
    expect(parsed?.configuredScripts).toEqual({});
  });

  it("accepts more than 100 detected sites", () => {
    const sites = Array.from({ length: 101 }, (_, index) => ({
      root: `site-${index}`,
      title: `Site ${index}`,
      kind: "static" as const,
      confidence: "high" as const,
      entryPath: `site-${index}/index.html`,
      configPath: null,
      packagePath: null,
      packageManager: null,
      scripts: {},
      configuredScripts: {},
      configuredPreviewMode: null,
      configuredBuildOutput: null,
      buildOutputs: [],
      sourceFiles: [`site-${index}/index.html`],
      shareManifest: {
        ok: true as const,
        manifest: {
          entryPath: `site-${index}/index.html`,
          assets: [],
        },
      },
      diagnostics: [],
      authority: { kind: "workspace" as const },
    }));

    expect(ListSitesResult.parse({ sites }).sites).toHaveLength(101);
  });

  it("requires a mount root for shared-site authority", () => {
    const sharedSite = {
      root: "shared-with-me/alex/report",
      title: "Report",
      kind: "static",
      confidence: "high",
      entryPath: "shared-with-me/alex/report/index.html",
      configPath: null,
      packagePath: null,
      packageManager: null,
      scripts: {},
      configuredScripts: {},
      configuredPreviewMode: null,
      configuredBuildOutput: null,
      buildOutputs: [],
      sourceFiles: ["shared-with-me/alex/report/index.html"],
      shareManifest: {
        ok: true,
        manifest: {
          entryPath: "shared-with-me/alex/report/index.html",
          assets: [],
        },
      },
      diagnostics: [],
    };
    expect(
      ListSitesResult.safeParse({
        sites: [
          {
            ...sharedSite,
            authority: { kind: "share", mountRoot: "shared-with-me/alex" },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      ListSitesResult.safeParse({
        sites: [{ ...sharedSite, authority: { kind: "share" } }],
      }).success,
    ).toBe(false);
    expect(
      ListSitesResult.safeParse({
        sites: [{ ...sharedSite, authority: { kind: "share", mountRoot: "." } }],
      }).success,
    ).toBe(false);
    expect(
      ListSitesResult.safeParse({
        sites: [
          {
            ...sharedSite,
            authority: { kind: "share", mountRoot: "shared-with-me/someone-else" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts bounded preview start/result payloads", () => {
    expect(
      StartSitePreviewPayload.parse({
        workspaceId: "ws-sites",
        siteRoot: ".",
        mode: "static",
      }),
    ).toEqual({
      workspaceId: "ws-sites",
      siteRoot: ".",
      mode: "static",
    });

    expect(
      StartSitePreviewResult.parse({
        siteRoot: ".",
        mode: "build",
        url: "http://127.0.0.1:4173/",
        logs: [{ stream: "stdout", text: "built", at: 1 }],
        exited: false,
        build: {
          ok: true,
          command: "pnpm",
          args: ["build"],
          outputPath: "/tmp/workspace/dist",
          exitCode: 0,
        },
      }).mode,
    ).toBe("build");
    expect(
      StartSitePreviewResult.parse({
        siteRoot: "site",
        mode: "static",
        url: "http://localhost:4173/",
        logs: [],
        exited: false,
      }).logs,
    ).toEqual([]);
    expect(
      StopSitePreviewPayload.parse({
        workspaceId: "ws-sites",
        siteRoot: ".",
      }),
    ).toEqual({ workspaceId: "ws-sites", siteRoot: "." });
    expect(
      GetSitePreviewLogsPayload.parse({
        workspaceId: "ws-sites",
        siteRoot: ".",
      }),
    ).toEqual({ workspaceId: "ws-sites", siteRoot: "." });
    expect(
      GetSitePreviewLogsResult.parse({
        logs: [{ stream: "stderr", text: "late output", at: 2 }],
        exited: false,
      }).logs,
    ).toEqual([{ stream: "stderr", text: "late output", at: 2 }]);
    for (const workspaceId of ["", "WS-SITES", "ws_sites"]) {
      expect(
        StartSitePreviewPayload.safeParse({
          workspaceId,
          siteRoot: "site",
          mode: "static",
        }).success,
      ).toBe(false);
      expect(
        StopSitePreviewPayload.safeParse({
          workspaceId,
          siteRoot: "site",
        }).success,
      ).toBe(false);
    }
    for (const siteRoot of [
      "",
      "../escape",
      "site/../../escape",
      "/tmp/site",
      "C:/site",
      "site/./dist",
      "site\0/index.html",
      "site\\index.html",
    ]) {
      expect(
        StartSitePreviewPayload.safeParse({
          workspaceId: "ws-sites",
          siteRoot,
          mode: "static",
        }).success,
      ).toBe(false);
      expect(
        StopSitePreviewPayload.safeParse({
          workspaceId: "ws-sites",
          siteRoot,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects unknown preview modes and non-local preview URLs", () => {
    expect(
      StartSitePreviewPayload.safeParse({
        workspaceId: "ws-sites",
        siteRoot: "site",
        mode: "native",
      }).success,
    ).toBe(false);
    expect(
      StartSitePreviewResult.safeParse({
        siteRoot: "site",
        mode: "static",
        url: "http://127.0.0.1:43210",
        logs: [],
        exited: false,
      }).success,
    ).toBe(true);
    expect(
      StartSitePreviewResult.safeParse({
        siteRoot: "site",
        mode: "static",
        url: "http://[::1]:43210/",
        logs: [],
        exited: false,
      }).success,
    ).toBe(true);
    expect(
      StartSitePreviewResult.safeParse({
        siteRoot: "site",
        mode: "static",
        url: "http://[::ffff:127.0.0.1]:43210/",
        logs: [],
        exited: false,
      }).success,
    ).toBe(true);
    expect(
      StartSitePreviewResult.safeParse({
        siteRoot: "site",
        mode: "static",
        url: "http://127.0.0.1/",
        logs: [],
        exited: false,
      }).success,
    ).toBe(true);
    expect(
      StartSitePreviewResult.safeParse({
        siteRoot: "site",
        mode: "static",
        url: "http://127.42.0.7:43210/",
        logs: [],
        exited: false,
      }).success,
    ).toBe(true);
    for (const url of [
      "https://example.com/",
      "file:///tmp/site/index.html",
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "http://0.0.0.0:43210/",
      "http://user:pass@127.0.0.1:43210/",
      "http://127.0.0.1:abc/",
      "http://127.0.0.1:0/",
      "http://127.0.0.1:70000/",
    ]) {
      expect(
        StartSitePreviewResult.safeParse({
          siteRoot: "site",
          mode: "static",
          url,
          logs: [],
          exited: false,
        }).success,
      ).toBe(false);
    }
  });
});

describe("plugin guest SDK IPC contract", () => {
  it("accepts realistic JSON-safe SDK params at the preload IPC boundary", () => {
    const text = "x".repeat(2 * 1024 * 1024);
    expect(
      parseInvokePluginPanelSdkPayloadForIpc({
        workspaceId: "ws-plugins",
        pluginId: "hello-plugin",
        panelId: "main",
        method: "files.write",
        params: {
          path: "exports/report.txt",
          text,
          overwrite: true,
          metadata: { tags: ["quarterly", "approved"], score: 0.95 },
        },
      }).params,
    ).toMatchObject({ path: "exports/report.txt", overwrite: true });
  });

  it("rejects oversized, excessively deep, and over-populated SDK params", () => {
    const base = {
      workspaceId: "ws-plugins",
      pluginId: "hello-plugin",
      panelId: "main",
      method: "files.write",
    };
    const oversized = {
      ...base,
      params: { text: "x".repeat(SDK_PARAMS_MAX_BYTES + 1) },
    };
    expect(() => parseInvokePluginPanelSdkPayloadForIpc(oversized)).toThrow(/JSON-safe/);
    expect(
      InvokePluginPanelSdkPayload.safeParse({
        ...base,
        params: oversized.params,
      }).success,
    ).toBe(false);

    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let depth = 0; depth <= SDK_PARAMS_MAX_DEPTH; depth += 1) {
      const child: Record<string, unknown> = {};
      deep.child = child;
      deep = child;
    }
    expect(InvokePluginPanelSdkPayload.safeParse({ ...base, params: root }).success).toBe(
      false,
    );

    expect(
      InvokePluginPanelSdkPayload.safeParse({
        ...base,
        params: Array.from({ length: SDK_PARAMS_MAX_VALUES }, () => null),
      }).success,
    ).toBe(false);
  });

  it("rejects SDK params that are not a finite, acyclic JSON data tree", () => {
    const base = {
      workspaceId: "ws-plugins",
      pluginId: "hello-plugin",
      panelId: "main",
      method: "databases.edit",
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    for (const params of [
      cyclic,
      { value: Number.POSITIVE_INFINITY },
      { value: BigInt(1) },
      { value: new Uint8Array([1, 2, 3]) },
      ["first", , "third"],
    ]) {
      expect(InvokePluginPanelSdkPayload.safeParse({ ...base, params }).success).toBe(
        false,
      );
    }
  });

  it("accepts strict plugin panel open, start, and stop payloads", () => {
    const identity = {
      workspaceId: "ws-plugins",
      pluginId: "@dohc/reports",
      panelId: "main",
    };
    expect(
      OpenPluginPanelPayload.parse({
        ...identity,
        pluginRoot: "plugins/reports",
      }),
    ).toEqual({ ...identity, pluginRoot: "plugins/reports" });
    const panelIdentity = {
      pluginId: identity.pluginId,
      panelId: identity.panelId,
    };
    expect(OpenPluginPanelResult.parse(panelIdentity)).toEqual(panelIdentity);
    expect(PluginPanelOpenedEvent.parse(identity)).toEqual(identity);
    // Starting names where the panel is mounted; stopping names only the
    // running panel, which is keyed without placement.
    const startPayload = { ...identity, placement: "view" as const };
    expect(StartPluginPanelPayload.parse(startPayload)).toEqual(startPayload);
    expect(StartPluginPanelPayload.safeParse(identity).success).toBe(false);
    expect(StopPluginPanelPayload.parse(identity)).toEqual(identity);
    expect(StopPluginPanelPayload.safeParse(startPayload).success).toBe(false);
    expect(
      StartPluginPanelResult.parse({
        status: "ok",
        url: "http://127.0.0.1:43123/",
        title: "Reports",
        surfaceId: 1,
      }),
    ).toEqual({
      status: "ok",
      url: "http://127.0.0.1:43123/",
      title: "Reports",
      surfaceId: 1,
    });
    expect(
      StartPluginPanelResult.parse({ status: "not-registered" }),
    ).toEqual({ status: "not-registered" });
    const invalidated = { ...identity, surfaceId: 1 };
    expect(PluginPanelInvalidatedEvent.parse(invalidated)).toEqual(invalidated);
    expect(parsePluginPanelInvalidatedEventForIpc(invalidated)).toEqual(
      invalidated,
    );
    expect(
      parsePluginPanelInvalidatedEventForIpc({ ...invalidated, extra: true }),
    ).toBeNull();

    expect(
      StartPluginPanelPayload.safeParse({ ...identity, extra: true }).success,
    ).toBe(false);
    expect(
      OpenPluginPanelPayload.safeParse({
        ...identity,
        pluginRoot: "plugins/reports\0escape",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed plugin panel identities and non-loopback results", () => {
    const base = {
      workspaceId: "ws-plugins",
      pluginId: "hello-plugin",
      panelId: "main",
    };
    for (const patch of [
      { workspaceId: "WS-PLUGINS" },
      { pluginId: "" },
      { pluginId: "hello\0main" },
      { panelId: "" },
      { panelId: "main\0alias" },
      { panelId: "x".repeat(121) },
    ]) {
      expect(StartPluginPanelPayload.safeParse({ ...base, ...patch }).success).toBe(
        false,
      );
      expect(StopPluginPanelPayload.safeParse({ ...base, ...patch }).success).toBe(
        false,
      );
    }
    expect(
      StartPluginPanelResult.safeParse({
        status: "ok",
        url: "https://127.0.0.1:43123/",
        title: "Reports",
        surfaceId: 1,
      }).success,
    ).toBe(false);
  });

  it("bounds SDK params on the plugin panel payload", () => {
    const payload = {
      workspaceId: "ws-plugins",
      pluginId: "hello-plugin",
      panelId: "main",
      method: "files.write",
      params: { path: "output.txt", text: "hello" },
    };
    expect(parseInvokePluginPanelSdkPayloadForIpc(payload)).toEqual(payload);
    expect(
      InvokePluginPanelSdkPayload.safeParse({
        ...payload,
        params: { text: "x".repeat(SDK_PARAMS_MAX_BYTES + 1) },
      }).success,
    ).toBe(false);
    expect(
      InvokePluginPanelSdkPayload.safeParse({ ...payload, method: "" }).success,
    ).toBe(false);
    expect(
      InvokePluginPanelSdkPayload.safeParse({ ...payload, extra: true }).success,
    ).toBe(false);
  });

  it("accepts a strict plugin-panel SDK event and rejects excess data or an empty event name", () => {
    const event = {
      workspaceId: "ws-plugins",
      pluginId: "hello-plugin",
      panelId: "main",
      subscriptionId: "subscription-1",
      event: "change",
      data: {
        path: "docs/index.md",
        operation: "update" as const,
        sha256: "aaa",
      },
    };

    expect(PluginPanelSdkEvent.parse(event)).toEqual(event);
    expect(parsePluginPanelSdkEventForIpc(event)).toEqual(event);
    expect(parsePluginPanelSdkEventForIpc({ ...event, extra: true })).toBeNull();
    expect(
      parsePluginPanelSdkEventForIpc({
        ...event,
        data: { ...event.data, extra: true },
      }),
    ).toBeNull();
    expect(
      parsePluginPanelSdkEventForIpc({ ...event, event: "" }),
    ).toBeNull();
  });

  it("accepts collection record event data and rejects shapes outside the union", () => {
    const base = {
      workspaceId: "ws-plugins",
      pluginId: "hello-plugin",
      panelId: "main",
      subscriptionId: "subscription-1",
    };
    const created = {
      ...base,
      event: "record.created",
      data: {
        collectionPath: "collections/people",
        recordId: "rec-1",
        author: null,
        timestamp: 1_756_000_000_000,
        actorKind: null,
        onBehalfOf: null,
        depth: null,
        source: null,
      },
    };
    const fieldChanged = {
      ...base,
      event: "record.field.changed",
      data: {
        collectionPath: "collections/people",
        recordId: "rec-1",
        field: "notes",
        previous: { tags: ["a", "b"] },
        // The engine's oversized-value marker is an ordinary JSON object.
        next: { truncated: true, bytes: 9_000 },
        author: "agent:sites",
        timestamp: 1_756_000_000_000,
        historyId: 7,
        actorKind: "agent",
        onBehalfOf: "automation:sites",
        depth: 1,
        source: { originId: "origin-a", originSeq: 12 },
      },
    };

    expect(parsePluginPanelSdkEventForIpc(created)).toEqual(created);
    expect(parsePluginPanelSdkEventForIpc(fieldChanged)).toEqual(fieldChanged);

    // Not a passthrough: a shape matching none of the union members is
    // dropped, and so is a member shape with excess or mistyped fields.
    expect(
      parsePluginPanelSdkEventForIpc({ ...created, data: { anything: true } }),
    ).toBeNull();
    expect(
      parsePluginPanelSdkEventForIpc({
        ...created,
        data: { ...created.data, recordId: "" },
      }),
    ).toBeNull();
    expect(
      parsePluginPanelSdkEventForIpc({
        ...created,
        data: { ...created.data, timestamp: "yesterday" },
      }),
    ).toBeNull();
    expect(
      parsePluginPanelSdkEventForIpc({
        ...created,
        data: { ...created.data, extra: true },
      }),
    ).toBeNull();
    expect(
      parsePluginPanelSdkEventForIpc({
        ...fieldChanged,
        data: { ...fieldChanged.data, historyId: "7" },
      }),
    ).toBeNull();
    expect(
      parsePluginPanelSdkEventForIpc({
        ...fieldChanged,
        data: { ...fieldChanged.data, actorKind: "robot" },
      }),
    ).toBeNull();
    expect(
      parsePluginPanelSdkEventForIpc({
        ...fieldChanged,
        data: { ...fieldChanged.data, source: { originId: "" , originSeq: 1 } },
      }),
    ).toBeNull();
    const withoutNext: Record<string, unknown> = { ...fieldChanged.data };
    delete withoutNext.next;
    expect(
      parsePluginPanelSdkEventForIpc({ ...fieldChanged, data: withoutNext }),
    ).toBeNull();
  });
});

describe("workspace versions IPC contract", () => {
  it("accepts well-formed version payloads and results", () => {
    expect(
      CreateWorkspaceVersionPayload.parse({
        workspaceId: "ws-versions",
        name: "Client Draft",
      }).name,
    ).toBe("Client Draft");
    expect(
      ListWorkspaceVersionsResult.parse({
        versions: [
          {
            id: "main",
            name: "Main",
            kind: "main",
            createdAtMs: 1,
            canMergeIntoMain: false,
          },
        ],
        activeVersionId: "main",
      }).activeVersionId,
    ).toBe("main");
    expect(
      ResolveWorkspaceVersionConflictPayload.parse({
        workspaceId: "ws-versions",
        conflictId: "conflict-1",
        resolution: { kind: "keep-combined", text: "combined\n" },
      }).resolution.kind,
    ).toBe("keep-combined");
    // Conflict sides may be null (file only exists on one side).
    expect(
      WorkspaceVersionConflict.parse({
        conflictId: "conflict-1",
        path: "plan.md",
        sourceVersionId: "version-1",
        targetVersionId: "main",
        currentText: null,
        incomingText: "incoming\n",
        baseText: null,
      }).currentText,
    ).toBeNull();
  });

  it("rejects padded names, oversized inputs, and unknown resolution kinds", () => {
    expect(
      CreateWorkspaceVersionPayload.safeParse({
        workspaceId: "ws-versions",
        name: "  padded  ",
      }).success,
    ).toBe(false);
    expect(
      CreateWorkspaceVersionPayload.safeParse({
        workspaceId: "ws-versions",
        name: "x".repeat(81),
      }).success,
    ).toBe(false);
    expect(
      CreateWorkspaceVersionPayload.safeParse({
        workspaceId: "ws-versions",
        name: "",
      }).success,
    ).toBe(false);
    expect(
      SwitchWorkspaceVersionPayload.safeParse({
        workspaceId: "ws-versions",
        versionId: "",
      }).success,
    ).toBe(false);
    expect(
      ResolveWorkspaceVersionConflictPayload.safeParse({
        workspaceId: "ws-versions",
        conflictId: "conflict-1",
        resolution: { kind: "overwrite-everything" },
      }).success,
    ).toBe(false);
    // keep-combined requires the combined text.
    expect(
      ResolveWorkspaceVersionConflictPayload.safeParse({
        workspaceId: "ws-versions",
        conflictId: "conflict-1",
        resolution: { kind: "keep-combined" },
      }).success,
    ).toBe(false);
  });
});

describe("try-in-version IPC contract", () => {
  it("accepts a well-formed gesture payload and state shapes", () => {
    expect(
      TryInWorkspaceVersionPayload.parse({
        workspaceId: "ws-try",
        task: "tidy the notes",
      }).task,
    ).toBe("tidy the notes");
    expect(
      TryInWorkspaceVersionPayload.parse({
        workspaceId: "ws-try",
        task: "tidy the notes",
        driverId: "codex",
      }).driverId,
    ).toBe("codex");
    expect(
      TryInVersionStateResult.parse({ state: null }).state,
    ).toBeNull();
    expect(
      TryInVersionStateResult.parse({
        state: {
          status: "running",
          task: "tidy the notes",
          versionId: "version-1",
          versionName: "Try: tidy the notes",
          runId: "run-1",
          startedAtMs: 1,
          mergeAvailable: true,
        },
      }).state?.status,
    ).toBe("running");
    // Review state: an unavailable count is null, never invented.
    expect(
      TryInVersionRunState.parse({
        status: "review",
        task: "tidy the notes",
        versionId: "version-1",
        versionName: "Try: tidy the notes",
        runId: "run-1",
        startedAtMs: 1,
        endedAtMs: 2,
        runOutcome: "complete",
        changedFileCount: null,
        mergeAvailable: false,
      }).changedFileCount,
    ).toBeNull();
  });

  it("rejects blank or oversized tasks and malformed states", () => {
    expect(
      TryInWorkspaceVersionPayload.safeParse({
        workspaceId: "ws-try",
        task: "   ",
      }).success,
    ).toBe(false);
    expect(
      TryInWorkspaceVersionPayload.safeParse({
        workspaceId: "ws-try",
        task: "x".repeat(2001),
      }).success,
    ).toBe(false);
    expect(
      TryInVersionRunState.safeParse({
        status: "watching",
        task: "tidy",
        versionId: "version-1",
        versionName: "Try: tidy",
        runId: "run-1",
        startedAtMs: 1,
        mergeAvailable: true,
      }).success,
    ).toBe(false);
    expect(
      TryInVersionRunState.safeParse({
        status: "review",
        task: "tidy",
        versionId: "version-1",
        versionName: "Try: tidy",
        runId: "run-1",
        startedAtMs: 1,
        changedFileCount: -1,
        mergeAvailable: true,
      }).success,
    ).toBe(false);
  });
});

describe("sync status IPC contract", () => {
  it("refuses a status that cannot say why history is off", () => {
    const status = {
      state: "synced",
      pendingChangeCount: 0,
      lastSyncedAtMs: null,
      historyRecordingUnavailable: false,
      historyShareView: false,
      liveSessionsGeneration: 0,
      sharingDeclined: [
        {
          path: "notes/large.md",
          constraint: "MAX_YDOC_UPDATE_BYTES",
          limitBytes: 262_144,
          observedBytes: 280_001,
        },
      ],
    };
    expect(SyncStatusResult.parse(status).sharingDeclined).toEqual(
      status.sharingDeclined,
    );
    const pendingProjection = {
      state: "pending" as const,
      pendingPathCount: 2,
      pendingPaths: ["notes/one.md", "notes/two.md"],
      collisionPathCount: 0,
      collisionPaths: [],
      pullInFlight: false,
    };
    const statusWithPendingProjection = SyncStatusResult.parse({
      ...status,
      shareProjection: pendingProjection,
    });
    expect(statusWithPendingProjection.liveSessionsGeneration).toBe(0);
    expect(statusWithPendingProjection.shareProjection).toEqual(pendingProjection);
    expect(
      SyncStatusResult.parse({ ...status, liveSessionsGeneration: 3 })
        .liveSessionsGeneration,
    ).toBe(3);
    expect(
      SyncStatusResult.safeParse({ ...status, liveSessionsGeneration: -1 })
        .success,
    ).toBe(false);
    const { liveSessionsGeneration: _generationDropped, ...withoutGeneration } =
      status;
    expect(SyncStatusResult.safeParse(withoutGeneration).success).toBe(false);
    // The recorder cause fields are required because omission would claim the
    // user chose the failure or that this is not a shared view.
    const { historyRecordingUnavailable: _dropped, ...withoutFailureCause } = status;
    expect(SyncStatusResult.safeParse(withoutFailureCause).success).toBe(false);
    const { historyShareView: _alsoDropped, ...withoutShareCause } = status;
    expect(SyncStatusResult.safeParse(withoutShareCause).success).toBe(false);
    const failedStatus = {
      ...status,
      historyCaptureFailed: true as const,
      engineStoreRefused: null,
    };
    const { engineStoreRefused: _refusalDropped, ...withoutRefusalCause } =
      failedStatus;
    expect(SyncStatusResult.safeParse(withoutRefusalCause).success).toBe(false);
    expect(
      SyncStatusResult.safeParse({ ...status, engineStoreRefused: null }).success,
    ).toBe(false);
    expect(
      SyncStatusResult.safeParse({ ...status, engineStoreRefused: undefined })
        .success,
    ).toBe(false);
  });

  // The engine refuses a store a newer build migrated and leaves it intact.
  // Rebuild would move that store aside, so the only recovery is an update.
  it("asks for an update when a newer build migrated the store", () => {
    const refused = SyncStatusResult.parse({
      state: "synced",
      pendingChangeCount: 0,
      lastSyncedAtMs: null,
      historyRecordingUnavailable: false,
      historyShareView: false,
      liveSessionsGeneration: 0,
      historyCaptureFailed: true,
      engineStoreRefused: "migrated-by-newer-build",
      engineStoreRefusedDetail:
        "a newer build ran migration 5 (from-a-newer-build), which this build does not define",
    });
    expect(refused.engineStoreRefused).toBe("migrated-by-newer-build");
    expect(engineStoreRefusalRecovery("migrated-by-newer-build")).toBe("update");
    expect(engineStoreRefusalCopy("migrated-by-newer-build")).toBe(
      "A newer version of dohc updated this workspace's data store. Update dohc to continue. Your files are unchanged.",
    );
  });
});

describe("engine history and linked Chats IPC contract", () => {
  it("admits the auto-provisioned agent channel kind", () => {
    expect(
      ChatChannelRecord.parse({
        id: "channel-agent",
        name: "My agent",
        slug: "my-agent",
        kind: "agent",
        createdAtMs: 1,
        updatedAtMs: 1,
        threadCount: 0,
        unreadCount: 0,
        wireId: "channel_wire_agent_v1",
      }).kind,
    ).toBe("agent");
  });

  it("accepts well-formed moment pages, details, and restore results", () => {
    expect(
      ListEngineMomentsPayload.parse({
        workspaceId: "ws-engine",
        limit: 200,
        beforeMomentOrder: 41,
      }).limit,
    ).toBe(200);
    const page = ListEngineMomentsResult.parse({
      moments: [
        {
          id: "moment_1",
          versionId: "main",
          path: "notes/plan.md",
          recordedAtMs: 100,
          operation: "write",
          origin: "local-file",
          summary: "Reconciled offline edits",
          correlationId: "reconcile-1",
          momentOrder: 7,
        },
      ],
      nextBeforeMomentOrder: null,
      latestMomentOrder: 7,
      activeVersionId: "main",
      protectedTruncated: true,
    });
    expect(page.moments[0].summary).toBe("Reconciled offline edits");
    expect(page.protectedTruncated).toBe(true);
    expect(
      EngineMomentDetailRecord.parse({
        id: "moment_2",
        versionId: "main",
        path: "notes/plan.md",
        recordedAtMs: 100,
        operation: "delete",
        origin: "restore",
        beforeText: "removed content\n",
        afterText: null,
      }).afterText,
    ).toBeNull();
    expect(
      RestoreEngineMomentFileResult.parse({
        restored: "text",
        restoredMomentId: "moment_3",
        path: "notes/plan.md",
      }).restored,
    ).toBe("text");
  });

  it("rejects empty paths, bad limits, and oversized chat bodies", () => {
    // Path CONTAINMENT is enforced main-side (validateUserWritePath and the
    // engine's own path normalization); the wire schema only bounds shape.
    expect(
      ListFileChatsPayload.safeParse({
        workspaceId: "ws-engine",
        path: "",
      }).success,
    ).toBe(false);
    expect(
      ListEngineMomentsPayload.safeParse({
        workspaceId: "ws-engine",
        limit: 0,
      }).success,
    ).toBe(false);
    expect(
      ListEngineMomentsPayload.safeParse({
        workspaceId: "ws-engine",
        limit: 501,
      }).success,
    ).toBe(false);
    expect(
      CreateFileChatPayload.safeParse({
        workspaceId: "ws-engine",
        path: "notes/plan.md",
        title: "",
      }).success,
    ).toBe(false);
    expect(
      SendChatMessagePayload.safeParse({
        workspaceId: "ws-engine",
        threadId: "thread-1",
        body: "",
      }).success,
    ).toBe(false);
    expect(
      SendChatMessagePayload.safeParse({
        workspaceId: "ws-engine",
        threadId: "thread-1",
        body: "x".repeat(65_537),
      }).success,
    ).toBe(false);
  });

  it("round-trips a sent chat message with main-derived authorship", () => {
    const result = SendChatMessageResult.parse({
      message: {
        id: "message-1",
        threadId: "thread-1",
        authorKind: "human",
        authorDisplayName: "You",
        body: "First message",
        createdAtMs: 100,
      },
    });
    expect(result.message.authorKind).toBe("human");
    // The agent author kind is a first-class wire value (rendered as
    // "the agent name" in the UI).
    expect(
      SendChatMessageResult.parse({
        message: {
          id: "message-2",
          threadId: "thread-1",
          authorKind: "agent",
          authorDisplayName: "agent-owner@example.com",
          body: "Agent reply",
          createdAtMs: 101,
        },
      }).message.authorKind,
    ).toBe("agent");
  });
});

describe("chat reaction emoji trust boundary (WS-MU-C2)", () => {
  function setPayload(emoji: string) {
    return SetChatReactionPayload.safeParse({
      workspaceId: "ws-engine",
      threadId: "thread-1",
      messageId: "message-1",
      emoji,
      state: "added",
    });
  }

  it("accepts real emoji graphemes, including multi-codepoint ones", () => {
    // Simple pictographic, variation-selector, skin-tone modifier, a flag (two
    // regional indicators), and a ZWJ sequence — all one grapheme cluster.
    for (const emoji of ["👍", "❤️", "👍🏽", "🇺🇸", "👨‍👩‍👧", "🏳️‍🌈", "1️⃣", "#️⃣", "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"]) {
      expect(setPayload(emoji).success, emoji).toBe(true);
    }
  });

  it("accepts every emoji offered by the reaction catalog", async () => {
    const { default: catalog } = await import("../renderer/workbench/reactionEmojiData.json");
    for (const { emoji, name } of catalog) expect(setPayload(emoji).success, name).toBe(true);
  });

  it("rejects non-emoji strings the length bound alone would let through", () => {
    // A URL, plain text, a bare letter/digit, whitespace-padded emoji, and an
    // oversized string must all be refused — this schema is the trust boundary
    // for replicated reaction writes, so arbitrary strings must never render as
    // pills.
    for (const bad of [
      "hello",
      "http://evil.com",
      "a",
      "123",
      "👍 nice",
      " 👍",
      "1",
      "🏴\u{E0067}\u{E0062}",
      "x".repeat(40),
    ]) {
      expect(setPayload(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("applies the same validation to a ChatReactionRecord's emoji", () => {
    const base = {
      reactionId: "r1",
      messageId: "message-1",
      threadId: "thread-1",
      authorId: "author-1",
      authorKind: "human" as const,
      authorDisplayName: "You",
    };
    expect(ChatReactionRecord.safeParse({ ...base, emoji: "🎉" }).success).toBe(true);
    expect(ChatReactionRecord.safeParse({ ...base, emoji: "not-an-emoji" }).success).toBe(false);
  });
});

describe("renderer document request identity", () => {
  const rendererDocumentId = "123e4567-e89b-42d3-a456-426614174000";

  it("requires preload's document id on workspace open and reload requests", () => {
    expect(
      OpenWorkspaceRequestPayload.parse({
        workspaceId: "ws-1",
        rendererDocumentId,
      }),
    ).toEqual({ workspaceId: "ws-1", rendererDocumentId });
    expect(
      ReloadRendererRequestPayload.parse({ rendererDocumentId }),
    ).toEqual({ rendererDocumentId });
    expect(
      OpenWorkspaceRequestPayload.safeParse({ workspaceId: "ws-1" }).success,
    ).toBe(false);
    expect(ReloadRendererRequestPayload.safeParse({}).success).toBe(false);
  });
});

describe("presence state size cap (MU-C5 DoS boundary)", () => {
  const incarnationId = "123e4567-e89b-42d3-a456-426614174001";

  function publishPayload(state: unknown) {
    return PresencePublishPayload.safeParse({
      scope: { kind: "workspace", workspaceId: "ws-1" },
      topic: "chat:thread-1",
      clientId: "client-1",
      incarnationId,
      state,
    });
  }

  it("accepts legitimate small display state", () => {
    expect(publishPayload({ displayName: "Ada", typing: true }).success).toBe(true);
  });

  it("accepts an absent state (a leave / heartbeat with no payload)", () => {
    const result = PresencePublishPayload.safeParse({
      scope: { kind: "workspace", workspaceId: "ws-1" },
      topic: "chat:thread-1",
      clientId: "client-1",
      incarnationId,
      leave: true,
    });
    expect(result.success).toBe(true);
  });

  it("binds a share presence scope to its origin workspace", () => {
    const base = {
      topic: "chat:thread-1",
      clientId: "client-1",
      incarnationId,
      state: null,
    };
    expect(
      PresencePublishPayload.safeParse({
        ...base,
        scope: {
          kind: "share",
          workspaceId: "ws-1",
          shareId: "share-1",
        },
      }).success,
    ).toBe(true);
    expect(
      PresencePublishPayload.safeParse({
        ...base,
        scope: { kind: "share", shareId: "share-1" },
      }).success,
    ).toBe(false);
  });

  it("requires preload's document identity only at the main request boundary", () => {
    const payload = PresencePublishPayload.parse({
      scope: { kind: "workspace", workspaceId: "ws-1" },
      topic: "chat:thread-1",
      clientId: "client-1",
      incarnationId,
      state: null,
    });
    expect(
      PresencePublishRequestPayload.safeParse({
        ...payload,
        rendererDocumentId: "123e4567-e89b-42d3-a456-426614174002",
      }).success,
    ).toBe(true);
    expect(PresencePublishRequestPayload.safeParse(payload).success).toBe(false);
  });

  it("rejects an oversized JSON state before main would serialize it", () => {
    expect(publishPayload({ blob: "x".repeat(64 * 1024) }).success).toBe(false);
  });

  it("presenceStateWithinCap short-circuits huge, cyclic, and non-JSON state", () => {
    expect(presenceStateWithinCap({ displayName: "Ada" })).toBe(true);
    expect(presenceStateWithinCap(null)).toBe(true);
    expect(presenceStateWithinCap("x".repeat(64 * 1024))).toBe(false);

    // A cycle would make JSON.stringify throw; the guard rejects it as over-cap.
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(presenceStateWithinCap(cyclic)).toBe(false);

    // bigint isn't JSON-serializable.
    expect(presenceStateWithinCap({ n: 1n })).toBe(false);

    // Pathologically deep nesting is rejected without a full walk to the leaf.
    let deep: unknown = 0;
    for (let i = 0; i < 200; i += 1) deep = { deep };
    expect(presenceStateWithinCap(deep)).toBe(false);
  });

  it("honors an explicit smaller cap", () => {
    expect(presenceStateWithinCap({ a: "hello" }, 4)).toBe(false);
    expect(presenceStateWithinCap(true, PRESENCE_STATE_MAX_BYTES)).toBe(true);
  });
});

describe("document export IPC contract", () => {
  const validPayload = {
    workspaceId: "ws-1",
    suggestedName: "Project Plan",
    content: "<!doctype html><html><body>hi</body></html>",
    kind: "html" as const,
  };

  it("accepts a well-formed html export payload", () => {
    expect(ExportDocumentFilePayload.parse(validPayload)).toEqual(validPayload);
  });

  it("accepts a well-formed pdf export payload", () => {
    const payload = { ...validPayload, kind: "pdf" as const };
    expect(ExportDocumentFilePayload.parse(payload)).toEqual(payload);
  });

  it("rejects a suggested name containing a path separator", () => {
    expect(
      ExportDocumentFilePayload.safeParse({
        ...validPayload,
        suggestedName: "../escape",
      }).success,
    ).toBe(false);
    expect(
      ExportDocumentFilePayload.safeParse({
        ...validPayload,
        suggestedName: "sub\\dir",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty suggested name or content", () => {
    expect(
      ExportDocumentFilePayload.safeParse({ ...validPayload, suggestedName: "" }).success,
    ).toBe(false);
    expect(
      ExportDocumentFilePayload.safeParse({ ...validPayload, content: "" }).success,
    ).toBe(false);
  });

  it("rejects a kind outside the closed html/pdf set", () => {
    expect(
      ExportDocumentFilePayload.safeParse({ ...validPayload, kind: "docx" }).success,
    ).toBe(false);
  });

  it("resolves a cancelled save dialog as a null path", () => {
    expect(ExportDocumentFileResult.parse({ path: null })).toEqual({ path: null });
    expect(ExportDocumentFileResult.parse({ path: "/tmp/out.html" })).toEqual({
      path: "/tmp/out.html",
    });
  });
});

describe("engine Y.Doc update IPC contract", () => {
  it("carries every raw state admitted by the durable engine", () => {
    expect(ENGINE_YDOC_UPDATE_MAX_BYTES).toBe(20 * 1024 * 1024);
    const initialUpdate = new Uint8Array(ENGINE_YDOC_UPDATE_MAX_BYTES);

    expect(
      OpenEngineYDocSessionResult.parse({
        available: true,
        initialUpdate,
      }).initialUpdate,
    ).toBe(initialUpdate);
  });

  it("keeps bound document identity in the open result", () => {
    expect(
      OpenEngineYDocSessionResult.parse({
        available: true,
        initialUpdate: new Uint8Array(),
        objectId: "object-1",
        versionId: "main",
      }),
    ).toEqual({
      available: true,
      initialUpdate: new Uint8Array(),
      objectId: "object-1",
      versionId: "main",
    });
  });

  it("keeps terminal invalid scene asset authority distinct from a retryable open", () => {
    expect(
      OpenEngineYDocSessionResult.parse({
        available: false,
        artifactAssetsInvalid: true,
      }),
    ).toEqual({
      available: false,
      artifactAssetsInvalid: true,
    });
  });

  it("keeps an unresolved live path out of the writable fallback", () => {
    expect(
      OpenEngineYDocSessionResult.parse({
        available: false,
        documentUnavailable: true,
      }),
    ).toEqual({
      available: false,
      documentUnavailable: true,
    });
  });

  it("keeps a removal-window open refusal operation-aware in the renderer", () => {
    expect(
      OpenEngineYDocSessionResult.parse({
        available: false,
        removalInProgress: {
          operation: "move",
          message: "dohc is still moving notes.",
        },
      }),
    ).toEqual({
      available: false,
      removalInProgress: {
        operation: "move",
        message: "dohc is still moving notes.",
      },
    });
    // The accepted shape alone would still pass this test after the schema
    // widened operation past delete/move, or dropped message's min(1) bound.
    expect(
      OpenEngineYDocSessionResult.safeParse({
        available: false,
        removalInProgress: { operation: "rename", message: "x" },
      }).success,
    ).toBe(false);
    expect(
      OpenEngineYDocSessionResult.safeParse({
        available: false,
        removalInProgress: { operation: "delete", message: "" },
      }).success,
    ).toBe(false);
  });

  it("defaults the save sequence but requires the lineage generation", () => {
    const parsed = ApplyEngineYDocUpdatePayload.parse({
      sessionId: "shared-view-bypass",
      update: new Uint8Array([1, 2, 3]),
      lineageGeneration: 1,
    });
    expect(parsed.seq).toBe(0);
    expect(() =>
      ApplyEngineYDocUpdatePayload.parse({
        sessionId: "shared-view-bypass",
        update: new Uint8Array([1, 2, 3]),
      }),
    ).toThrow();
  });

  it("keeps a supplied seq and still rejects a nonsense one", () => {
    expect(
      ApplyEngineYDocUpdatePayload.parse({
        sessionId: "s",
        update: new Uint8Array([1]),
        seq: 7,
        lineageGeneration: 2,
      }).seq,
    ).toBe(7);
    expect(() =>
      ApplyEngineYDocUpdatePayload.parse({
        sessionId: "s",
        update: new Uint8Array([1]),
        seq: -1,
        lineageGeneration: 2,
      }),
    ).toThrow();
    expect(() =>
      ApplyEngineYDocUpdatePayload.parse({
        sessionId: "s",
        update: new Uint8Array([1]),
        lineageGeneration: 0,
      }),
    ).toThrow();
  });

  it("names the update limit and observed bytes when an update is too large", () => {
    const observedBytes = ENGINE_YDOC_UPDATE_MAX_BYTES + 1;
    const result = ApplyEngineYDocUpdatePayload.safeParse({
      sessionId: "s",
      update: new Uint8Array(observedBytes),
      seq: 1,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map(({ message }) => message)).toContain(
      `ENGINE_YDOC_UPDATE_MAX_BYTES is ${ENGINE_YDOC_UPDATE_MAX_BYTES} bytes; ` +
        `the update is ${observedBytes} bytes.`,
    );
  });

  it("distinguishes accepted updates from explicit main-process refusals", () => {
    expect(ApplyEngineYDocUpdateResult.parse({ accepted: true })).toEqual({
      accepted: true,
    });
    expect(
      ApplyEngineYDocUpdateResult.parse({
        accepted: false,
        reason: "lineage-transition",
      }),
    ).toEqual({ accepted: false, reason: "lineage-transition" });
    expect(
      ApplyEngineYDocUpdateResult.safeParse({
        accepted: false,
        reason: "silently-dropped",
      }).success,
    ).toBe(false);
  });

  it("distinguishes lineage acknowledgement from refusal", () => {
    expect(
      AcknowledgeEngineYDocLineageReplacementResult.parse({
        accepted: true,
        updates: [],
      }),
    ).toEqual({ accepted: true, updates: [] });
    expect(
      AcknowledgeEngineYDocLineageReplacementResult.parse({
        accepted: false,
        reason: "session-unavailable",
      }),
    ).toEqual({ accepted: false, reason: "session-unavailable" });
  });
});

// A refusal is data the engine persists into the registry and this schema
// reads back. The relay picks the op kind, so the engine replaces an unusable
// one with a bounded placeholder before recording it
// (`crates/dohc-engine-sync/src/relay.rs`, `ShareViewRefusal::new`). These are
// the two shapes that would otherwise arrive: the empty one throws in the
// client's strict decode and wedges the pull, the oversized one lands on disk
// and breaks the next workspace listing.
describe("a persisted share refusal stays readable", () => {
  const skipped = (opKind: string) => ({
    ops: [
      {
        originId: "peer",
        originSeq: 0,
        opKind,
        code: "invalid-input",
        detail: "invalid replication input: op_kind must be non-empty and bounded",
        atMs: 1000,
      },
    ],
    more: 0,
    generation: 1,
  });
  const summary = (opKind: string) => ({
    workspaceId: "ws-1",
    rootPath: "/home/sam/dohc/shared",
    kind: "personal" as const,
    mode: "local-first" as const,
    shareView: {
      shareId: "share-1",
      granterEmail: "granter@dohc.test",
      access: "view" as const,
      grantedSelector: { paths: ["docs"], versionId: null, access: "view" },
      skippedOps: skipped(opKind),
    },
  });

  it("accepts the placeholder the engine records", () => {
    const parsed = WorkspaceSummary.parse(summary("invalid-op-kind"));
    expect(parsed.shareView?.skippedOps?.ops[0]?.opKind).toBe("invalid-op-kind");
  });

  it("rejects the raw values the placeholder stands in for", () => {
    expect(
      () => WorkspaceSummary.parse(summary("")),
      "an empty op kind reaches the registry and the listing that reads it back",
    ).toThrow();
    expect(
      () => WorkspaceSummary.parse(summary("k".repeat(200))),
      "an oversized op kind reaches the registry and breaks every later listing",
    ).toThrow();
  });
});

// Aggregate chat reads answer from the local store after one bounded
// shared-channel pass. The remainder rides the response so an agent reading it
// through the CLI or MCP can see the answer is partially fresh — a console line
// reaches nobody. Absent means fully covered, so the field can never be zero.
describe("partial-freshness marker on aggregate chat reads", () => {
  const RESULTS = {
    ListChatChannelsResult: () => ({ channels: [], fileThreads: [] }),
    ListPersonalChatFeedResult: () => ({ items: [] }),
    ListChatFileMentionsResult: () => ({ mentions: [] }),
  } as const;

  it("carries the remainder when a pass left rows, and omits it when none", () => {
    const parsed = ListChatChannelsResult.parse({
      ...RESULTS.ListChatChannelsResult(),
      sharedChannelRowsUncovered: 24,
    });
    expect(parsed.sharedChannelRowsUncovered).toBe(24);
    expect(
      ListChatChannelsResult.parse(RESULTS.ListChatChannelsResult())
        .sharedChannelRowsUncovered,
    ).toBeUndefined();
  });

  it("refuses a zero remainder, on every surface that reports one", () => {
    for (const [name, base] of Object.entries(RESULTS)) {
      const schema = { ListChatChannelsResult, ListPersonalChatFeedResult, ListChatFileMentionsResult }[
        name as keyof typeof RESULTS
      ];
      expect(
        () => schema.parse({ ...base(), sharedChannelRowsUncovered: 0 }),
        `${name}: "0 rows uncovered" is a full refresh reported as a partial one`,
      ).toThrow();
    }
  });
});

describe("live document artifact asset IPC", () => {
  it("carries a representative image above the former 48 KiB seed boundary", () => {
    const bytes = new Uint8Array(49 * 1024);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const parsed = ReadEngineYDocArtifactAssetResult.parse({
      descriptor: {
        id: "image-file",
        mimeType: "image/png",
        created: 1,
        ref: `assets/excalidraw/${"a".repeat(64)}/${"b".repeat(64)}.png`,
        sha256: "b".repeat(64),
      },
      bytes,
    });
    expect(parsed.bytes.byteLength).toBe(49 * 1024);
    expect(parsed.descriptor.id).toBe("image-file");
  });
});

describe("joined workspace passphrase boundary", () => {
  it("accepts the optional local passphrase and bounds its IPC size", () => {
    expect(
      CloudJoinWorkspacePayload.parse({
        syncCode: "dohc-sync:workspace:http://relay.test",
        rootPath: "/workspace",
        passphrase: "protected-files passphrase",
      }).passphrase,
    ).toBe("protected-files passphrase");
    expect(() =>
      CloudJoinWorkspacePayload.parse({
        syncCode: "dohc-sync:workspace:http://relay.test",
        rootPath: "/workspace",
        passphrase: "x".repeat(4097),
      }),
    ).toThrow();
  });
});

// The share-changes channels cross a boundary between two
// accounts: one side's relay body becomes the other side's review screen, and
// accepting writes into the reviewer's own workspace. Every field is checked
// rather than coerced, and a malformed one is refused whole.
describe("share changes IPC contract", () => {
  const proposal = () => ({
    proposalId: "proposal-1",
    shareId: "share-1",
    proposedByEmail: "recipient@example.com",
    createdAtMs: 1,
    ops: 2,
  });

  // The listing a timer polls. It says who and how many; the file rows come
  // from the one proposal a granter opens.
  it("carries a granter's review listing as counts, with no file rows", () => {
    const parsed = ListShareProposalsResult.parse({ proposals: [proposal()] });
    expect(parsed.proposals[0]?.ops).toBe(2);
    expect(
      Object.keys(parsed.proposals[0] ?? {}).sort(),
      "carrying file rows on the polled listing costs a base resolution " +
        "per file of every open proposal on every tick",
    ).toEqual(["createdAtMs", "ops", "proposalId", "proposedByEmail", "shareId"]);
  });

  it("states a sender it could not name, rather than inventing one", () => {
    expect(
      ListShareProposalsResult.parse({
        proposals: [{ ...proposal(), proposedByEmail: null }],
      }).proposals[0]?.proposedByEmail,
    ).toBeNull();
  });

  it("refuses an operation, a state, or a decision outside its closed set", () => {
    expect(
      () =>
        ListShareProposalsResult.parse({
          proposals: [{ ...proposal(), ops: -1 }],
        }),
      "a negative count renders a review nobody can have",
    ).toThrow();
    expect(() =>
      ListMyShareChangesResult.parse({
        proposals: [{ proposalId: "p", state: "sent", createdAtMs: 1, files: 1 }],
      }),
    ).toThrow();
    expect(() =>
      SettleShareProposalPayload.parse({
        workspaceId: "ws-1",
        proposalId: "p",
        decision: "maybe",
      }),
    ).toThrow();
  });

  // `drifted` decides whether the review warns that the granter's copy moved.
  // A missing flag read as false would hide the warning on every drifted file.
  // Drift is the one thing a review row says that a diff cannot, and it lives
  // on the review read now that the polled listing carries counts.
  it("refuses a file row with no drift answer", () => {
    expect(
      () =>
        ReadShareProposalChangesResult.parse({
          proposedByEmail: null,
          files: [{ opIndex: 0, path: "a.md", operation: "write", afterByteLength: 1 }],
        }),
      "an absent drift flag reads as `not drifted` and hides the warning",
    ).toThrow();
  });

  it("refuses an op index outside one submit's own bound", () => {
    const files = (opIndex: number) => ({
      opIndex,
      path: "docs/a.md",
      operation: "write" as const,
      drifted: false,
      afterByteLength: 7,
    });
    for (const [label, opIndex] of [
      // Dense from 0, so the last valid index is one below the file bound.
      ["the bound itself", MAX_SHARE_PROPOSAL_OPS],
      ["negative", -1],
      ["fractional", 1.5],
    ] as const) {
      expect(
        () =>
          ReadShareProposalChangesResult.parse({
            proposedByEmail: null,
            files: [files(opIndex)],
          }),
        label,
      ).toThrow();
    }
    expect(
      ReadShareProposalChangesResult.parse({
        proposedByEmail: null,
        files: [files(MAX_SHARE_PROPOSAL_OPS - 1)],
      }).files,
    ).toHaveLength(1);
  });

  // Either side of the review may genuinely be absent: a file the granter
  // does not have, a delete that carries no incoming content, and content
  // this surface cannot preview — which must still be reviewable, because a
  // granter has to be able to decline what they cannot read.
  it("carries either side of a change as null", () => {
    expect(
      ReadShareProposalFileContentResult.parse({
        currentText: "before\n",
        incomingText: null,
      }).incomingText,
    ).toBeNull();
    expect(
      ReadShareProposalFileContentResult.parse({
        currentText: null,
        incomingText: "after\n",
      }).currentText,
    ).toBeNull();
  });

  // The review row describes a file without its content, which is what lets
  // one review carry a repository-sized folder. A row that carried text again
  // would put every file's two sides back into the opening read.
  it("states no content on a review row", () => {
    const parsed = ReadShareProposalChangesResult.parse({
      proposedByEmail: "recipient@example.com",
      files: [
        {
          opIndex: 0,
          path: "docs/a.md",
          operation: "delete",
          drifted: true,
          afterByteLength: null,
          currentText: "before\n",
          incomingText: "after\n",
        },
      ],
    });
    expect(
      Object.keys(parsed.files[0] ?? {}).sort(),
      "carrying text on the row restores the eager read this bound depends on",
    ).toEqual(["afterByteLength", "drifted", "opIndex", "operation", "path"]);
  });

  // The recipient names a workspace and nothing else. A share id on the wire
  // would be a client claiming which grant it is writing through.
  it("takes no share id from the renderer on either recipient channel", () => {
    expect(
      Object.keys(SubmitShareChangesPayload.parse({ workspaceId: "ws-1", shareId: "share-9" })),
    ).toEqual(["workspaceId"]);
    expect(
      Object.keys(
        WithdrawShareChangesPayload.parse({
          workspaceId: "ws-1",
          proposalId: "p",
          shareId: "share-9",
        }),
      ).sort(),
    ).toEqual(["proposalId", "workspaceId"]);
  });

  // Zero is the honest answer for "nothing was pending", not an error.
  it("carries an empty submit", () => {
    const empty = {
      ok: true as const,
      submitted: 0,
      capturedLocalChanges: 0,
      skippedOutsideShare: 0,
      morePending: false,
    };
    expect(SubmitShareChangesResult.parse(empty)).toMatchObject({
      submitted: 0,
      capturedLocalChanges: 0,
    });
    expect(() =>
      SubmitShareChangesResult.parse({ ...empty, submitted: -1 }),
    ).toThrow();
    expect(() =>
      SubmitShareChangesResult.parse({ ...empty, capturedLocalChanges: -1 }),
    ).toThrow();
    expect(() =>
      SubmitShareChangesResult.parse({
        ok: true,
        submitted: 0,
        skippedOutsideShare: 0,
        morePending: false,
      }),
    ).toThrow();
  });

  it("carries captured local changes when the relay submit fails", async () => {
    const result = await resolveSubmitShareChangesResult(3, async () => {
      throw new Error("relay failed");
    });

    expect(result).toEqual({
      ok: false,
      capturedLocalChanges: 3,
      errorMessage: "relay failed",
    });
  });

  // The bound that decides whether a review can be read at all. `incomingText`
  // is validated by the EDITOR's text bound, so main must guard the blob it
  // fetches with the same number — a larger guard admits a body this schema
  // then refuses, and one unreadable file takes every other file in the
  // review down with it.
  it("refuses an incoming side over the editor's text bound, and admits one at it", () => {
    const row = (incomingText: string) => ({
      currentText: null,
      incomingText,
    });
    expect(
      () =>
        ReadShareProposalFileContentResult.parse(
          row("x".repeat(WORKSPACE_TEXT_EDITOR_MAX_BYTES + 1)),
        ),
      "guarding at a LARGER bound sends a body this schema refuses",
    ).toThrow();
    expect(
      ReadShareProposalFileContentResult.parse(
        row("x".repeat(WORKSPACE_TEXT_EDITOR_MAX_BYTES)),
      ).incomingText?.length,
    ).toBe(WORKSPACE_TEXT_EDITOR_MAX_BYTES);
    // Bytes, not characters. One "é" is two bytes in UTF-8, so a string of
    // exactly the bound in characters is twice the bound in bytes — and a
    // guard that counted characters would admit a body the relay then refuses.
    expect(
      () =>
        ReadShareProposalFileContentResult.parse(
          row("é".repeat(WORKSPACE_TEXT_EDITOR_MAX_BYTES)),
        ),
      "counting characters instead of bytes doubles the real bound",
    ).toThrow();
  });

  // What a submit left behind is not optional. Softened to a default, a
  // recipient is told everything went when some of it did not.
  it("refuses a submit result that does not say what it left behind", () => {
    expect(() =>
      SubmitShareChangesResult.parse({
        ok: true,
        submitted: 1,
        morePending: false,
      }),
    ).toThrow();
    expect(() =>
      SubmitShareChangesResult.parse({
        ok: true,
        submitted: 1,
        skippedOutsideShare: 0,
      }),
    ).toThrow();
  });

  // Withdraw has exactly one successful outcome. A result that could carry
  // `accepted` would let the reverse path report the forward one.
  it("refuses any withdraw result but withdrawn", () => {
    expect(WithdrawShareChangesResult.parse({ state: "withdrawn" }).state).toBe(
      "withdrawn",
    );
    expect(
      () => WithdrawShareChangesResult.parse({ state: "accepted" }),
      "a widened withdraw result tells the sender their changes are back when the granter has them",
    ).toThrow();
  });

  it("refuses a malformed payload rather than coercing it", () => {
    for (const payload of [
      { workspaceId: "" },
      { workspaceId: "Not A Workspace" },
      { workspaceId: 1 },
      {},
      null,
    ]) {
      expect(() => ListShareProposalsPayload.parse(payload), JSON.stringify(payload)).toThrow();
      expect(() => ListMyShareChangesPayload.parse(payload), JSON.stringify(payload)).toThrow();
      expect(() => SubmitShareChangesPayload.parse(payload), JSON.stringify(payload)).toThrow();
    }
    expect(() =>
      WithdrawShareChangesPayload.parse({ workspaceId: "ws-1", proposalId: "" }),
    ).toThrow();
    expect(() =>
      WithdrawShareChangesPayload.parse({ workspaceId: "ws-1", proposalId: "p".repeat(129) }),
    ).toThrow();
  });
});

describe("one driver id, every contract on its path", () => {
  // A driver id is declared in a manifest, stored in workspace settings,
  // listed in the agent panel, and then handed back to main with the task it
  // is meant to run. One tighter bound anywhere on that path refuses a driver
  // dohc itself offered, chose, and probed — which is what the try-in-version
  // payload used to do at 100 characters while every other layer took 120.
  const atCap = "d".repeat(DEFAULT_DRIVER_ID_MAX_LENGTH);
  const overCap = "d".repeat(DEFAULT_DRIVER_ID_MAX_LENGTH + 1);

  function panelWith(driverId: string) {
    return {
      drivers: [
        {
          id: driverId,
          displayName: "Fixture Harness",
          installed: true,
          auth: { status: "unknown" as const },
          models: [],
        },
      ],
      session: null,
      selectedDriverId: driverId,
    };
  }

  function manifestWith(driverId: string) {
    return {
      version: 1,
      name: "driver-plugin",
      entry: "plugin.mjs",
      drivers: [{ id: driverId, displayName: "Fixture Harness" }],
    };
  }

  it("carries an id at the cap through every contract on the path", () => {
    expect(DohcPluginManifest.safeParse(manifestWith(atCap)).success).toBe(true);
    expect(AgentPanelSnapshotResult.parse(panelWith(atCap)).selectedDriverId)
      .toBe(atCap);
    expect(
      TryInWorkspaceVersionPayload.parse({
        workspaceId: "ws-try",
        task: "tidy the notes",
        driverId: atCap,
      }).driverId,
      "the try payload keeps a tighter bound: the panel offers this driver, the dialog posts it, and this one boundary refuses it.",
    ).toBe(atCap);
  });

  it("refuses an id past the cap in every contract on the path", () => {
    expect(DohcPluginManifest.safeParse(manifestWith(overCap)).success).toBe(false);
    expect(AgentPanelSnapshotResult.safeParse(panelWith(overCap)).success)
      .toBe(false);
    expect(
      TryInWorkspaceVersionPayload.safeParse({
        workspaceId: "ws-try",
        task: "tidy the notes",
        driverId: overCap,
      }).success,
    ).toBe(false);
  });

  it("carries a driver display name at its bound to the renderer", () => {
    const name = "n".repeat(120);
    expect(DohcPluginManifest.safeParse({
      version: 1,
      name: "driver-plugin",
      entry: "plugin.mjs",
      drivers: [{ id: "fixture-harness", displayName: name }],
    }).success).toBe(true);
    expect(
      AgentPanelSnapshotResult.parse({
        drivers: [
          {
            id: "fixture-harness",
            displayName: name,
            installed: true,
            auth: { status: "unknown" as const },
            models: [],
          },
        ],
        session: null,
        selectedDriverId: "fixture-harness",
      }).drivers[0]?.displayName,
      "the two display-name bounds drift apart: a manifest dohc accepts names a driver the panel cannot describe.",
    ).toBe(name);
  });
});
