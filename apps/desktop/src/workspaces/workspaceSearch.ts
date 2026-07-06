import { hasIgnoredSegment, validateUserWritePath } from "@dohc/workspace-core";
import { classifyEngineFilePath } from "@dohc/workspace-engine";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline";

// Phase E5.0 content-search engine: spawns the bundled ripgrep
// (@vscode/ripgrep — the exact engine VS Code uses) rooted at the REAL
// workspace root, parses its --json event stream line-by-line, and forwards
// bounded result batches to a callback. No shell is ever involved: the query
// travels as one argv element after `--`, so it can never read as a flag or
// be interpreted by /bin/sh.
//
// WSL/process safety: every child this module spawns is tracked by handle.
// A new search, an explicit cancel, the renderer going away, and app quit
// each kill the SPECIFIC tracked child — never a pattern kill.

// Bounds. The two the tests/renderer share are exported; the rest are pinned
// through buildRipgrepArgs' visible argv in the unit tests.
export const SEARCH_MAX_TOTAL_MATCHES = 2000;
export const SEARCH_MAX_PREVIEW_CHARS = 250;
const SEARCH_MAX_MATCHES_PER_FILE = 200;
const SEARCH_BATCH_MAX_ENTRIES = 50;
const SEARCH_BATCH_FLUSH_MS = 30;
const SEARCH_MAX_FILESIZE = "2M";

export interface WorkspaceSearchRequest {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  includeGlob?: string;
  excludeGlob?: string;
}

export interface SearchResultEntry {
  // Workspace-relative, forward-slashed, validateUserWritePath-clean.
  path: string;
  // 1-based line and column (column in CHARACTERS into the full line).
  line: number;
  column: number;
  // The matched line, trimmed of its newline and bounded to
  // SEARCH_MAX_PREVIEW_CHARS — windowed around the match when the line is
  // longer, with matchStart/matchEnd re-based into the window. The renderer
  // highlights with these offsets and NEVER re-executes the pattern.
  preview: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchBatch {
  searchId: string;
  entries: SearchResultEntry[];
  done: boolean;
  limitHit: boolean;
}

// Builds the rg argv. Pure — unit tests pin the security-relevant shape:
// structured --json output, the ALWAYS-on exclusions (defense in depth beyond
// rg's own gitignore handling; `**/` so a nested .git/.dohc prunes too), the
// file-size and per-file caps, and the `--` terminator so the user's query is
// always a pattern, never a flag. --no-ignore + --hidden make search results
// agree with the explorer tree, which lists dotfiles and ignores ONLY the
// reserved segments.
//
// GLOB ORDER IS LOAD-BEARING: rg glob precedence is last-match-wins, so the
// built-in exclusions are appended AFTER the user's include/exclude globs.
// With them first, includeGlob '**/.git/**' (or even a benign '*') would
// re-include reserved-segment content — .git/config routinely carries
// credential tokens in HTTPS remote URLs. toSearchEntries re-checks every
// emitted path against hasIgnoredSegment as the engine-level backstop.
export function buildRipgrepArgs(request: WorkspaceSearchRequest): string[] {
  const args = [
    "--json",
    "--no-config",
    "--no-ignore",
    "--no-ignore-messages",
    "--hidden",
    "--max-filesize",
    SEARCH_MAX_FILESIZE,
    "--max-count",
    String(SEARCH_MAX_MATCHES_PER_FILE),
  ];
  args.push(request.caseSensitive ? "--case-sensitive" : "--ignore-case");
  if (request.wholeWord) args.push("--word-regexp");
  if (!request.regex) args.push("--fixed-strings");
  if (request.includeGlob) args.push("-g", request.includeGlob);
  if (request.excludeGlob) args.push("-g", `!${request.excludeGlob}`);
  // Built-in exclusions LAST (after every user glob): last-match-wins keeps
  // them authoritative no matter what the user typed.
  args.push("-g", "!**/.dohc/**", "-g", "!**/.git/**", "-g", "!**/node_modules/**");
  // Secret floor (PR 08): `.env`-style paths never surface search snippets —
  // the same classifyEngineFilePath floor the engine enforces, expressed as
  // rg globs (case-insensitive to match the floor's lowercase rule) plus the
  // toSearchEntries backstop below. Over-exclusion is the safe direction.
  args.push("--iglob", "!**/*.env", "--iglob", "!**/.env/**", "--iglob", "!**/.env.*");
  args.push("--", request.query);
  return args;
}

// One rg --json "match" event (the fields this module consumes). lines.text
// is absent for non-UTF8 lines (rg sends base64 `bytes` instead) — those are
// skipped: a preview that can't render as text isn't a useful result.
interface RgSubmatch {
  start?: unknown;
  end?: unknown;
}
interface RgMatchData {
  path?: { text?: unknown };
  lines?: { text?: unknown };
  line_number?: unknown;
  submatches?: unknown;
}

// Parses one stdout line; returns the match data or null for every other
// event type (begin/end/summary/context) and for malformed JSON.
export function parseRipgrepLine(line: string): RgMatchData | null {
  if (line.length === 0) return null;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null) return null;
  const typed = event as { type?: unknown; data?: unknown };
  if (typed.type !== "match") return null;
  if (typeof typed.data !== "object" || typed.data === null) return null;
  return typed.data as RgMatchData;
}

