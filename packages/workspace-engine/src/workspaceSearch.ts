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
export { classifyEngineFilePath } from "./enginePathFloor";

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
