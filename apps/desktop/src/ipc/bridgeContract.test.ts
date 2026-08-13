import { describe, expect, it } from "vitest";
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
  DatabaseSnapshotResult,
  DesktopMarksResult,
  CreateFileChatPayload,
  CreateWorkspaceVersionPayload,
  EngineMomentDetailRecord,
  ApplyEngineYDocUpdatePayload,
  OpenEngineYDocSessionResult,
  ExportDocumentFilePayload,
  ExportDocumentFileResult,
  InvokeSiteSdkPayload,
  ListEngineMomentsPayload,
  ListEngineMomentsResult,
  WorkspaceSummary,
  ListFileChatsPayload,
  PRESENCE_STATE_MAX_BYTES,
  SITE_SDK_PARAMS_MAX_BYTES,
  SITE_SDK_PARAMS_MAX_DEPTH,
  SITE_SDK_PARAMS_MAX_VALUES,
  PresencePublishPayload,
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
  ListWorkspaceVersionsResult,
  ResolveWorkspaceVersionConflictPayload,
  SwitchWorkspaceVersionPayload,
  TryInVersionRunState,
  TryInVersionStateResult,
  TryInWorkspaceVersionPayload,
  GetWorkspaceUiStateResult,
  WorkspaceUiState,
  WorkspaceGraphResult,
  WorkspaceVersionConflict,
  ListSitesResult,
  SetUserSettingsPayload,
  SetWorkspaceSettingsPayload,
  StartSitePreviewPayload,
  StartSitePreviewResult,
  StopSitePreviewPayload,
  UpdateActionResult,
  UpdateCheckResult,
  UpdateStateEvent,
  WriteClipboardTextPayload,
  ReadWorkspaceTextResult,
  WriteWorkspaceTextPayload,
  WriteWorkspaceTextResult,
  parseInvokeSiteSdkPayloadForIpc,
} from "./bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import {
  MAX_EDITOR_GROUPS,
  MAX_EDITOR_GROUP_ID_CHARS,
} from "../renderer/workbench/workbenchState";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";

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
      }),
    ).toMatchObject({ pending: [request] });
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
          authorDisplayName: "Ice",
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
              authorDisplayName: "Ice",
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
          },
        ],
      }).tables[0]?.rows[0],
    ).toEqual({ "task title": "Ship Zod 4", priority: 1, done: false });

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
      SetUserSettingsPayload.parse({ settings: DEFAULT_USER_SETTINGS }).settings
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
        settings: {
          ...DEFAULT_USER_SETTINGS,
          secretToken: "nope",
        },
      }).success,
    ).toBe(false);
    expect(
      SetUserSettingsPayload.safeParse({
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
    expect(StopAgentRunPayload.parse({ workspaceId: "ws-settings" })).toEqual({
      workspaceId: "ws-settings",
    });
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
        liveRun: true,
        pendingCount: 2,
        paused: false,
      }),
    ).toEqual({ liveRun: true, pendingCount: 2, paused: false });
    expect(
      ChatDispatchStateForThreadResult.safeParse({
        liveRun: false,
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
        completed: false,
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
            buildOutputs: ["dist"],
            sourceFiles: ["client-portal/index.html", "client-portal/package.json"],
            shareManifest: null,
            diagnostics: [],
            authority: { kind: "workspace" },
          },
        ],
      }).sites[0]?.root,
    ).toBe("client-portal");
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
            buildOutputs: [],
            sourceFiles: [],
            shareManifest: null,
            diagnostics: [],
            authority: { kind: "workspace" },
          },
        ],
      }).sites[0]?.entryPath,
    ).toBeNull();
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
      buildOutputs: [],
      sourceFiles: ["shared-with-me/alex/report/index.html"],
      shareManifest: {
        entryPath: "shared-with-me/alex/report/index.html",
        assets: [],
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
        sdkScopeRoot: null,
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
        sdkScopeRoot: "shared-with-me/alex",
      }).logs,
    ).toEqual([]);
    expect(
      StopSitePreviewPayload.parse({
        workspaceId: "ws-sites",
        siteRoot: ".",
      }),
    ).toEqual({ workspaceId: "ws-sites", siteRoot: "." });
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
      }).success,
    ).toBe(true);
    expect(
      StartSitePreviewResult.safeParse({
        siteRoot: "site",
        mode: "static",
        url: "http://[::1]:43210/",
        logs: [],
      }).success,
    ).toBe(true);
    expect(
      StartSitePreviewResult.safeParse({
        siteRoot: "site",
        mode: "static",
        url: "http://[::ffff:127.0.0.1]:43210/",
        logs: [],
      }).success,
    ).toBe(true);
    expect(
      StartSitePreviewResult.safeParse({
        siteRoot: "site",
        mode: "static",
        url: "http://127.0.0.1/",
        logs: [],
      }).success,
    ).toBe(true);
    expect(
      StartSitePreviewResult.safeParse({
        siteRoot: "site",
        mode: "static",
        url: "http://127.42.0.7:43210/",
        logs: [],
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
        }).success,
      ).toBe(false);
    }
  });

  it("accepts realistic JSON-safe SDK params at the preload IPC boundary", () => {
    const text = "x".repeat(2 * 1024 * 1024);
    expect(
      parseInvokeSiteSdkPayloadForIpc({
        workspaceId: "ws-sites",
        siteRoot: "report",
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
      workspaceId: "ws-sites",
      siteRoot: "report",
      method: "files.write",
    };
    const oversized = {
      ...base,
      params: { text: "x".repeat(SITE_SDK_PARAMS_MAX_BYTES + 1) },
    };
    expect(() => parseInvokeSiteSdkPayloadForIpc(oversized)).toThrow(/JSON-safe/);
    expect(
      InvokeSiteSdkPayload.safeParse({
        ...base,
        params: oversized.params,
      }).success,
    ).toBe(false);

    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let depth = 0; depth <= SITE_SDK_PARAMS_MAX_DEPTH; depth += 1) {
      const child: Record<string, unknown> = {};
      deep.child = child;
      deep = child;
    }
    expect(InvokeSiteSdkPayload.safeParse({ ...base, params: root }).success).toBe(false);

    expect(
      InvokeSiteSdkPayload.safeParse({
        ...base,
        params: Array.from({ length: SITE_SDK_PARAMS_MAX_VALUES }, () => null),
      }).success,
    ).toBe(false);
  });

  it("rejects SDK params that are not a finite, acyclic JSON data tree", () => {
    const base = {
      workspaceId: "ws-sites",
      siteRoot: "report",
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
      expect(InvokeSiteSdkPayload.safeParse({ ...base, params }).success).toBe(false);
    }
  });
});

