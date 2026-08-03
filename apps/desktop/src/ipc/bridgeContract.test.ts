import { describe, expect, it } from "vitest";
import {
  ChatChannelRecord,
  ChatAttachmentRecord,
  ChatBookmarkRecord,
  ChatFileReferenceInput,
  ChannelThreadRecord,
  ChatRunRecordsForThreadResult,
  ChatDispatchStateForThreadPayload,
  ChatDispatchStateForThreadResult,
  ChatReactionRecord,
  CreateFileChatPayload,
  CreateWorkspaceVersionPayload,
  EngineMomentDetailRecord,
  ApplyEngineYDocUpdatePayload,
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
  StartDmPayload,
  SyncStatusResult,
  ListWorkspaceVersionsResult,
  ResolveWorkspaceVersionConflictPayload,
  SwitchWorkspaceVersionPayload,
  TryInVersionRunState,
  TryInVersionStateResult,
  TryInWorkspaceVersionPayload,
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
  parseInvokeSiteSdkPayloadForIpc,
} from "./bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";

describe("chat IPC contract", () => {
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
    version: 1,
    activeView: "explorer",
    sidebarVisible: true,
    sidebarWidth: 320,
    tabs: ["notes/a.md"],
    activeTab: "notes/a.md",
    chatsVisible: true,
  };

  it("drops invalid open editor heights without rejecting the saved state", () => {
    for (const openEditorsHeight of [7, "tall"]) {
      const parsed = WorkspaceUiState.parse({ ...validState, openEditorsHeight });
      const height: number | undefined = parsed.openEditorsHeight;
      expect(height).toBeUndefined();
    }
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
    };
    expect(SyncStatusResult.safeParse(status).success).toBe(true);
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