// rg reports submatch offsets in BYTES into the line; previews are sliced in
// CHARACTERS. Convert via the UTF-8 byte prefix (multi-byte text stays honest
// instead of off-by-N). The line's buffer is computed ONCE by the caller —
// a long line can carry hundreds of submatches, and re-encoding it per
// submatch was a measurable main-process hot spot on prose fixtures.
function byteToCharOffset(line: string, bytes: Buffer, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  if (byteOffset >= bytes.length) return line.length;
  // All-ASCII fast path: byte offsets ARE char offsets.
  if (bytes.length === line.length) return byteOffset;
  return bytes.subarray(0, byteOffset).toString("utf8").length;
}

// Converts one rg match event into bounded result entries (one per submatch).
// Every path must pass validateUserWritePath — rg runs rooted at the real
// workspace root and emits relative paths, but the validator is the same
// containment rule every other IPC surface enforces, applied BEFORE the path
// crosses toward the renderer. Pure; unit tests cover the windowing math.
export function toSearchEntries(data: RgMatchData): SearchResultEntry[] {
  const rawPath = data.path?.text;
  const rawLine = data.lines?.text;
  const lineNumber = data.line_number;
  if (typeof rawPath !== "string" || typeof rawLine !== "string") return [];
  if (typeof lineNumber !== "number" || !Number.isInteger(lineNumber) || lineNumber < 1) {
    return [];
  }
  const validated = validateUserWritePath(rawPath.replaceAll("\\", "/"));
  if (!validated.ok) return [];
  // Defense-in-depth reserved/ignored segment backstop. The shared validator
  // rejects these today, and this stays near rg parsing because include globs
  // can out-vote CLI exclusions (last-match-wins).
  if (hasIgnoredSegment(validated.normalized)) return [];
  // Secret-floor backstop (PR 08): even if a user include glob out-votes the
  // CLI exclusions, a secret-classified path never crosses to the renderer.
  if (classifyEngineFilePath(validated.normalized).kind === "secret") return [];
  const submatches = Array.isArray(data.submatches) ? data.submatches : [];
  const line = rawLine.replace(/\r?\n$/, "");
  const lineBytes = Buffer.from(line, "utf8");
  const entries: SearchResultEntry[] = [];
  for (const submatch of submatches as RgSubmatch[]) {
    if (typeof submatch !== "object" || submatch === null) continue;
    const { start, end } = submatch;
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      continue;
    }
    const charStart = byteToCharOffset(line, lineBytes, start);
    const charEnd = byteToCharOffset(line, lineBytes, end);
    if (charStart >= line.length && line.length > 0) continue;
    // Window the preview around the match when the line is oversized.
    let windowStart = 0;
    if (line.length > SEARCH_MAX_PREVIEW_CHARS) {
      // Lead-in of ~1/3 keeps the match visible with context on both sides.
      windowStart = Math.max(0, charStart - Math.floor(SEARCH_MAX_PREVIEW_CHARS / 3));
      windowStart = Math.min(windowStart, line.length - SEARCH_MAX_PREVIEW_CHARS);
    }
    const preview = line.slice(windowStart, windowStart + SEARCH_MAX_PREVIEW_CHARS);
    const matchStart = Math.max(0, Math.min(charStart - windowStart, preview.length));
    const matchEnd = Math.max(matchStart, Math.min(charEnd - windowStart, preview.length));
    entries.push({
      path: validated.normalized,
      line: lineNumber,
      column: charStart + 1,
      preview,
      matchStart,
      matchEnd,
    });
  }
  return entries;
}

export interface SearchHandle {
  searchId: string;
  kill(): void;
}

