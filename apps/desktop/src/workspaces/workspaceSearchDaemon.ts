import {
  decodeSearchQueryPageResult,
  type JsonValue,
  type SearchQueryPageParams,
  type SearchResult,
} from "@dohc/workspace-engine-client";

export interface WorkspaceSearchDaemonReader {
  queryPage(params: SearchQueryPageParams): Promise<JsonValue>;
}

export interface QueryWorkspaceSearchDaemonInput {
  daemon: WorkspaceSearchDaemonReader;
  query: string;
  limit: number;
  isCurrent: () => boolean;
}

function utf8ByteOffsetToUtf16(bytes: Buffer, byteOffset: number): number {
  return bytes.subarray(0, Math.min(Math.max(byteOffset, 0), bytes.length))
    .toString("utf8").length;
}

function rendererSearchResult(result: SearchResult): SearchResult {
  const previewBytes = Buffer.from(result.preview, "utf8");
  return {
    ...result,
    // The Rust search runtime exposes byte-safe UTF-8 offsets. Electron's
    // renderer consumes JavaScript UTF-16 string indexes, which is what the
    // legacy TypeScript search contract returned.
    matchStart: utf8ByteOffsetToUtf16(previewBytes, result.matchStart),
    matchEnd: utf8ByteOffsetToUtf16(previewBytes, result.matchEnd),
  };
}

export async function queryWorkspaceSearchDaemon(
  input: QueryWorkspaceSearchDaemonInput,
): Promise<SearchResult[] | null> {
  const results: SearchResult[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let versionId: string | undefined;
  let restartCount = 0;

  for (;;) {
    if (!input.isCurrent()) return null;
    const page = decodeSearchQueryPageResult(
      await input.daemon.queryPage({
        query: input.query,
        limit: input.limit,
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (!input.isCurrent()) return null;
    if (page.restartRequired) {
      if (cursor === undefined || page.results.length !== 0 || page.nextCursor !== null) {
        throw new Error("Daemon workspace search returned an invalid restart disposition.");
      }
      restartCount += 1;
      if (restartCount > 3) {
        throw new Error("Daemon workspace search index kept changing between pages.");
      }
      results.length = 0;
      seenCursors.clear();
      cursor = undefined;
      versionId = undefined;
      continue;
    }
    if (versionId !== undefined && page.versionId !== versionId) {
      throw new Error("Daemon workspace search changed active version between pages.");
    }
    versionId = page.versionId;
    results.push(...page.results.map(rendererSearchResult));
    if (results.length > input.limit) {
      throw new Error("Daemon workspace search exceeded its requested result limit.");
    }
    if (page.nextCursor === null) return results;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("Daemon workspace search pagination did not advance.");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
