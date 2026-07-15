import type { SearchResultsEvent, SearchResultsEventEntry } from "../../desktop/src/ipc/channels";
import type { DohcDesktopBridge } from "../../desktop/src/ipc/bridgeContract";
import {
  collectWorkspacePaths,
  findFileAncestor,
  isPathAtOrBelow,
  planDemoPathMove,
  rewritePathPrefix,
} from "./demoWorkspacePaths";

export type DemoBridgeDocument = {
  path: string;
  title: string;
  body: string;
};

type DemoBridgeContext = {
  documents: DemoBridgeDocument[];
  folders: string[];
  createFile: (path: string) => void;
  createFolder: (path: string) => void;
  movePath: (fromPath: string, toPath: string) => void;
  deletePath: (path: string) => void;
};

let context: DemoBridgeContext = {
  documents: [],
  folders: [],
  createFile: () => undefined,
  createFolder: () => undefined,
  movePath: () => undefined,
  deletePath: () => undefined,
};

const searchListeners = new Set<(batch: SearchResultsEvent) => void>();
const activityListeners = new Set<() => void>();
const assetUrls = new Map<string, string>();
const ASSET_DB_NAME = "dohc-marketing-demo";
const ASSET_STORE_NAME = "workspace-assets";
export const DEMO_ASSET_PERSISTENCE_EVENT =
  "dohc-demo-asset-persistence-unavailable";
const now = Date.now();
let assetPersistenceAvailable =
  typeof window !== "undefined" && "indexedDB" in window;

type StoredDemoAsset = {
  path: string;
  mediaType: string;
  bytes: ArrayBuffer;
};

function openAssetDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ASSET_DB_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(ASSET_STORE_NAME)) {
        request.result.createObjectStore(ASSET_STORE_NAME, { keyPath: "path" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

function setAssetUrl(path: string, mediaType: string, bytes: ArrayBuffer): void {
  const previous = assetUrls.get(path);
  if (previous) URL.revokeObjectURL(previous);
  assetUrls.set(path, URL.createObjectURL(new Blob([bytes], { type: mediaType })));
}

async function persistAsset(asset: StoredDemoAsset): Promise<void> {
  const database = await openAssetDatabase();
  try {
    const transaction = database.transaction(ASSET_STORE_NAME, "readwrite");
    transaction.objectStore(ASSET_STORE_NAME).put(asset);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function readStoredAssets(): Promise<StoredDemoAsset[]> {
  const database = await openAssetDatabase();
  try {
    const transaction = database.transaction(ASSET_STORE_NAME, "readonly");
    const request = transaction
      .objectStore(ASSET_STORE_NAME)
      .getAll() as IDBRequest<StoredDemoAsset[]>;
    const assets = await new Promise<StoredDemoAsset[]>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    await transactionDone(transaction);
    return assets;
  } finally {
    database.close();
  }
}

async function rewriteStoredAssets(
  prefix: string,
  nextPrefix: string | null,
): Promise<void> {
  const affected = (await readStoredAssets()).filter((asset) =>
    isPathAtOrBelow(asset.path, prefix),
  );
  if (affected.length === 0) return;

  const database = await openAssetDatabase();
  try {
    const transaction = database.transaction(ASSET_STORE_NAME, "readwrite");
    const store = transaction.objectStore(ASSET_STORE_NAME);
    for (const asset of affected) {
      store.delete(asset.path);
      if (nextPrefix !== null) {
        store.put({
          ...asset,
          path: rewritePathPrefix(asset.path, prefix, nextPrefix),
        });
      }
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function markAssetPersistenceUnavailable(error: unknown): void {
  if (!assetPersistenceAvailable) return;
  assetPersistenceAvailable = false;
  console.warn(
    "Demo asset persistence is unavailable; assets will remain in this session only.",
    error,
  );
  window.dispatchEvent(new Event(DEMO_ASSET_PERSISTENCE_EVENT));
}

async function persistAssetMutation(
  mutation: () => Promise<void>,
): Promise<void> {
  if (!assetPersistenceAvailable) return;
  try {
    await mutation();
  } catch (error) {
    markAssetPersistenceUnavailable(error);
  }
}

function rewriteAssetUrls(prefix: string, nextPrefix: string | null): void {
  const affected = [...assetUrls.entries()].filter(([path]) =>
    isPathAtOrBelow(path, prefix),
  );
  for (const [path] of affected) assetUrls.delete(path);
  for (const [path, url] of affected) {
    if (nextPrefix === null) {
      URL.revokeObjectURL(url);
    } else {
      assetUrls.set(rewritePathPrefix(path, prefix, nextPrefix), url);
    }
  }
}

export async function hydrateDemoWorkspaceAssets(): Promise<void> {
  if (!assetPersistenceAvailable) return;
  try {
    const assets = await readStoredAssets();
    for (const asset of assets) {
      setAssetUrl(asset.path, asset.mediaType, asset.bytes);
    }
  } catch (error) {
    markAssetPersistenceUnavailable(error);
  }
}

export function demoWorkspaceAssetsPersistAcrossSessions(): boolean {
  return assetPersistenceAvailable;
}

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
          const files = Array.from(input.files ?? [])
            .slice(0, 20)
            .filter((file) => file.size <= 20 * 1024 * 1024);
          const images = await Promise.all(
            files.map(async (file) => ({
              name: file.name,
              mediaType: file.type || mediaTypeForPath(file.name),
              bytes: new Uint8Array(await file.arrayBuffer()),
            })),
          );
          resolve(images);
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

type DemoDesktopBridge = Pick<
  DohcDesktopBridge,
  | "onSearchResults"
  | "searchWorkspace"
  | "cancelWorkspaceSearch"
  | "readWorkspaceGraph"
  | "listSites"
  | "createWorkspaceFile"
  | "createWorkspaceFolder"
  | "moveWorkspacePath"
  | "deleteWorkspacePath"
  | "showExplorerMenu"
  | "exportWorkspaceZip"
  | "getDroppedFilePaths"
  | "pickImageFiles"
  | "writeWorkspaceAsset"
  | "getWorkspaceSettings"
  | "onWorkspaceActivity"
  | "listChatChannels"
  | "listChatChannelShares"
  | "syncDms"
  | "listChannelThreads"
  | "listChatMessages"
  | "listChatReactions"
  | "listChatThreadDecisions"
  | "listChatThreadAttachments"
  | "chatRunRecordsForThread"
  | "chatDispatchStateForThread"
  | "markChatThreadRead"
  | "createChatChannel"
  | "startChannelThread"
  | "sendChatMessage"
  | "setChatReaction"
  | "resolveChatDecision"
  | "stopAgentRun"
  | "resumeThreadDispatch"
  | "writeClipboardText"
  | "openExternalUrl"
  | "shareChatChannel"
  | "joinSharedChannel"
  | "leaveSharedChannel"
  | "revokeRelayShare"
  | "startDm"
>;

export type DemoSearchOptions = {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  includeGlob?: string;
  excludeGlob?: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globRegExp(glob: string): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? "";
    if (character === "*" && glob[index + 1] === "*") {
      const followedBySlash = glob[index + 2] === "/";
      source += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character);
    }
  }
  return new RegExp(`${source}$`, "i");
}

export function searchDemoDocuments(
  documents: readonly DemoBridgeDocument[],
  options: DemoSearchOptions,
): SearchResultsEventEntry[] {
  if (!options.query.trim()) return [];
  let pattern = options.regex ? options.query : escapeRegExp(options.query);
  if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`;
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, options.caseSensitive ? "u" : "iu");
  } catch {
    return [];
  }
  const include = options.includeGlob ? globRegExp(options.includeGlob) : null;
  const exclude = options.excludeGlob ? globRegExp(options.excludeGlob) : null;
  const entries: SearchResultsEventEntry[] = [];
  for (const document of documents) {
    if (include && !include.test(document.path)) continue;
    if (exclude?.test(document.path)) continue;
    const lines = `${document.title}\n${document.body}`.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const preview = lines[index] ?? "";
      const match = expression.exec(preview);
      if (!match) continue;
      const matchStart = match.index;
      entries.push({
        path: document.path,
        line: index + 1,
        column: matchStart + 1,
        preview: preview.slice(0, 250),
        matchStart,
        matchEnd: matchStart + match[0].length,
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

function thread(channelId = "channel-general", body = "What needs attention next?") {
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

function demoThreadBody(channelId: string): string {
  return channelId === "channel-agent"
    ? "Turn this week's work into a plan I can review."
    : channelId === "channel-projects"
      ? "Review the launch checklist."
      : "What needs attention next?";
}

function message(threadId: string, id: string, body: string, agent = false) {
  return {
    id,
    threadId,
    authorKind: agent ? ("agent" as const) : ("human" as const),
    authorDisplayName: agent ? "Your agent" : "You",
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
      entries: searchDemoDocuments(context.documents, payload),
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
          shareManifest: null,
          diagnostics: [],
          authority: { kind: "workspace" as const },
        },
      ],
    };
  },
  async createWorkspaceFile(payload: { relativePath: string }) {
    const filePaths = context.documents.map((document) => document.path);
    const fileAncestor = findFileAncestor(filePaths, payload.relativePath);
    if (fileAncestor) {
      throw new Error(`A file cannot contain ${payload.relativePath}: ${fileAncestor}`);
    }
    const workspacePaths = collectWorkspacePaths([
      ...filePaths,
      ...context.folders,
    ]);
    if (workspacePaths.includes(payload.relativePath)) {
      throw new Error(`A document already exists at ${payload.relativePath}`);
    }
    context.createFile(payload.relativePath);
    context.documents = [
      ...context.documents,
      { path: payload.relativePath, title: payload.relativePath, body: "" },
    ];
    activityListeners.forEach((listener) => listener());
    return { path: payload.relativePath };
  },
  async createWorkspaceFolder(payload: { relativePath: string }) {
    const filePaths = context.documents.map((document) => document.path);
    const fileAncestor = findFileAncestor(filePaths, payload.relativePath);
    if (fileAncestor) {
      throw new Error(`A file cannot contain ${payload.relativePath}: ${fileAncestor}`);
    }
    const workspacePaths = collectWorkspacePaths([
      ...filePaths,
      ...context.folders,
    ]);
    if (workspacePaths.includes(payload.relativePath)) {
      throw new Error(`A folder already exists at ${payload.relativePath}`);
    }
    context.createFolder(payload.relativePath);
    context.folders = [...context.folders, payload.relativePath];
    return { path: payload.relativePath };
  },
  async moveWorkspacePath(payload: { fromPath: string; toPath: string }) {
    const fileAncestor = findFileAncestor(
      context.documents.map((document) => document.path),
      payload.toPath,
    );
    if (fileAncestor) {
      throw new Error(`A file cannot contain ${payload.toPath}: ${fileAncestor}`);
    }
    const workspacePaths = collectWorkspacePaths([
      ...context.documents.map((document) => document.path),
      ...context.folders,
      ...assetUrls.keys(),
    ]);
    planDemoPathMove(
      workspacePaths,
      payload.fromPath,
      payload.toPath,
    );
    await persistAssetMutation(() =>
      rewriteStoredAssets(payload.fromPath, payload.toPath),
    );
    context.movePath(payload.fromPath, payload.toPath);
    context.documents = context.documents.map((document) => ({
      ...document,
      path: rewritePathPrefix(document.path, payload.fromPath, payload.toPath),
    }));
    context.folders = context.folders.map((folder) =>
      rewritePathPrefix(folder, payload.fromPath, payload.toPath),
    );
    rewriteAssetUrls(payload.fromPath, payload.toPath);
    return { path: payload.toPath };
  },
  async deleteWorkspacePath(payload: { relativePath: string }) {
    const workspacePaths = collectWorkspacePaths([
      ...context.documents.map((document) => document.path),
      ...context.folders,
      ...assetUrls.keys(),
    ]);
    if (!workspacePaths.some((path) => isPathAtOrBelow(path, payload.relativePath))) {
      throw new Error(`No workspace entry exists at ${payload.relativePath}`);
    }
    await persistAssetMutation(() =>
      rewriteStoredAssets(payload.relativePath, null),
    );
    context.deletePath(payload.relativePath);
    context.documents = context.documents.filter(
      (document) => !isPathAtOrBelow(document.path, payload.relativePath),
    );
    context.folders = context.folders.filter(
      (folder) => !isPathAtOrBelow(folder, payload.relativePath),
    );
    rewriteAssetUrls(payload.relativePath, null);
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
    const bytes = new Uint8Array(payload.bytes).buffer;
    const mediaType = mediaTypeForPath(payload.relativePath);
    await persistAssetMutation(() =>
      persistAsset({ path: payload.relativePath, mediaType, bytes }),
    );
    setAssetUrl(payload.relativePath, mediaType, bytes);
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
    return {
      threads: [thread(payload.channelId, demoThreadBody(payload.channelId))],
      viewerAuthorId: "demo-user",
    };
  },
  async listChatMessages(payload: { threadId: string }) {
    const channelId = payload.threadId.replace(/^thread-/, "");
    return {
      messages: [
        message(payload.threadId, `${payload.threadId}-1`, demoThreadBody(channelId)),
        message(
          payload.threadId,
          `${payload.threadId}-2`,
          "Start with the launch plan. Once it is approved, save the checklist as a skill.",
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
  async openExternalUrl(payload: { url: string }) {
    window.open(payload.url, "_blank", "noopener,noreferrer");
  },
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
} satisfies DemoDesktopBridge;

export function configureDemoDesktopBridge(next: DemoBridgeContext): void {
  context = next;
  // The embedded demo deliberately exposes only the bridge methods consumed by
  // DemoSidebar and MarkdownEditor. DemoDesktopBridge makes every consumed
  // method required while keeping the intentionally narrow boundary explicit.
  window.dohcDesktop = demoBridge as unknown as DohcDesktopBridge;
}
