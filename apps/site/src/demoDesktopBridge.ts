import type { SearchResultsEvent, SearchResultsEventEntry } from "../../desktop/src/ipc/channels";
import type { DohcDesktopBridge } from "../../desktop/src/ipc/bridgeContract";

export type DemoBridgeDocument = {
  path: string;
  title: string;
  body: string;
};

type DemoBridgeContext = {
  documents: DemoBridgeDocument[];
  createFile: (path: string) => void;
  createFolder: (path: string) => void;
  movePath: (fromPath: string, toPath: string) => void;
  deletePath: (path: string) => void;
};

let context: DemoBridgeContext = {
  documents: [],
  createFile: () => undefined,
  createFolder: () => undefined,
  movePath: () => undefined,
  deletePath: () => undefined,
};

const searchListeners = new Set<(batch: SearchResultsEvent) => void>();
const activityListeners = new Set<() => void>();
const now = Date.now();

function searchEntries(query: string, caseSensitive: boolean): SearchResultsEventEntry[] {
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  if (!needle.trim()) return [];
  const entries: SearchResultsEventEntry[] = [];
  for (const document of context.documents) {
    const lines = `${document.title}\n${document.body}`.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const preview = lines[index] ?? "";
      const haystack = caseSensitive ? preview : preview.toLocaleLowerCase();
      const matchStart = haystack.indexOf(needle);
      if (matchStart === -1) continue;
      entries.push({
        path: document.path,
        line: index + 1,
        column: matchStart + 1,
        preview: preview.slice(0, 250),
        matchStart,
        matchEnd: matchStart + needle.length,
        surface: "file",
      });
      if (entries.length >= 48) return entries;
    }
  }
  return entries;
}

function channel(id: string, name: string, kind: "channel" | "agent" = "channel") {
  return {
    id,
    name,
    slug: name.toLocaleLowerCase().replace(/\s+/g, "-"),
    kind,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 120_000,
    threadCount: 1,
    unreadCount: kind === "agent" ? 1 : 0,
  } as const;
}

function thread(channelId = "channel-general", body = "What should we focus on next?") {
  return {
    id: `thread-${channelId}`,
    title: body,
    createdAtMs: now - 3_600_000,
    updatedAtMs: now - 120_000,
    channelId,
    messageCount: 2,
    lastReadSequence: 1,
    unreadCount: channelId === "channel-agent" ? 1 : 0,
    openDecisionCount: 0,
    openingMessage: {
      id: `message-${channelId}-1`,
      authorKind: "human" as const,
      authorDisplayName: "You",
      bodySnippet: body,
      createdAtMs: now - 3_600_000,
      reactions: [],
    },
  };
}

function message(threadId: string, id: string, body: string, agent = false) {
  return {
    id,
    threadId,
    authorKind: agent ? ("agent" as const) : ("human" as const),
    authorDisplayName: "You",
    body,
    createdAtMs: agent ? now - 90_000 : now - 3_600_000,
  };
}

