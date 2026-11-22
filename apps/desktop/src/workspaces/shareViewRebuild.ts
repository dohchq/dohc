// Main's side of rebuilding a joined copy the engine closed because the relay
// changed what its member sees. Main holds every session on the copy closed,
// asks the engine to rebuild it under the reach the relay lists now, stores
// that reach, and reopens the copy. The engine keeps the copy closed through
// a restart, so a later run resumes the same rebuild.

import { RelayUnreachableError, ShareUnavailableError } from "@dohc/workspace-contracts/relay";
import {
  EngineRequestError,
  EngineWorkspaceRebuildingError,
} from "@dohc/workspace-engine-client/daemon";
import { parseListedReach, type ListedReach } from "@dohc/security-contract/listed-reach";
import { isRecord } from "@dohc/workspace-core/records";
import type { ShareViewRebuildStop } from "./registryStore";

/**
 * `savedDrafts`: the live draft records the recovery folder now holds, which
 * main deletes once the rebuild finishes.
 */
export type ShareViewRebuildAnswer<Reach> =
  | {
      state: "rebuilt";
      reach: Reach | null;
      recoveryFolder: string | null;
      recovered: number;
      savedDrafts: string[];
    }
  | { state: "reachMoved" };

export type ShareViewRebuildOutcome =
  | { kind: "rebuilt"; recoveryFolder: string | null; recovered: number }
  | { kind: "ended" }
  | { kind: "failed"; error: unknown };

export type ShareViewRebuildNotice =
  | { kind: "running" }
  | { kind: "waiting" }
  | { kind: "failed"; error: unknown }
  | { kind: "ended" }
  | { kind: "clear" };

/**
 * What a rebuild left the copy with: the reach the engine built it under, and
 * the recovery folder it saved items in. Null when the engine no longer holds
 * the rebuild, which says nothing of the reach the store was built under.
 */
export type ShareViewRebuildResult<Reach> = {
  reach: Reach;
  recovered: { folder: string; count: number } | null;
} | null;

export interface ShareViewRebuildSteps<Reach> {
  /** Close every reader and writer of the copy and keep it closed. Says whether it was open. */
  hold(workspaceId: string): Promise<{ reopen: boolean }>;
  release(workspaceId: string, reopen: boolean): Promise<void>;
  readReach(workspaceId: string): Promise<Reach>;
  rebuild(
    workspaceId: string,
    rebuildId: string,
    reach: Reach,
  ): Promise<ShareViewRebuildAnswer<Reach>>;
  /**
   * Delete what the engine kept for the rebuild, and the drafts it saved.
   * Runs only once `install` stored the result: the engine's record of the
   * rebuild is the only proof of the reach the store was built under.
   */
  finish(workspaceId: string, rebuildId: string, savedDrafts: readonly string[]): Promise<void>;
  /**
   * Clear the view's rebuild, if it is still this one, and store its result
   * in the same write: the reach, and the recovery folder for its Notice. A
   * null result keeps the stored reach, so the next pull rebuilds again if
   * the relay serves another.
   */
  install(
    workspaceId: string,
    rebuildId: string,
    result: ShareViewRebuildResult<Reach>,
  ): Promise<void>;
  notice(workspaceId: string, notice: ShareViewRebuildNotice): void;
  /** `finished`: the engine no longer holds this rebuild, so it already finished. */
  classify(error: unknown): "unreachable" | "ended" | "finished" | "other";
  sleep(ms: number): Promise<void>;
}

const WAITS_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000] as const;
// A reach that moves this often during one rebuild stops it with Try again.
const REACH_MOVES = 5;