// Spawns rg for one search and streams bounded batches to onBatch. The
// final batch always carries done:true (even on error/kill) so the renderer
// can settle its spinner. Batches flush at SEARCH_BATCH_MAX_ENTRIES or
// SEARCH_BATCH_FLUSH_MS, whichever first. Hitting SEARCH_MAX_TOTAL_MATCHES
// kills the child by its tracked handle and flags limitHit.
export function startRipgrepSearch(options: {
  rgPath: string;
  realRoot: string;
  searchId: string;
  request: WorkspaceSearchRequest;
  onBatch: (batch: SearchBatch) => void;
}): SearchHandle {
  const { rgPath, realRoot, searchId, request, onBatch } = options;
  // spawn with an argv ARRAY and shell:false (the default) — the query is
  // data, never shell input. cwd is the realpathed workspace root, so rg's
  // relative output paths are workspace-relative by construction.
  const child = spawn(rgPath, buildRipgrepArgs(request), {
    cwd: realRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let total = 0;
  let limitHit = false;
  let finished = false;
  let pending: SearchResultEntry[] = [];
  let flushTimer: NodeJS.Timeout | null = null;

  function flush(done: boolean): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pending.length === 0 && !done) return;
    const entries = pending;
    pending = [];
    onBatch({ searchId, entries, done, limitHit });
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    flush(true);
  }

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (finished || limitHit) return;
    const data = parseRipgrepLine(line);
    if (!data) return;
    // Flush INSIDE the loop: one rg match event carries one entry per
    // SUBMATCH, and a long prose line against a short query can carry
    // hundreds — a batch must never exceed the contract's per-event entry
    // cap, no matter how many entries one line yields.
    for (const entry of toSearchEntries(data)) {
      if (total >= SEARCH_MAX_TOTAL_MATCHES) break;
      pending.push(entry);
      total += 1;
      if (pending.length >= SEARCH_BATCH_MAX_ENTRIES) flush(false);
    }
    if (total >= SEARCH_MAX_TOTAL_MATCHES) {
      // Hard stream cap: stop the scan by killing OUR tracked child.
      limitHit = true;
      child.kill();
    }
    if (!flushTimer && pending.length > 0) {
      flushTimer = setTimeout(() => flush(false), SEARCH_BATCH_FLUSH_MS);
    }
  });
  // stderr is consumed and dropped (--no-ignore-messages already silences
  // ignore-file noise; permission errors on individual files are not results).
  child.stderr.resume();
  child.on("close", finish);
  child.on("error", finish);

  return {
    searchId,
    kill: () => {
      // Idempotent: kill() after exit is a no-op. SIGTERM is enough — rg
      // exits promptly; the close handler emits the final done batch.
      child.kill();
    },
  };
}

// Tracks at most ONE active search per owner (an owner is a renderer
// webContents). Starting a new search for an owner kills its previous child
// by handle; cancel/dispose do the same. Electron-free so the lifecycle is
// unit-testable; main.ts adapts webContents ids and quit hooks onto it.
export function createSearchRegistry(deps: {
  rgPath: string;
  start?: typeof startRipgrepSearch;
}) {
  const active = new Map<number, SearchHandle>();
  const start = deps.start ?? startRipgrepSearch;

  return {
    // Containment of the root itself (resolveWorkspaceFile idiom, applied to
    // the root): realpath must resolve and must be a directory before any
    // child is spawned rooted there.
    async startSearch(
      ownerId: number,
      rootPath: string,
      searchId: string,
      request: WorkspaceSearchRequest,
      onBatch: (batch: SearchBatch) => void,
    ): Promise<void> {
      const realRoot = await realpath(rootPath);
      if (!(await stat(realRoot)).isDirectory()) {
        throw new Error("Workspace root is not a directory");
      }
      active.get(ownerId)?.kill();
      const handle = start({
        rgPath: deps.rgPath,
        realRoot,
        searchId,
        request,
        onBatch: (batch) => {
          // Drop the registry entry when the CURRENT search finishes (a
          // superseded search's late done-batch must not delete its
          // replacement's handle).
          if (batch.done && active.get(ownerId)?.searchId === batch.searchId) {
            active.delete(ownerId);
          }
          onBatch(batch);
        },
      });
      active.set(ownerId, handle);
    },
    cancel(ownerId: number, searchId: string): void {
      const handle = active.get(ownerId);
      if (handle && handle.searchId === searchId) {
        handle.kill();
        active.delete(ownerId);
      }
    },
    // Renderer went away (window closed / reloaded): kill its child.
    disposeOwner(ownerId: number): void {
      const handle = active.get(ownerId);
      if (handle) {
        handle.kill();
        active.delete(ownerId);
      }
    },
    // App quit: kill every tracked child (and only those).
    killAll(): void {
      for (const handle of active.values()) handle.kill();
      active.clear();
    },
  };
}

export type SearchRegistry = ReturnType<typeof createSearchRegistry>;
