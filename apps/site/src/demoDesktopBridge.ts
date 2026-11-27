import type {
  DeleteWorkspacePathResult,
  DohcDesktopBridge,
  ExplorerMenuCommand,
  ExplorerMenuEntry,
  ReadExplorerMenuPayload,
  SearchResultsEvent,
  SearchResultsEventEntry,
  WorkspaceActivityEvent,
} from "../../desktop/src/ipc/bridgeContract";
import { explorerMenuEntries } from "../../desktop/src/workspaces/explorerMenu";
import {
  collectWorkspacePaths,
  resolveDemoWikilink,
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
  fixedPaths: string[];
  createFile: (path: string) => void;
  createFolder: (path: string) => void;
  movePath: (fromPath: string, toPath: string) => void;
  deletePath: (path: string) => () => void;
};

let context: DemoBridgeContext = {
  documents: [],
  folders: [],
  fixedPaths: [],
  createFile: () => undefined,
  createFolder: () => undefined,
  movePath: () => undefined,
  deletePath: () => () => undefined,
};

type UndoResult = Awaited<ReturnType<DohcDesktopBridge["undoHistoryOperation"]>>;
const deleteUndos = new Map<string, () => Promise<UndoResult>>();

const searchListeners = new Set<(batch: SearchResultsEvent) => void>();
const activityListeners = new Set<(event: WorkspaceActivityEvent) => void>();
const assetUrls = new Map<string, string>();
const ASSET_DB_NAME = "dohc-marketing-demo";
const ASSET_STORE_NAME = "workspace-assets";
export const DEMO_ASSET_PERSISTENCE_EVENT = "dohc-demo-asset-persistence-unavailable";
const now = Date.now();
let assetPersistenceAvailable = typeof window !== "undefined" && "indexedDB" in window;

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
    const request = transaction.objectStore(ASSET_STORE_NAME).getAll() as IDBRequest<
      StoredDemoAsset[]
    >;
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