export function createShareViewRebuilds<Reach>(steps: ShareViewRebuildSteps<Reach>) {
  const runs = new Map<string, Promise<ShareViewRebuildOutcome>>();

  async function rebuild(workspaceId: string, rebuildId: string): Promise<ShareViewRebuildOutcome> {
    // A new try replaces what stopped the last one.
    steps.notice(workspaceId, { kind: "running" });
    let reopen: boolean;
    try {
      ({ reopen } = await steps.hold(workspaceId));
    } catch (error) {
      steps.notice(workspaceId, { kind: "failed", error });
      return { kind: "failed", error };
    }
    let rebuilt = false;
    try {
      for (let moves = 0, waits = 0; ;) {
        let answer: ShareViewRebuildAnswer<Reach> | null;
        try {
          const reach = await steps.readReach(workspaceId);
          try {
            answer = await steps.rebuild(workspaceId, rebuildId, reach);
          } catch (error) {
            if (steps.classify(error) !== "finished") throw error;
            answer = null;
          }
          if (answer === null) {
            await steps.install(workspaceId, rebuildId, null);
          } else if (answer.state === "rebuilt") {
            await steps.install(workspaceId, rebuildId, {
              reach: answer.reach ?? reach,
              recovered:
                answer.recoveryFolder === null
                  ? null
                  : { folder: answer.recoveryFolder, count: answer.recovered },
            });
            // The copy is rebuilt and its result stored. A finish that fails
            // leaves the engine's record, and the next refresh or start finds
            // and finishes it.
            await steps
              .finish(workspaceId, rebuildId, answer.savedDrafts)
              .catch((error: unknown) => {
                console.error("[desktop] joined copy rebuild finish:", error);
              });
          }
        } catch (error) {
          const kind = steps.classify(error);
          if (kind === "unreachable") {
            steps.notice(workspaceId, { kind: "waiting" });
            await steps.sleep(WAITS_MS[Math.min(waits, WAITS_MS.length - 1)]!);
            waits += 1;
            continue;
          }
          if (kind === "ended") {
            steps.notice(workspaceId, { kind: "ended" });
            return { kind: "ended" };
          }
          steps.notice(workspaceId, { kind: "failed", error });
          return { kind: "failed", error };
        }
        if (answer?.state === "reachMoved") {
          moves += 1;
          if (moves < REACH_MOVES) continue;
          const error = new Error("dohc could not update access because it kept changing.");
          steps.notice(workspaceId, { kind: "failed", error });
          return { kind: "failed", error };
        }
        rebuilt = true;
        steps.notice(workspaceId, { kind: "clear" });
        return {
          kind: "rebuilt",
          recoveryFolder: answer?.recoveryFolder ?? null,
          recovered: answer?.recovered ?? 0,
        };
      }
    } finally {
      // A copy that wasn't rebuilt stays closed: the engine refuses it until
      // its rebuild finishes, so only the hold on its sessions ends.
      await steps.release(workspaceId, rebuilt && reopen);
    }
  }

  return {
    /** Rebuild the copy, or join the rebuild already running for it. */
    run(workspaceId: string, rebuildId: string): Promise<ShareViewRebuildOutcome> {
      const running = runs.get(workspaceId);
      if (running) return running;
      const run = rebuild(workspaceId, rebuildId).finally(() => {
        runs.delete(workspaceId);
      });
      runs.set(workspaceId, run);
      return run;
    },
    running(workspaceId: string): boolean {
      return runs.has(workspaceId);
    },
  };
}

/** A joined live page whose unsent edits could not be kept when its copy closed. */
export class LivePageUnkeptError extends Error {
  constructor(readonly causes: unknown[]) {
    super(
      "dohc could not keep the unsent edits of a page you had open, so access is not updated yet. Your edits are still open in dohc.",
    );
    this.name = "LivePageUnkeptError";
  }
}

/**
 * Close every joined live page of the copy and wait for each. A page with
 * edits the server hasn't confirmed keeps them as a draft first. A page that
 * could not keep its draft stops the close; it stays open with its edits, and
 * the next try closes it again.
 */
