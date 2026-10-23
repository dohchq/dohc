import { randomUUID } from "node:crypto";
import {
  WORKSPACE_PATH_OPEN_FAILURES_MAX,
  WORKSPACE_PATH_OPEN_MORE_PATHS_MAX,
  type WorkspacePathOpenFailure,
} from "../ipc/bridgeContract";
import { ipcWireError } from "../ipc/errorWords";

// One window's renderer, as this store needs it.
export interface OpenPathFailureRenderer {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
}

/**
 * Folders a launch, the OS, or a Try again could not open, and a failed move
 * to Applications. Main holds each for the window it reported to, until that
 * window's renderer takes it, and for one Try again from that window. The
 * renderer names an attempt, never a path, so it cannot make main open a
 * folder nobody asked for.
 */
export function createOpenPathFailures<Renderer extends OpenPathFailureRenderer>(dependencies: {
  // The workspace the renderer shows now, or null for none.
  workspaceIdOf(renderer: Renderer): string | null;
  // Tells the renderer a failure is waiting. The renderer may not hear it.
  notify(renderer: Renderer): void;
  // Opens the path again in the renderer's window, or rejects with why not.
  reopen(path: string, renderer: Renderer): Promise<void>;
  // Moves dohc to Applications again, or rejects with why not.
  moveAgain(): Promise<void>;
  // Main's log keeps the error itself.
  record(path: string, error: unknown): void;
  limit?: number;
}) {
  // A window keeps up to `limit` failures apart until it takes them; past
  // that they combine into one. Main keeps `limit` taken ones for Try again,
  // oldest dropped first. It never drops one a window has not taken.
  const limit = dependencies.limit ?? WORKSPACE_PATH_OPEN_FAILURES_MAX;
  const held = new Map<string, { failure: WorkspacePathOpenFailure; rendererId: number; taken: boolean }>();
  const watched = new WeakSet<Renderer>();

  function watch(renderer: Renderer): void {
    if (watched.has(renderer)) return;
    watched.add(renderer);
    // A closed window's failures and attempts go with it.
    renderer.once("destroyed", () => {
      for (const [attemptId, entry] of held) if (entry.rendererId === renderer.id) held.delete(attemptId);
    });
  }

  function report(
    path: string,
    error: unknown,
    renderer: Renderer,
    workspaceId = dependencies.workspaceIdOf(renderer),
  ): void {
    if (renderer.isDestroyed()) return;
    watch(renderer);
    const waiting = [...held.values()].filter((entry) => entry.rendererId === renderer.id && !entry.taken
      && !("moveToApplications" in entry.failure));
    const attemptId = randomUUID();
    if (waiting.length < limit) {
      const failure = { attemptId, path, cause: String(ipcWireError(error)), workspaceId };
      held.set(attemptId, { failure, rendererId: renderer.id, taken: false });
    } else {
      const more = waiting.find(({ failure }) => "paths" in failure && failure.workspaceId === workspaceId)?.failure;
      if (more && "paths" in more) {
        more.count += 1;
        if (more.paths.length < WORKSPACE_PATH_OPEN_MORE_PATHS_MAX) more.paths.push(path);
      } else {
        held.set(attemptId, { failure: { attemptId, paths: [path], count: 1, workspaceId }, rendererId: renderer.id, taken: false });
      }
    }
    dependencies.notify(renderer);
  }

  function reportMove(error: unknown, renderer: Renderer, workspaceId = dependencies.workspaceIdOf(renderer)): void {
    if (renderer.isDestroyed()) return;
    watch(renderer);
    // A newer failed move replaces one this window has not taken.
    for (const [attemptId, entry] of held) {
      if (entry.rendererId === renderer.id && !entry.taken && "moveToApplications" in entry.failure) held.delete(attemptId);
    }
    const attemptId = randomUUID();
    const failure = { attemptId, moveToApplications: true as const, cause: String(ipcWireError(error)), workspaceId };
    held.set(attemptId, { failure, rendererId: renderer.id, taken: false });
    dependencies.notify(renderer);
  }

  return {
    report: (path: string, error: unknown, renderer: Renderer) => report(path, error, renderer),
    reportMove: (error: unknown, renderer: Renderer) => reportMove(error, renderer),
    // Each failure goes to the first take from its window, and only that one.
    take(renderer: Renderer): WorkspacePathOpenFailure[] {
      const taken: WorkspacePathOpenFailure[] = [];
      for (const [attemptId, entry] of held) {
        if (entry.rendererId !== renderer.id || entry.taken) continue;
        taken.push(entry.failure);
        // Folders combined into one have no Try again to keep.
        if ("paths" in entry.failure) held.delete(attemptId);
        else entry.taken = true;
      }
      const spent = [...held].filter(([, entry]) => entry.taken);
      for (const [attemptId] of spent.slice(0, Math.max(0, spent.length - limit))) held.delete(attemptId);
      return taken;
    },
    async retry(attemptId: string, renderer: Renderer): Promise<void> {
      const entry = held.get(attemptId);
      if (entry?.rendererId !== renderer.id || "paths" in entry.failure) throw new Error("Open the folder again.");
      held.delete(attemptId);
      const { failure } = entry;
      const workspaceId = dependencies.workspaceIdOf(renderer);
      try {
        if ("path" in failure) await dependencies.reopen(failure.path, renderer);
        else await dependencies.moveAgain();
      } catch (error) {
        if ("path" in failure) dependencies.record(failure.path, error);
        // The failure belongs to the workspace the window showed when Try
        // again began. A window that has moved on since does not get it.
        if (!renderer.isDestroyed() && dependencies.workspaceIdOf(renderer) === workspaceId) {
          if ("path" in failure) report(failure.path, error, renderer, workspaceId);
          else reportMove(error, renderer, workspaceId);
        }
      }
    },
  };
}
