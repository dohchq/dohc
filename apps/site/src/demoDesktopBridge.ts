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
const assetUrls = new Map<string, string>();
const now = Date.now();

function mediaTypeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLocaleLowerCase();
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml",
      avif: "image/avif",
      bmp: "image/bmp",
    }[extension ?? ""] ?? "application/octet-stream"
  );
}

async function pickBrowserImages() {
  return new Promise<Array<{ name: string; mediaType: string; bytes: Uint8Array }>>(
    (resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.addEventListener(
        "change",
        async () => {
          const files = Array.from(input.files ?? []).slice(0, 20);
          const images = await Promise.all(
            files.map(async (file) => ({
              name: file.name,
              mediaType: file.type || mediaTypeForPath(file.name),
              bytes: new Uint8Array(await file.arrayBuffer()),
            })),
          );
          resolve(images.filter((image) => image.bytes.byteLength <= 20 * 1024 * 1024));
        },
        { once: true },
      );
      input.addEventListener("cancel", () => resolve([]), { once: true });
      input.click();
    },
  );
}

export function resolveDemoWorkspaceAssetUrl(workspacePath: string): string | null {
  return assetUrls.get(workspacePath) ?? null;
}

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
  async searchWorkspace(
    payload: Parameters<DohcDesktopBridge["searchWorkspace"]>[0],
  ) {
    const batch: SearchResultsEvent = {
      searchId: payload.searchId,
      entries: searchEntries(payload.query, payload.caseSensitive ?? false),
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
    return { path: payload.toPath };
  },
  async deleteWorkspacePath(payload: { relativePath: string }) {
    context.deletePath(payload.relativePath);
    return { trashed: true };
  },
  async showExplorerMenu() {
    return null;
  },
  async exportWorkspaceZip() {
    return { path: "demo-workspace.zip" };
  },
  getDroppedFilePaths(_files: File[]) {
    return [];
  },
  async pickImageFiles() {
    return { files: await pickBrowserImages() };
  },
  async writeWorkspaceAsset(payload: { relativePath: string; bytes: Uint8Array }) {
    const previous = assetUrls.get(payload.relativePath);
    if (previous) URL.revokeObjectURL(previous);
    const bytes = new Uint8Array(payload.bytes).buffer;
    assetUrls.set(
      payload.relativePath,
      URL.createObjectURL(new Blob([bytes], { type: mediaTypeForPath(payload.relativePath) })),
    );
  },
  async getWorkspaceSettings() {
    return {
      settings: {
        version: 1 as const,
        agents: { mcpAutoStart: false, defaultDriverId: null, defaultModel: null },
        sites: { defaultPreviewMode: "auto" as const },
        privacy: { confirmExternalLinks: true },
        experimental: { workspaceEngineAlpha: true },
        files: { attachmentLocation: "per-document" as const, attachmentFolderName: "assets" },
      },
      source: "default" as const,
    };
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
  async setChatReaction(
    payload: Parameters<DohcDesktopBridge["setChatReaction"]>[0],
  ) {
    return {
      viewerAuthorId: "demo-user",
      reaction: {
        threadId: payload.threadId,
        authorKind: "human" as const,
        authorDisplayName: "You",
        reactionId: `reaction-${payload.messageId}-${payload.emoji}`,
        messageId: payload.messageId,
        emoji: payload.emoji,
        authorId: "demo-user",
        state: payload.state,
      },
    };
  },
  async resolveChatDecision() {
    throw new Error("No open decision in the demo");
  },
  async stopAgentRun() {},
  async resumeThreadDispatch() {},
  async writeClipboardText() {},
  async shareChatChannel() {
    return { shareId: "demo-share" };
  },
  async joinSharedChannel() {
    return {
      joined: {
        shareId: "demo-share",
        channelWireId: "demo-channel",
        access: "read-only" as const,
        granterEmail: null,
        ended: false,
      },
    };
  },
  async leaveSharedChannel() {},
  async revokeRelayShare() {},
  async startDm() {
    throw new Error("Direct messages are unavailable in the demo");
  },
} satisfies Partial<DohcDesktopBridge>;

export function configureDemoDesktopBridge(next: DemoBridgeContext): void {
  context = next;
  // The embedded demo deliberately exposes only the bridge methods consumed by
  // DemoSidebar. `satisfies Partial` type-checks every implemented method while
  // keeping that narrower contract explicit at this integration boundary.
  window.dohcDesktop = demoBridge as unknown as DohcDesktopBridge;
}