export async function closeLivePages(
  retire: () => Promise<readonly ({ kind: "released" } | { kind: "failed"; error: unknown })[]>,
): Promise<void> {
  const causes = (await retire()).flatMap((outcome) =>
    outcome.kind === "failed" ? [outcome.error] : [],
  );
  if (causes.length > 0) throw new LivePageUnkeptError(causes);
}

/**
 * Close every reader and writer of a copy for its rebuild and keep its
 * engine sessions closed. On a failure the sessions open again; the copy
 * stays closed in the engine until its rebuild finishes.
 */
export async function holdShareViewCopy(
  workspaceId: string,
  parts: {
    sessions: {
      holdForRebuild(workspaceId: string): Promise<void>;
      releaseRebuildHold(workspaceId: string): void;
    };
    /**
     * Close the activity, running every step. A failure `ignoreFailure` names
     * stops nothing, so the relay close and the window cleanup still run.
     */
    closeActivity(ignoreFailure: (error: unknown) => boolean): Promise<void>;
    closeLivePages(): Promise<void>;
  },
): Promise<void> {
  const holding = parts.sessions.holdForRebuild(workspaceId);
  try {
    // The activity's last file reads go through the copy's session, which
    // the hold and the engine both refuse. What they would have recorded
    // stays on disk, where the rebuild's plan reads it. A close already under
    // way may run without the filter, and the hold joins it, so its refusal
    // is dropped here too.
    await parts.closeActivity(isClosedCopyRefusal).catch((error: unknown) => {
      if (!isClosedCopyRefusal(error)) throw error;
    });
    await holding;
    await parts.closeLivePages();
  } catch (error) {
    parts.sessions.releaseRebuildHold(workspaceId);
    throw error;
  }
}

/**
 * What a close of a workspace's activity may ignore: what its caller names,
 * and, while a rebuild holds the copy, the refusal the closed copy answers
 * with. A close the hold joins then finishes, and its own caller still runs
 * what follows it.
 */
export function closeCopyIgnoring(
  workspaceId: string,
  sessions: { isHeldForRebuild(workspaceId: string): boolean } | null,
  ignoreFailure?: (error: unknown) => boolean,
): (error: unknown) => boolean {
  return (error) =>
    ignoreFailure?.(error) === true ||
    (sessions?.isHeldForRebuild(workspaceId) === true && isClosedCopyRefusal(error));
}

/**
 * Whether a background read failed only because the engine closed the copy
 * for its access, or main holds its sessions for the rebuild. Such a read
 * waits for the rebuild and logs nothing.
 */
export function isClosedCopyRefusal(error: unknown): boolean {
  // The daemon requester keeps the engine's refusal as its error's cause.
  for (let at = error, depth = 0; at instanceof Error && depth < 4; at = at.cause, depth += 1) {
    if (at instanceof EngineWorkspaceRebuildingError) return true;
    if (at instanceof EngineRequestError && at.wireError?.message === "share-view-updating-access")
      return true;
  }
  return false;
}

/** Log a background failure, except a closed copy's refusal: that work runs again once the copy reopens. */
export function logUnlessClosedCopy(label: string): (error: unknown) => void {
  return (error) => {
    if (!isClosedCopyRefusal(error)) console.error(label, error);
  };
}

/**
 * What a failed step means for the rebuild: wait for the relay, end the
 * membership, take the engine's finished rebuild, or stop with Try again.
 */
export function classifyShareViewRebuildError(
  error: unknown,
): "unreachable" | "ended" | "finished" | "other" {
  // A fetch that never reached the relay rejects with a TypeError.
  if (error instanceof RelayUnreachableError || error instanceof TypeError) return "unreachable";
  if (error instanceof ShareUnavailableError) return "ended";
  if (!(error instanceof EngineRequestError)) return "other";
  const { code, message } = error.wireError ?? {};
  if (code === "WORKSPACE_UNAVAILABLE" && message === "relay-unreachable") return "unreachable";
  if (code === "SHARE_UNAVAILABLE") return "ended";
  if (code === "INVALID_PARAMS" && message === "share-view-not-rebuilding") return "finished";
  return "other";
}

