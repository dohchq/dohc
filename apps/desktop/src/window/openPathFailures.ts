import { randomUUID } from "node:crypto";
import { WORKSPACE_PATH_OPEN_FAILURES_MAX, type WorkspacePathOpenFailure } from "../ipc/bridgeContract";
import { ipcWireError } from "../ipc/errorWords";

// One window's renderer, as this store needs it.
export interface OpenPathFailureRenderer {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
}

/**
 * Folders a launch, the OS, or a Try again could not open. Main holds each
 * for the window it reported to, until that window's renderer takes it, and
 * for one Try again from that window. The renderer names an attempt, never a
 * path, so it cannot make main open a folder nobody asked for.
 */
export function createOpenPathFailures<Renderer extends OpenPathFailureRenderer>(dependencies: {
  // The workspace the renderer shows now, or null for none.
  workspaceIdOf(renderer: Renderer): string | null;
  // Tells the renderer a failure is waiting. The renderer may not hear it.
  notify(renderer: Renderer): void;
  // Opens the path again in the renderer's window, or rejects with why not.
  reopen(path: string, renderer: Renderer): Promise<void>;
  // Main's log keeps the error itself.
  record(path: string, error: unknown): void;
  limit?: number;
}) {
  const limit = dependencies.limit ?? WORKSPACE_PATH_OPEN_FAILURES_MAX;
  const held = new Map<string, { failure: WorkspacePathOpenFailure; rendererId: number; taken: boolean }>();
  const watched = new WeakSet<Renderer>();

  function report(
    path: string,
    error: unknown,
    renderer: Renderer,
    workspaceId = dependencies.workspaceIdOf(renderer),
  ): void {
    if (renderer.isDestroyed()) return;
    if (!watched.has(renderer)) {
      watched.add(renderer);
      // A closed window's failures and attempts go with it.
      renderer.once("destroyed", () => {
        for (const [attemptId, entry] of held) if (entry.rendererId === renderer.id) held.delete(attemptId);
      });
    }
    const failure = { attemptId: randomUUID(), path, cause: String(ipcWireError(error)), workspaceId };
    held.set(failure.attemptId, { failure, rendererId: renderer.id, taken: false });
    for (const oldest of held.keys()) {
      if (held.size <= limit) break;
      held.delete(oldest);
    }
    dependencies.notify(renderer);
  }

  return {
    report: (path: string, error: unknown, renderer: Renderer) => report(path, error, renderer),
    // Each failure goes to the first take from its window, and only that one.
    take(renderer: Renderer): WorkspacePathOpenFailure[] {
      const taken: WorkspacePathOpenFailure[] = [];
      for (const entry of held.values()) {
        if (entry.rendererId !== renderer.id || entry.taken) continue;
        entry.taken = true;
        taken.push(entry.failure);
      }
      return taken;
    },
    async retry(attemptId: string, renderer: Renderer): Promise<void> {
      const entry = held.get(attemptId);
      if (entry?.rendererId !== renderer.id) throw new Error("Open the folder again.");
      held.delete(attemptId);
      const { path } = entry.failure;
      const workspaceId = dependencies.workspaceIdOf(renderer);
      try {
        await dependencies.reopen(path, renderer);
      } catch (error) {
        dependencies.record(path, error);
        // The failure belongs to the workspace the window showed when Try
        // again began. A window that has moved on since does not get it.
        if (!renderer.isDestroyed() && dependencies.workspaceIdOf(renderer) === workspaceId) {
          report(path, error, renderer, workspaceId);
        }
      }
    },
  };
}