describe("workspace versions IPC contract (PR 0M-4)", () => {
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

describe("try-in-version IPC contract (PR 0N-2)", () => {
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
        driverId: "codex-app-server",
      }).driverId,
    ).toBe("codex-app-server");
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

describe("sync status IPC contract (#505, #540)", () => {
  it("refuses a status that cannot say why history is off", () => {
    const status = {
      state: "synced",
      pendingChangeCount: 0,
      lastSyncedAtMs: null,
      historyRecordingUnavailable: false,
      historyShareView: false,
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
    // Both cause fields are REQUIRED where their neighbours are optional: an
    // omitted boolean would read as "the user chose this", which is the false
    // cause #505 (build failure) and #540 (shared view) exist to kill.
    const { historyRecordingUnavailable: _dropped, ...withoutFailureCause } = status;
    expect(SyncStatusResult.safeParse(withoutFailureCause).success).toBe(false);
    const { historyShareView: _alsoDropped, ...withoutShareCause } = status;
    expect(SyncStatusResult.safeParse(withoutShareCause).success).toBe(false);
  });
});

describe("engine history and linked Chats IPC contract (PR 0M-5)", () => {
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
    });
    expect(page.moments[0].summary).toBe("Reconciled offline edits");
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
        threadId: "thread_1",
        body: "",
      }).success,
    ).toBe(false);
    expect(
      SendChatMessagePayload.safeParse({
        workspaceId: "ws-engine",
        threadId: "thread_1",
        body: "x".repeat(65_537),
      }).success,
    ).toBe(false);
  });

  it("round-trips a sent chat message with main-derived authorship", () => {
    const result = SendChatMessageResult.parse({
      message: {
        id: "message_1",
        threadId: "thread_1",
        authorKind: "human",
        authorDisplayName: "You",
        body: "First message",
        createdAtMs: 100,
      },
    });
    expect(result.message.authorKind).toBe("human");
    // The agent author kind is a first-class wire value (rendered as
    // "<User Name>\'s agent" in the UI).
    expect(
      SendChatMessageResult.parse({
        message: {
          id: "message_2",
          threadId: "thread_1",
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
      threadId: "thread_1",
      messageId: "message_1",
      emoji,
      state: "added",
    });
  }

  it("accepts real emoji graphemes, including multi-codepoint ones", () => {
    // Simple pictographic, variation-selector, skin-tone modifier, a flag (two
    // regional indicators), and a ZWJ sequence — all one grapheme cluster.
    for (const emoji of ["👍", "❤️", "👍🏽", "🇺🇸", "👨‍👩‍👧", "🏳️‍🌈"]) {
      expect(setPayload(emoji).success, emoji).toBe(true);
    }
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
      "x".repeat(40),
    ]) {
      expect(setPayload(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("applies the same validation to a ChatReactionRecord's emoji", () => {
    const base = {
      reactionId: "r1",
      messageId: "message_1",
      threadId: "thread_1",
      authorId: "author-1",
      authorKind: "human" as const,
      authorDisplayName: "You",
    };
    expect(ChatReactionRecord.safeParse({ ...base, emoji: "🎉" }).success).toBe(true);
    expect(ChatReactionRecord.safeParse({ ...base, emoji: "not-an-emoji" }).success).toBe(false);
  });
});

describe("presence state size cap (MU-C5 DoS boundary)", () => {
  function publishPayload(state: unknown) {
    return PresencePublishPayload.safeParse({
      scope: { kind: "workspace", workspaceId: "ws-1" },
      topic: "chat:thread_1",
      clientId: "client-1",
      state,
    });
  }

  it("accepts legitimate small display state", () => {
    expect(publishPayload({ displayName: "Ada", typing: true }).success).toBe(true);
  });

  it("accepts an absent state (a leave / heartbeat with no payload)", () => {
    const result = PresencePublishPayload.safeParse({
      scope: { kind: "workspace", workspaceId: "ws-1" },
      topic: "chat:thread_1",
      clientId: "client-1",
      leave: true,
    });
    expect(result.success).toBe(true);
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

  // AUDIT-SILENTSAVE round 2 (D1). The engine Y.Doc apply-update handler is a
  // hardened boundary: for an unknown, foreign, or read-only-shared session it
  // must be an INERT NO-OP that never throws. Zod runs before the session
  // lookup, so a REQUIRED seq would reject a hostile/legacy caller with an
  // exception and convert that silent refusal into a throwing one. The
  // e2e that pins the refusal (workspace-shares.spec.ts) cannot run without
  // share infrastructure, so the contract is pinned here instead.
  it("accepts a payload with no seq, defaulting it, so the boundary cannot throw", () => {
    const parsed = ApplyEngineYDocUpdatePayload.parse({
      sessionId: "shared-view-bypass",
      update: new Uint8Array([1, 2, 3]),
    });
    expect(parsed.seq).toBe(0);
  });

  it("keeps a supplied seq and still rejects a nonsense one", () => {
    expect(
      ApplyEngineYDocUpdatePayload.parse({
        sessionId: "s",
        update: new Uint8Array([1]),
        seq: 7,
      }).seq,
    ).toBe(7);
    expect(() =>
      ApplyEngineYDocUpdatePayload.parse({
        sessionId: "s",
        update: new Uint8Array([1]),
        seq: -1,
      }),
    ).toThrow();
  });
});

// A refusal is data the engine PERSISTS into the registry and this schema
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
    rootPath: "/home/ice/dohc/shared",
    kind: "personal" as const,
    mode: "local-first" as const,
    shareView: {
      shareId: "share-1",
      granterEmail: "granter@dohc.test",
      grantedSelector: { paths: ["docs"], versionId: null },
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
      "MUTATION: an empty op kind reaches the registry and the listing that reads it back",
    ).toThrow();
    expect(
      () => WorkspaceSummary.parse(summary("k".repeat(200))),
      "MUTATION: an oversized op kind reaches the registry and breaks every later listing",
    ).toThrow();
  });
});

// #718: aggregate chat reads answer from the local store after ONE bounded
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
        `MUTATION (${name}): "0 rows uncovered" is a full refresh reported as a partial one`,
      ).toThrow();
    }
  });
});