/** The engine stopped a rebuild at a path in the workspace the person can put right. */
export class ShareViewRebuildStoppedError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
  ) {
    super(`The rebuild stopped at ${path}: ${code}`);
    this.name = "ShareViewRebuildStoppedError";
  }
}

/**
 * The engine's `share.view.rebuild` answer. A rebuilt copy keeps the reach
 * main read when the engine built under the same signatures, and otherwise
 * takes the reach the engine's plan names. A rebuild stopped at a path
 * throws, as a refusal does.
 */
export function parseShareViewRebuildAnswer(
  value: unknown,
  read: ListedReach,
): ShareViewRebuildAnswer<ListedReach> {
  if (!isRecord(value)) throw new Error("dohc could not read the engine's rebuild answer.");
  if (value.state === "reachMoved") return { state: "reachMoved" };
  if (
    value.state === "stopped" &&
    typeof value.code === "string" &&
    typeof value.path === "string"
  ) {
    throw new ShareViewRebuildStoppedError(value.code, value.path);
  }
  const savedDrafts = value.savedDrafts;
  if (
    value.state === "rebuilt" &&
    (value.recoveryFolder === null || typeof value.recoveryFolder === "string") &&
    typeof value.recovered === "number" &&
    Array.isArray(savedDrafts) &&
    savedDrafts.every((id) => typeof id === "string")
  ) {
    const planned = isRecord(value.reach) ? value.reach : null;
    const reach =
      planned === null ||
      (planned.signature === read.signature &&
        planned.visibilitySignature === read.visibilitySignature)
        ? read
        : parseListedReach(planned);
    return {
      state: "rebuilt",
      reach,
      recoveryFolder: value.recoveryFolder,
      recovered: value.recovered,
      savedDrafts,
    };
  }
  throw new Error("dohc could not read the engine's rebuild answer.");
}

const CHANGE_FAILED =
  "It could not change files in this workspace. Check that no other program has them open and the disk has room.";

// Why each code the engine stops a rebuild with stopped it, if dohc knows,
// and what the person can do. Each sits under the title "dohc could not
// update access", so it starts with "It" rather than naming dohc again.
const REBUILD_REFUSALS: Partial<Record<string, string>> = {
  // On Windows a rename that a held file blocks fails as access denied, as
  // a real denial does, so the words can't be sure.
  "share-view-rebuild-file-held":
    "Another program may have a file in this workspace open. Close it, then choose Try again.",
  "share-view-rebuild-linked-folder":
    "A file or folder in this workspace is a link. Put what it links to in its place, then choose Try again.",
  "share-view-rebuild-rename-failed": CHANGE_FAILED,
  "share-view-rebuild-recovery-move-failed": CHANGE_FAILED,
  "share-view-rebuild-recovery-unavailable": CHANGE_FAILED,
  "share-view-rebuild-staging-unavailable": CHANGE_FAILED,
  "share-view-rebuild-staging-left": CHANGE_FAILED,
  "share-view-rebuild-aside-unavailable": CHANGE_FAILED,
  "share-view-rebuild-aside-left": CHANGE_FAILED,
  "share-view-rebuild-manifest-unwritable": CHANGE_FAILED,
  // The scan could not read a path. A file another program holds is one
  // cause, a permission another, so the words don't say which.
  "share-view-rebuild-disk-unreadable":
    "It could not read a file in this workspace. If another program has it open, close it, then choose Try again.",
  "share-view-rebuild-filesystem-unreadable":
    "It could not read which disk this workspace's .dohc folder is on.",
  "share-view-rebuild-jobs-unfinished": "It could not finish writing the files in this workspace.",
  "share-view-rebuild-filesystems-differ":
    "This workspace's .dohc folder is spread over more than one disk. Move it onto one disk, then choose Try again.",
  "share-view-rebuild-swap-unrecognized":
    "dohc's data for this workspace is in a state it doesn't recognize.",
  "share-view-rebuild-root-open": "This workspace was still open.",
};

