import type { EngineClient } from "@dohc/workspace-engine-client/daemon";

type DraftLister = Pick<EngineClient, "ownerYDocListDrafts">;

/**
 * The shared notes whose edits wait on this computer for the server. Each
 * one's file keeps the text the server last settled until the server accepts
 * them. A frozen draft is left out: its recovery row in Notices speaks for
 * its edits, and a document read returns its file. Drafts belong to main, so
 * another active version has none.
 */
export async function listOwnerPendingSharePaths(client: DraftLister, workspace: string, activeVersionId: string,
  signal?: AbortSignal): Promise<string[]> {
  const paths: string[] = [];
  let after: Parameters<EngineClient["ownerYDocListDrafts"]>[1]["after"] = null;
  do {
    const page = await client.ownerYDocListDrafts({ id: 0, workspace, deadlineMs: 30_000 }, { after, limit: 64, pendingOnly: true }, signal);
    for (const draft of page.drafts) {
      if (draft.state !== "quarantined" && draft.binding.mainVersionId === activeVersionId) paths.push(draft.binding.currentPath);
    }
    after = page.next;
  } while (after);
  return paths.sort();
}

/**
 * Which of these paths name a document this computer holds an owner binding
 * for on main, whatever its queue holds.
 */
export async function listOwnerBoundPaths(client: DraftLister, workspace: string, paths: ReadonlySet<string>,
  signal?: AbortSignal): Promise<Set<string>> {
  const bound = new Set<string>();
  let after: Parameters<EngineClient["ownerYDocListDrafts"]>[1]["after"] = null;
  do {
    const page = await client.ownerYDocListDrafts({ id: 0, workspace, deadlineMs: 30_000 }, { after, limit: 64 }, signal);
    for (const draft of page.drafts) {
      if (draft.binding.mainVersionId === "main" && paths.has(draft.binding.currentPath)) bound.add(draft.binding.currentPath);
    }
    after = page.next;
  } while (after && bound.size < paths.size);
  return bound;
}

/**
 * Each workspace's pending-share paths, read again when owner delivery or an
 * editor's share state changes, so a lookup never asks the engine. One read
 * runs per workspace at a time; changes during it read once more after it.
 * A failed read keeps the last answer.
 */
export function createOwnerPendingShare(options: {
  read(workspaceId: string): Promise<readonly string[]>;
  onChange(workspaceId: string): void;
}) {
  const paths = new Map<string, readonly string[]>();
  const reading = new Set<string>(), again = new Set<string>();
  async function read(workspaceId: string): Promise<void> {
    do {
      again.delete(workspaceId);
      try {
        const next = await options.read(workspaceId);
        if (next.join("\0") === (paths.get(workspaceId) ?? []).join("\0")) continue;
        if (next.length) paths.set(workspaceId, next); else paths.delete(workspaceId);
        options.onChange(workspaceId);
      } catch (error) {
        console.error("[desktop] pending share read failed:", error);
      }
    } while (again.has(workspaceId));
    reading.delete(workspaceId);
  }
  return {
    refresh(workspaceId: string): void {
      if (reading.has(workspaceId)) { again.add(workspaceId); return; }
      reading.add(workspaceId);
      void read(workspaceId);
    },
    paths: (workspaceId: string): readonly string[] => paths.get(workspaceId) ?? [],
  };
}