const demoBridge = {
  onSearchResults(listener: (batch: SearchResultsEvent) => void) {
    searchListeners.add(listener);
    return () => searchListeners.delete(listener);
  },
  async searchWorkspace(payload: {
    searchId: string;
    query: string;
    caseSensitive: boolean;
  }) {
    const batch: SearchResultsEvent = {
      searchId: payload.searchId,
      entries: searchEntries(payload.query, payload.caseSensitive),
      done: true,
      limitHit: false,
    };
    queueMicrotask(() => searchListeners.forEach((listener) => listener(batch)));
  },
  async cancelWorkspaceSearch() {},
  async readWorkspaceGraph() {
    const nodes = context.documents.map((document, index) => ({
      path: document.path,
      title: document.title,
      incoming: index === 0 ? Math.max(0, context.documents.length - 1) : 1,
      outgoing: index === 0 ? Math.max(0, context.documents.length - 1) : 1,
    }));
    const edges = context.documents.slice(1).map((document) => ({
      source: context.documents[0]?.path ?? document.path,
      target: document.path,
      kind: "wikilink" as const,
    }));
    return {
      nodes,
      edges,
      unresolvedLinks: 0,
      scannedFileCount: nodes.length,
      omittedFileCount: 0,
      truncatedFileCount: 0,
    };
  },
  async listSites() {
    return {
      sites: [
        {
          root: "sites/launch-room",
          title: "Launch room",
          kind: "configured" as const,
          confidence: "high" as const,
          entryPath: "projects/launch-plan.md",
          configPath: "sites/launch-room/site.yaml",
          packagePath: null,
          packageManager: null,
          scripts: { build: "dohc site build" },
          buildOutputs: ["dist"],
          sourceFiles: ["projects/launch-plan.md"],
          diagnostics: [],
        },
      ],
    };
  },
  async createWorkspaceFile(payload: { relativePath: string }) {
    context.createFile(payload.relativePath);
    activityListeners.forEach((listener) => listener());
    return { path: payload.relativePath };
  },
  async createWorkspaceFolder(payload: { relativePath: string }) {
    context.createFolder(payload.relativePath);
    return { path: payload.relativePath };
  },
  async moveWorkspacePath(payload: { fromPath: string; toPath: string }) {
    context.movePath(payload.fromPath, payload.toPath);
    return { fromPath: payload.fromPath, toPath: payload.toPath };
  },
  async deleteWorkspacePath(payload: { relativePath: string }) {
    context.deletePath(payload.relativePath);
    return { path: payload.relativePath };
  },
  async showExplorerMenu() {
    return null;
  },
  async exportWorkspaceZip() {
    return { filePath: "demo-workspace.zip" };
  },
  async getDroppedFilePaths() {
    return [];
  },
  onWorkspaceActivity(listener: () => void) {
    activityListeners.add(listener);
    return () => activityListeners.delete(listener);
  },
  async listChatChannels() {
    return {
      channels: [
        channel("channel-agent", "My agent", "agent"),
        channel("channel-general", "general"),
        channel("channel-projects", "projects"),
      ],
      fileThreads: [
        {
          id: "thread-file-launch",
          title: "Launch plan review",
          createdAtMs: now - 7_200_000,
          updatedAtMs: now - 7_200_000,
          path: "projects/launch-plan.md",
        },
      ],
    };
  },
  async listChatChannelShares() {
    return { granted: [], received: [], joined: [] };
  },
  async syncDms() {
    return { available: false, dms: [] };
  },
  async listChannelThreads(payload: { channelId: string }) {
    const body =
      payload.channelId === "channel-agent"
        ? "Turn this week into a clear, inspectable plan."
        : payload.channelId === "channel-projects"
          ? "The launch checklist is ready for review."
          : "What should we focus on next?";
    return { threads: [thread(payload.channelId, body)], viewerAuthorId: "demo-user" };
  },
  async listChatMessages(payload: { threadId: string }) {
    return {
      messages: [
        message(payload.threadId, `${payload.threadId}-1`, "What should we focus on next?"),
        message(
          payload.threadId,
          `${payload.threadId}-2`,
          "I’d start with the launch plan, then turn the final checklist into a reusable skill.",
          true,
        ),
      ],
    };
  },
  async listChatReactions() {
    return { reactions: [], viewerAuthorId: "demo-user" };
  },
  async listChatThreadDecisions() {
    return { decisions: [] };
  },
  async listChatThreadAttachments() {
    return { attachments: [] };
  },
  async chatRunRecordsForThread() {
    return { runs: {} };
  },
  async chatDispatchStateForThread() {
    return { liveRun: false, pendingCount: 0, paused: false };
  },
  async markChatThreadRead() {
    return { lastReadSequence: 2, revision: 1 };
  },
  async createChatChannel(payload: { name: string }) {
    return { channel: channel(`channel-${Date.now()}`, payload.name) };
  },
  async startChannelThread(payload: { channelId: string; body: string }) {
    const nextThread = thread(payload.channelId, payload.body);
    return {
      thread: nextThread,
      message: message(nextThread.id, `message-${Date.now()}`, payload.body),
    };
  },
  async sendChatMessage(payload: { threadId: string; body: string }) {
    return { message: message(payload.threadId, `message-${Date.now()}`, payload.body) };
  },
  async setChatReaction() {
    return { reaction: null, viewerAuthorId: "demo-user" };
  },
  async resolveChatDecision() {
    throw new Error("No open decision in the demo");
  },
  async stopAgentRun() {},
  async resumeThreadDispatch() {},
  async writeClipboardText() {},
  async shareChatChannel() {
    return { share: null };
  },
  async joinSharedChannel() {},
  async leaveSharedChannel() {},
  async revokeRelayShare() {},
  async startDm() {
    throw new Error("Direct messages are unavailable in the demo");
  },
} as unknown as DohcDesktopBridge;

export function configureDemoDesktopBridge(next: DemoBridgeContext): void {
  context = next;
  window.dohcDesktop = demoBridge;
}