// The same stops, when the engine names the path. A path is never the
// first word of a sentence.
const REBUILD_STOPS_AT: Partial<Record<string, (path: string) => string>> = {
  "share-view-rebuild-linked-folder": (path) =>
    `The file or folder at ${path} is a link. Put what it links to in its place, then choose Try again.`,
  "share-view-rebuild-disk-unreadable": (path) =>
    `It could not read ${path}. If another program has it open, close it, then choose Try again.`,
};

// A stop's words fit the view's bound with room to spare.
const STOP_PATH_MAX = 300;

/**
 * A long path as its first folder, "…", and as many of its last parts as
 * fit. A path with no folder between its first and its name stays whole. A
 * path that is one long name is cut in the middle, as a row cuts it
 * (`MiddleCutName`): its start gives way behind "…", and its last five
 * characters and extension stay.
 */
function stopPath(path: string): string {
  if (path.length <= STOP_PATH_MAX) return path;
  const parts = path.split("/");
  if (parts.length === 2) return path;
  if (parts.length === 1) {
    const chars = Array.from(path);
    const extension = /\.[^.\s]{1,15}$/u.exec(path);
    const kept = Array.from(extension && extension.index > 0 ? extension[0] : "").length + 5;
    return `${chars.slice(0, STOP_PATH_MAX - kept - 1).join("")}…${chars.slice(-kept).join("")}`;
  }
  let tail = parts.pop()!;
  while (
    parts.length > 1 &&
    parts[0]!.length + tail.length + parts.at(-1)!.length + 3 <= STOP_PATH_MAX
  ) {
    tail = `${parts.pop()!}/${tail}`;
  }
  return `${parts[0]!}/…/${tail}`;
}

/** The code an engine refusal carries, through the errors that wrap it. */
function engineRefusalCode(error: unknown): string | null {
  for (let at = error, depth = 0; at instanceof Error && depth < 4; at = at.cause, depth += 1) {
    if (at instanceof EngineRequestError && at.wireError) return at.wireError.message;
  }
  return null;
}

/** What the view records about a stopped rebuild, or null once it runs or finished. */
export function shareViewRebuildStop(notice: ShareViewRebuildNotice): ShareViewRebuildStop | null {
  switch (notice.kind) {
    case "waiting":
      return { reason: "waiting", detail: "dohc could not reach the server. It keeps trying." };
    case "ended":
      return {
        reason: "ended",
        detail:
          "Your membership ended. This copy stays on this computer. Ask the owner to invite you again to keep working in it.",
      };
    case "failed": {
      if (notice.error instanceof LivePageUnkeptError)
        return { reason: "failed", detail: notice.error.message };
      if (notice.error instanceof ShareViewRebuildStoppedError) {
        const { code, path } = notice.error;
        const why = REBUILD_STOPS_AT[code];
        return why === undefined
          ? { reason: "failed", detail: "dohc could not update access.", cause: code }
          : {
              reason: "failed",
              title: "dohc could not update access",
              detail: why(stopPath(path)),
              cause: code,
            };
      }
      const code = engineRefusalCode(notice.error);
      if (code !== null) {
        const why = REBUILD_REFUSALS[code];
        return why === undefined
          ? { reason: "failed", detail: "dohc could not update access.", cause: code }
          : { reason: "failed", title: "dohc could not update access", detail: why, cause: code };
      }
      const cause = notice.error instanceof Error ? notice.error.message : String(notice.error);
      return {
        reason: "failed",
        detail: `dohc could not update access: ${cause.replace(/\.+$/u, "") || "the engine stopped"}.`,
      };
    }
    default:
      return null;
  }
}