async function rewriteStoredAssets(prefix: string, nextPrefix: string | null): Promise<void> {
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

async function persistAssetMutation(mutation: () => Promise<void>): Promise<void> {
  if (!assetPersistenceAvailable) return;
  try {
    await mutation();
  } catch (error) {
    markAssetPersistenceUnavailable(error);
  }
}

function rewriteAssetUrls(prefix: string, nextPrefix: string): void {
  const affected = [...assetUrls.entries()].filter(([path]) => isPathAtOrBelow(path, prefix));
  for (const [path] of affected) assetUrls.delete(path);
  for (const [path, url] of affected) {
    assetUrls.set(rewritePathPrefix(path, prefix, nextPrefix), url);
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
  return new Promise<Array<{ name: string; mediaType: string; bytes: Uint8Array }>>((resolve) => {
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
  });
}

export function resolveDemoWorkspaceAssetUrl(workspacePath: string): string | null {
  return assetUrls.get(workspacePath) ?? null;
}

type DemoDesktopBridge = Pick<
  DohcDesktopBridge,
  | "platform"
  | "onLocalAppsChanged"
  | "onSearchResults"
  | "onUpdateState"
  | "getUpdateState"
  | "searchWorkspace"
  | "cancelWorkspaceSearch"
  | "linksEdges"
  | "linksConnections"
  | "createWorkspaceFile"
  | "createWorkspaceFolder"
  | "moveWorkspacePath"
  | "readExplorerMenu"
  | "undoHistoryOperation"
  | "exportWorkspaceZip"
  | "getDroppedFilePaths"
  | "pickImageFiles"
  | "writeWorkspaceAsset"
  | "getWorkspaceSettings"
  | "onWorkspaceActivity"
  | "onCloudSessionChanged"
  | "listChatChannels"
  | "listChatChannelShares"
  | "listJoinedSharedChannels"
  | "directConversations"
  | "workspaceMembers"
  | "listPersonalChatFeed"
  | "onDirectChanged"
  | "listChannelThreads"
  | "listChatMessages"
  | "getChatThreadRevision"
  | "listChatReactions"
  | "listChatThreadDecisions"
  | "listChatThreadAttachments"
  | "chatRunRecordsForThread"
  | "chatDispatchStateForThread"
  | "readChatDispatchPaused"
  | "onChatDispatchPaused"
  | "markChatThreadRead"
  | "createChatChannel"
  | "startChannelThread"
  | "sendChatMessage"
  | "setChatReaction"
  | "stopAgentRun"
  | "resumeThreadDispatch"
  | "openExternalUrl"
  | "shareChatChannel"
  | "joinSharedChannel"
  | "leaveSharedChannel"
  | "revokeRelayShare"
  | "exportDocumentFile"
> & {
  deleteWorkspacePath: (
    payload: Parameters<DohcDesktopBridge["deleteWorkspacePath"]>[0],
  ) => Promise<Omit<DeleteWorkspacePathResult, "trashed">>;
};

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

type DemoAuthor = "you" | "sam" | "priya" | "agent";

const AUTHORS: Record<DemoAuthor, { name: string; kind: "human" | "agent" }> = {
  you: { name: "You", kind: "human" },
  sam: { name: "Sam", kind: "human" },
  priya: { name: "Priya", kind: "human" },
  agent: { name: "Your agent", kind: "agent" },
};

type DemoPost = { author: DemoAuthor; body: string; ageMs: number };

const THREADS: Record<string, DemoPost[]> = {
  "channel-trip": [
    {
      author: "sam",
      body: "Who's sorting the Sintra cottage? It goes fast on weekends.",
      ageMs: 5_400_000,
    },
    {
      author: "priya",
      body: "I'll book it tonight. Jonas and I are in it, so I put us both in Guests.",
      ageMs: 4_800_000,
    },
    {
      author: "you",
      body: "Thanks! Mei still needs a room. I left her as Not booked.",
      ageMs: 600_000,
    },
  ],
  "channel-bookings": [
    {
      author: "you",
      body: "Flat's booked for the 14th to the 17th. Deposit is in Budget.",
      ageMs: 86_400_000,
    },
    { author: "sam", body: "Paid my share. Ticked it in Guests.", ageMs: 80_000_000 },
  ],
  "channel-agent": [
    {
      author: "you",
      body: "Make us a small app with each day's times from the Days pages, and a way to split costs.",
      ageMs: 3_900_000,
    },
    {
      author: "agent",
      body: "Done. It's in trip-planner/index.html, so it shows as Trip planner under Apps. It has the three days from the Days pages and a cost splitter for five people.",
      ageMs: 3_600_000,
    },
  ],
  "file-budget": [{ author: "sam", body: "Who still owes a deposit?", ageMs: 7_200_000 }],
};

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

function presentation(author: DemoAuthor) {
  return { group: `demo-${author}`, hue: null, self: author === "you" };
}

function thread(channelId: string, posts: readonly DemoPost[]) {
  const opening = posts[0] ?? { author: "you" as const, body: "", ageMs: 0 };
  const last = posts.at(-1) ?? opening;
  return {
    id: `thread-${channelId}`,
    title: opening.body,
    createdAtMs: now - opening.ageMs,
    updatedAtMs: now - last.ageMs,
    channelId,
    messageCount: posts.length,
    lastReadSequence: channelId === "channel-agent" ? posts.length - 1 : posts.length,
    unreadCount: channelId === "channel-agent" ? 1 : 0,
    openDecisionCount: 0,
    openingMessage: {
      presentation: presentation(opening.author),
      id: `message-${channelId}-0`,
      authorKind: AUTHORS[opening.author].kind,
      authorDisplayName: AUTHORS[opening.author].name,
      bodySnippet: opening.body,
      createdAtMs: now - opening.ageMs,
      reactions: [],
    },
  };
}

function message(threadId: string, id: string, post: DemoPost) {
  return {
    presentation: presentation(post.author),
    id,
    threadId,
    authorKind: AUTHORS[post.author].kind,
    authorDisplayName: AUTHORS[post.author].name,
    body: post.body,
    createdAtMs: now - post.ageMs,
  };
}

function feedItem(key: string, listed: ReturnType<typeof channel>) {
  const posts = THREADS[key] ?? [];
  const { id, title, createdAtMs, updatedAtMs } = thread(key, posts);
  return {
    message: message(id, `message-${key}-0`, posts[0] ?? yourPost(title)),
    thread: { id, title, createdAtMs, updatedAtMs },
    channel: { id: listed.id, name: listed.name, slug: listed.slug, kind: listed.kind },
    reactions: [],
    matchedBy: [],
  };
}

function yourPost(body: string): DemoPost {
  return { author: "you", body, ageMs: 0 };
}

const WIKILINK = /\[\[([^[\]|#\n]+)(?:[#|][^[\]\n]*)?\]\]/g;

export function demoLinkEdges(documents: readonly DemoBridgeDocument[]) {
  const paths = documents.map((document) => document.path);
  const entries: Array<{ source: string; target: string; kind: "wikilink"; ordinal: number }> = [];
  for (const document of documents) {
    let ordinal = 0;
    for (const match of document.body.matchAll(WIKILINK)) {
      const target = resolveDemoWikilink(paths, match[1] ?? "");
      if (target)
        entries.push({ source: document.path, target, kind: "wikilink", ordinal: ordinal++ });
    }
  }
  return entries;
}

function holdsFixed(fixedPaths: readonly string[], path: string): boolean {
  return fixedPaths.some((fixed) => isPathAtOrBelow(fixed, path));
}

function refuseFixed(path: string): void {
  if (holdsFixed(context.fixedPaths, path)) {
    throw new Error("The demo keeps its app and Collection where they are.");
  }
}

const DEMO_EXPLORER_COMMANDS: ReadonlySet<ExplorerMenuCommand> = new Set([
  "new-file",
  "new-folder",
  "rename",
  "delete",
  "pin",
  "unpin",
]);

export function demoExplorerMenu(
  input: Pick<ReadExplorerMenuPayload, "path" | "kind" | "pinned" | "count">,
  fixedPaths: readonly string[],
): ExplorerMenuEntry[] {
  const fixed = input.path !== undefined && holdsFixed(fixedPaths, input.path);
  const offered = explorerMenuEntries(
    {
      kind: input.kind,
      pinned: input.pinned,
      ...(input.count !== undefined && input.kind !== "root" ? { count: input.count } : {}),
      isMountPath: false,
      hasMountRecord: false,
      canShare: false,
      shareView: null,
    },
    DEMO_PLATFORM,
  ).filter(
    (entry) =>
      entry.kind === "separator" ||
      (DEMO_EXPLORER_COMMANDS.has(entry.id) &&
        !(fixed && (entry.id === "rename" || entry.id === "delete"))),
  );
  return offered.filter(
    (entry, index) =>
      entry.kind === "item" ||
      (offered[index - 1]?.kind === "item" &&
        offered.slice(index + 1).some((next) => next.kind === "item")),
  );
}

async function restoreDeleted(
  path: string,
  documents: readonly DemoBridgeDocument[],
  folders: readonly string[],
  assets: ReadonlyArray<readonly [string, string]>,
  restore: () => void,
): Promise<UndoResult> {
  const workspacePaths = collectWorkspacePaths([
    ...context.documents.map((document) => document.path),
    ...context.folders,
    ...context.fixedPaths,
    ...assetUrls.keys(),
  ]);
  const occupied = workspacePaths.includes(path)
    ? path
    : findFileAncestor(
        context.documents.map((document) => document.path),
        path,
      );
  if (occupied) {
    return {
      ok: false,
      reason: `Something new is at ${occupied}.`,
      refusal: { code: "old-path-occupied", path: occupied },
    };
  }
  restore();
  context.documents = [...context.documents, ...documents];
  context.folders = [...context.folders, ...folders];
  for (const [assetPath, url] of assets) assetUrls.set(assetPath, url);
  await persistAssetMutation(async () => {
    for (const [assetPath, url] of assets) {
      const bytes = await (await fetch(url)).arrayBuffer();
      await persistAsset({ path: assetPath, mediaType: mediaTypeForPath(assetPath), bytes });
    }
  });
  return {
    ok: true,
    tracked: { state: "restored", momentCount: 0 },
    restored: [path],
    remaining: [],
  };
}

export function answerDemoJoinedLane(
  channelWireIds: readonly string[],
): Array<{ channelWireId: string; joined: null }> {
  return channelWireIds.map((channelWireId) => ({ channelWireId, joined: null }));
}

// The desktop renderer chooses each shortcut's modifier from the platform.
const DEMO_PLATFORM = /Mac|iP(hone|[oa]d)/.test(navigator.platform)
  ? "darwin"
  : /Win/.test(navigator.platform)
    ? "win32"
    : "linux";

const demoBridge = {
  platform: DEMO_PLATFORM,
  onLocalAppsChanged() {
    return () => undefined;
  },
  onUpdateState() {
    return () => undefined;
  },
  async getUpdateState() {
    return { status: "idle" as const, message: "Updates are unavailable in the demo." };
  },
  onSearchResults(listener: (batch: SearchResultsEvent) => void) {
    searchListeners.add(listener);
    return () => searchListeners.delete(listener);
  },
  async searchWorkspace(payload: Parameters<DohcDesktopBridge["searchWorkspace"]>[0]) {
    const batch: SearchResultsEvent = {
      searchId: payload.searchId,
      entries: searchDemoDocuments(context.documents, payload),
      done: true,
      limitHit: false,
    };
    queueMicrotask(() => searchListeners.forEach((listener) => listener(batch)));
    return { status: "accepted" as const };
  },
  async cancelWorkspaceSearch() {},
  async linksConnections() {
    return {
      scope: "workspace" as const,
      nodes: [],
      edges: [],
      records: [],
      complete: true,
      mountsCovered: true,
    };
  },
  async linksEdges() {
    // Explicit sample data for the demo, independent of the engine index.
    return {
      versionId: "demo",
      files: context.documents.slice(0, 50).map((document) => ({
        objectId: document.path,
        path: document.path,
        title: document.title,
      })),
      entries: demoLinkEdges(context.documents.slice(0, 50)),
      unchecked: [],
      complete: true,
      indexBuilding: false,
      mountsCovered: true,
      nextCursor: null,
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
      ...context.fixedPaths,
    ]);
    if (workspacePaths.includes(payload.relativePath)) {
      throw new Error(`A document already exists at ${payload.relativePath}`);
    }
    context.createFile(payload.relativePath);
    context.documents = [
      ...context.documents,
      { path: payload.relativePath, title: payload.relativePath, body: "" },
    ];
    // The demo is single-workspace; the payload-free global ping suffices.
    activityListeners.forEach((listener) => listener({}));
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
      ...context.fixedPaths,
    ]);
    if (workspacePaths.includes(payload.relativePath)) {
      throw new Error(`A folder already exists at ${payload.relativePath}`);
    }
    context.createFolder(payload.relativePath);
    context.folders = [...context.folders, payload.relativePath];
    return { path: payload.relativePath };
  },
  async moveWorkspacePath(payload: { fromPath: string; toPath: string }) {
    refuseFixed(payload.fromPath);
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
      ...context.fixedPaths,
      ...assetUrls.keys(),
    ]);
    planDemoPathMove(workspacePaths, payload.fromPath, payload.toPath);
    await persistAssetMutation(() => rewriteStoredAssets(payload.fromPath, payload.toPath));
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
    refuseFixed(payload.relativePath);
    const workspacePaths = collectWorkspacePaths([
      ...context.documents.map((document) => document.path),
      ...context.folders,
      ...assetUrls.keys(),
    ]);
    if (!workspacePaths.some((path) => isPathAtOrBelow(path, payload.relativePath))) {
      throw new Error(`No workspace entry exists at ${payload.relativePath}`);
    }
    const deleted = (path: string) => isPathAtOrBelow(path, payload.relativePath);
    const documents = context.documents.filter((document) => deleted(document.path));
    const folders = context.folders.filter(deleted);
    const assets = [...assetUrls.entries()].filter(([path]) => deleted(path));
    await persistAssetMutation(() => rewriteStoredAssets(payload.relativePath, null));
    const restore = context.deletePath(payload.relativePath);
    context.documents = context.documents.filter((document) => !deleted(document.path));
    context.folders = context.folders.filter((folder) => !deleted(folder));
    for (const [path] of assets) assetUrls.delete(path);
    const operationId = `dohc-operation:${crypto.randomUUID()}`;
    deleteUndos.set(operationId, () =>
      restoreDeleted(payload.relativePath, documents, folders, assets, restore),
    );
    return { operationId, undo: { available: true as const } };
  },
  async undoHistoryOperation(payload: { operationId: string }): Promise<UndoResult> {
    const undo = deleteUndos.get(payload.operationId);
    if (!undo) {
      return {
        ok: false,
        reason: "The demo keeps a delete's Undo only while this tab stays open.",
        refusal: { code: "unexplained" },
      };
    }
    const result = await undo();
    if (result.ok) deleteUndos.delete(payload.operationId);
    return result;
  },
  async readExplorerMenu(payload: ReadExplorerMenuPayload) {
    return demoExplorerMenu(payload, context.fixedPaths);
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
        sites: { defaultPreviewMode: "auto" as const },
        privacy: { confirmExternalLinks: true },
        files: { attachmentLocation: "per-document" as const, attachmentFolderName: "assets" },
      },
      source: "default" as const,
    };
  },
  onWorkspaceActivity(listener: (event: WorkspaceActivityEvent) => void) {
    activityListeners.add(listener);
    return () => {
      activityListeners.delete(listener);
    };
  },
  // The demo has no cloud session, so the signal never fires.
  onCloudSessionChanged() {
    return () => {};
  },
  async listChatChannels() {
    return {
      channels: [
        channel("channel-agent", "Your agent", "agent"),
        channel("channel-trip", "lisbon-trip"),
        channel("channel-bookings", "bookings"),
      ],
      fileThreads: [
        {
          id: "thread-file-budget",
          title: "Who still owes a deposit?",
          createdAtMs: now - 7_200_000,
          updatedAtMs: now - 7_200_000,
          path: "Budget.md",
        },
      ],
    };
  },
  async listChatChannelShares(payload: { channelWireIds: readonly string[] }) {
    return {
      joined: answerDemoJoinedLane(payload.channelWireIds),
      sessionKey: null,
      relay: { state: "answered" as const, granted: [], received: [], removed: [] },
    };
  },
  async listJoinedSharedChannels(payload: { channelWireIds: readonly string[] }) {
    return { joined: answerDemoJoinedLane(payload.channelWireIds) };
  },
  // The demo is signed out, so Chats shows no People section.
  async directConversations() {
    return { available: false as const };
  },
  async workspaceMembers() {
    return { status: "refused" as const };
  },
  async listPersonalChatFeed() {
    return {
      items: [
        feedItem("channel-trip", channel("channel-trip", "lisbon-trip")),
        feedItem("channel-bookings", channel("channel-bookings", "bookings")),
      ],
    };
  },
  onDirectChanged() {
    return () => {};
  },
  async listChannelThreads(payload: { channelId: string }) {
    return {
      threads: [thread(payload.channelId, THREADS[payload.channelId] ?? [])],
      viewerAuthorId: "demo-user",
    };
  },
  async getChatThreadRevision() {
    return { revision: 1 };
  },
  async listChatMessages(payload: { threadId: string }) {
    const posts = THREADS[payload.threadId.replace(/^thread-/, "")] ?? [];
    return {
      messages: posts.map((post, index) =>
        message(payload.threadId, `message-${payload.threadId.slice(7)}-${index}`, post),
      ),
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
    return { liveRunId: null, liveTriggerMessageId: null, pendingCount: 0, paused: false };
  },
  async readChatDispatchPaused() {
    return { paused: false };
  },
  onChatDispatchPaused() {
    return () => {};
  },
  async markChatThreadRead() {
    return { lastReadSequence: 2, revision: 1 };
  },
  async createChatChannel(payload: { name: string }) {
    return { channel: channel(`channel-${Date.now()}`, payload.name) };
  },
  async startChannelThread(payload: { channelId: string; body: string }) {
    const post = yourPost(payload.body);
    const nextThread = { ...thread(payload.channelId, [post]), id: `thread-new-${Date.now()}` };
    return {
      thread: nextThread,
      message: message(nextThread.id, `message-${Date.now()}`, post),
      viewerAuthorId: "demo-user",
    };
  },
  async sendChatMessage(payload: { threadId: string; body: string }) {
    return {
      message: message(payload.threadId, `message-${Date.now()}`, yourPost(payload.body)),
    };
  },
  async setChatReaction(payload: Parameters<DohcDesktopBridge["setChatReaction"]>[0]) {
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
  async stopAgentRun() {},
  async resumeThreadDispatch() {},
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
  async revokeRelayShare() {
    return { undo: { undoId: "demo-undo", expiresAtMs: Date.now() + 600_000 } };
  },
  // A browser saves an export as a download. A PDF opens the browser's print
  // dialog, where the person saves it as a PDF.
  async exportDocumentFile(payload: {
    suggestedName: string;
    content: string;
    kind: "markdown" | "html" | "pdf";
  }) {
    if (payload.kind === "pdf") {
      const frame = document.createElement("iframe");
      frame.sandbox.add("allow-same-origin", "allow-modals");
      frame.style.cssText = "position: fixed; width: 0; height: 0; border: 0";
      frame.srcdoc = payload.content;
      document.body.append(frame);
      await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
      frame.contentWindow?.addEventListener("afterprint", () => frame.remove(), { once: true });
      frame.contentWindow?.print();
      return { path: null };
    }
    const markdown = payload.kind === "markdown";
    const url = URL.createObjectURL(
      new Blob([payload.content], { type: markdown ? "text/markdown" : "text/html" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${payload.suggestedName}.${markdown ? "md" : "html"}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { path: null };
  },
} satisfies DemoDesktopBridge;

export function configureDemoDesktopBridge(next: DemoBridgeContext): void {
  context = next;
  // The embedded demo deliberately exposes only the bridge methods consumed by
  // DemoSidebar and MarkdownEditor. DemoDesktopBridge makes every consumed
  // method required while keeping the intentionally narrow boundary explicit.
  window.dohcDesktop = demoBridge as unknown as DohcDesktopBridge;
}
