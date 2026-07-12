import type {
  SearchSurface,
  SearchVisibility,
  WorkspaceEngineSearchOptions,
  WorkspaceEngineSearchResult,
  WorkspaceSearchPolicy,
} from "@dohc/workspace-contracts/engine";
import type {
  ChatThread,
  LinkedChatProjection,
  LinkedChatProjectionFileAccess,
  LinkedChatStore,
} from "./linkedChatStore";
import type {
  TextFileSnapshot,
  VersionedTextStore,
  VersionId,
  WorkspaceId,
} from "./versionedTextStore";
import { resolveEffectivePolicy } from "./effectivePolicy";

export const WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS = 180;

export type {
  EngineFilePathClassification,
  SearchSurface,
  SearchVisibility,
  WorkspaceEngineSearchOptions,
  WorkspaceEngineSearchResult,
  WorkspaceSearchPolicy,
} from "@dohc/workspace-contracts/engine";
// The classifier lives in its own leaf module (enginePathFloor) so the
// versioned text store and secret file store can enforce the SAME floor
// without an import cycle; this re-export keeps the historical API surface.
export { classifyEngineFilePath, classifyEngineFilePathForRead } from "./enginePathFloor";

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function defaultFileVisibility(file: TextFileSnapshot): SearchVisibility {
  const policy = resolveEffectivePolicy({ path: file.path });
  if (policy.searchable) return { searchable: true };
  return {
    searchable: false,
    reason: policy.floor === "secret" ? "secret" : "ignored",
  };
}

function defaultChatVisibility(_thread: ChatThread): SearchVisibility {
  return { searchable: true, projectionFileAccess: { kind: "unknown" } };
}

function previewForLine(line: string, matchIndex: number, queryLength: number): {
  preview: string;
  matchStart: number;
  matchEnd: number;
} {
  let windowStart = 0;
  if (line.length > WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS) {
    windowStart = Math.max(
      0,
      matchIndex - Math.floor(WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS / 3),
    );
    windowStart = Math.min(
      windowStart,
      line.length - WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS,
    );
  }
  const preview = line.slice(
    windowStart,
    windowStart + WORKSPACE_ENGINE_SEARCH_MAX_PREVIEW_CHARS,
  );
  const matchStart = Math.max(0, Math.min(matchIndex - windowStart, preview.length));
  const matchEnd = Math.max(
    matchStart,
    Math.min(matchIndex + queryLength - windowStart, preview.length),
  );
  return { preview, matchStart, matchEnd };
}

function textMatches(input: {
  text: string;
  query: string;
  path: string;
  title: string;
  surface: SearchSurface;
  threadId?: string;
  objectId?: string;
  remaining: number;
}): WorkspaceEngineSearchResult[] {
  const lines = input.text.replace(/\r\n?/g, "\n").split("\n");
  const out: WorkspaceEngineSearchResult[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const matchIndex = line.toLowerCase().indexOf(input.query);
    if (matchIndex === -1) continue;
    const preview = previewForLine(line, matchIndex, input.query.length);
    out.push({
      surface: input.surface,
      path: input.path,
      title: input.title,
      line: index + 1,
      preview: preview.preview,
      matchStart: preview.matchStart,
      matchEnd: preview.matchEnd,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.objectId ? { objectId: input.objectId } : {}),
    });
    if (out.length >= input.remaining) break;
  }
  return out;
}

function projectionTitle(projection: LinkedChatProjection): string {
  return projection.text.split(/\r?\n/, 1)[0]?.replace(/^#\s*/, "") || projection.threadId;
}

export async function searchWorkspaceEngine(
  options: WorkspaceEngineSearchOptions,
): Promise<WorkspaceEngineSearchResult[]> {
  const query = normalizeQuery(options.query);
  if (!query) return [];
  const limit = options.limit ?? 100;
  if (limit <= 0) return [];

  const results: WorkspaceEngineSearchResult[] = [];
  const fileVisibility = options.policy?.fileVisibility;
  const chatVisibility = options.policy?.chatVisibility ?? defaultChatVisibility;

  if (options.versions.ensureSearchIndex && options.versions.querySearchIndex) {
    await options.versions.ensureSearchIndex({
      workspaceId: options.workspaceId,
      versionId: options.versionId,
    });
    // Visibility hooks can drop indexed candidates, so a single limit-sized
    // fetch may under-fill the page while later index hits stay unread. Grow
    // the candidate fetch geometrically (dedup by identity, not position —
    // file/chat interleaving is not prefix-stable across fetch sizes) until
    // the page is full or the index stops yielding a full candidate batch.
    let indexAvailable = true;
    let fetchLimit = limit;
    let threadsById: Map<string, ChatThread> | undefined;
    const seenCandidates = new Set<string>();
    for (;;) {
      const candidates = await options.versions.querySearchIndex({
        workspaceId: options.workspaceId,
        versionId: options.versionId,
        query,
        limit: fetchLimit,
      });
      if (!candidates) {
        indexAvailable = false;
        break;
      }
      for (const candidate of candidates) {
        const candidateKey =
          candidate.surface === "file"
            ? `file\0${candidate.path}\0${candidate.objectId}`
            : `chat\0${candidate.threadId}`;
        if (seenCandidates.has(candidateKey)) continue;
        seenCandidates.add(candidateKey);
        if (candidate.surface === "file") {
          // Hooks and results must see the REAL snapshot (metadata, moment,
          // timestamps) exactly as the linear path does — a synthetic
          // stand-in could make a custom fileVisibility policy diverge
          // between the indexed and linear paths. A candidate whose current
          // snapshot is gone (or re-owned) is stale index data: skip it.
          const snapshot = await options.versions.readTextFile({
            workspaceId: options.workspaceId,
            versionId: options.versionId,
            path: candidate.path,
          });
          if (!snapshot || snapshot.objectId !== candidate.objectId) continue;
          const baselineVisibility = defaultFileVisibility(snapshot);
          if (!baselineVisibility.searchable) continue;
          const visibility = fileVisibility?.(snapshot) ?? baselineVisibility;
          if (!visibility.searchable) continue;
          results.push(
            ...textMatches({
              text: snapshot.text,
              query,
              path: snapshot.path,
              title: snapshot.path,
              surface: "file",
              objectId: snapshot.objectId,
              remaining: limit - results.length,
            }),
          );
        } else {
          // Same rule for chats: custom chatVisibility hooks get the real
          // thread record (title, linkedFile, timestamps), never a cast.
          threadsById ??= new Map(
            (await options.chats.listThreads({ workspaceId: options.workspaceId })).map(
              (thread) => [thread.id, thread],
            ),
          );
          const thread = threadsById.get(candidate.threadId);
          if (!thread) continue;
          const visibility = chatVisibility(thread);
          if (!visibility.searchable) continue;
          const projection = await options.chats.getThreadProjection({
            workspaceId: options.workspaceId,
            threadId: thread.id,
            linkedFileAccess: visibility.projectionFileAccess ?? { kind: "unknown" },
          });
          results.push(
            ...textMatches({
              text: projection.text,
              query,
              path: projection.path,
              title: projectionTitle(projection),
              surface: "chat",
              threadId: thread.id,
              remaining: limit - results.length,
            }),
          );
        }
        if (results.length >= limit) return results;
      }
      // A short batch means the index has no further candidates to offer.
      if (candidates.length < fetchLimit) break;
      fetchLimit *= 2;
    }
    // Chat projections contain synthesized lines (headers, linked-file
    // notes) the message index never stores, so an empty indexed result
    // under a custom chatVisibility policy still needs the linear pass.
    if (indexAvailable && (results.length > 0 || !options.policy?.chatVisibility)) {
      return results;
    }
  }

  const files = await options.versions.listTextFiles({
    workspaceId: options.workspaceId,
    versionId: options.versionId,
  });
  for (const file of files) {
    const baselineVisibility = defaultFileVisibility(file);
    if (!baselineVisibility.searchable) continue;
    const visibility = fileVisibility?.(file) ?? baselineVisibility;
    if (!visibility.searchable) continue;
    results.push(
      ...textMatches({
        text: file.text,
        query,
        path: file.path,
        title: file.path,
        surface: "file",
        objectId: file.objectId,
        remaining: limit - results.length,
      }),
    );
    if (results.length >= limit) return results;
  }

  const threads = await options.chats.listThreads({ workspaceId: options.workspaceId });
  for (const thread of threads) {
    const visibility = chatVisibility(thread);
    if (!visibility.searchable) continue;
    const projection = await options.chats.getThreadProjection({
      workspaceId: options.workspaceId,
      threadId: thread.id,
      linkedFileAccess: visibility.projectionFileAccess ?? { kind: "unknown" },
    });
    results.push(
      ...textMatches({
        text: projection.text,
        query,
        path: projection.path,
        title: projectionTitle(projection),
        surface: "chat",
        threadId: thread.id,
        remaining: limit - results.length,
      }),
    );
    if (results.length >= limit) return results;
  }

  return results;
}
