import { views, type View, type WorkspaceData } from "../server/workspaceData";
import type { ChatRowData, ChatSection } from "./types";

type Store = Pick<WorkspaceData, "prefetch" | "prefetchAhead">;

export const PREFETCHED_UNREAD = 3;

/** Reads a chat's stream before it opens, and its lanes where phone writes are on. */
export function prefetchChat(
  data: Pick<WorkspaceData, "prefetch">,
  row: Pick<ChatRowData, "id">,
  writes: boolean,
) {
  data.prefetch(views.stream(row.id));
  if (writes) data.prefetch(views.lanes(row.id));
}

/** Queues the top chats (unread first) and Home's files on the polite read-ahead lane once per store. */
export function unreadPrefetch(writes: boolean) {
  let warmedChats: Store | null = null;
  let warmedFiles: Store | null = null;
  return (data: Store, sections: readonly ChatSection[]) => {
    const queued: View<unknown>[] = [];
    if (warmedChats !== data) {
      const active = sections
        .filter((section) => section.key !== "archived")
        .flatMap((section) => section.rows);
      const chosen = [
        ...active.filter((row) => row.unread),
        ...active.filter((row) => !row.unread),
      ].slice(0, PREFETCHED_UNREAD);
      if (chosen.length > 0) {
        warmedChats = data;
        queued.push(
          ...chosen.flatMap((row) =>
            writes ? [views.stream(row.id), views.lanes(row.id)] : [views.stream(row.id)],
          ),
        );
      }
    }
    if (warmedFiles !== data) {
      warmedFiles = data;
      queued.push(views.files);
    }
    if (queued.length > 0) data.prefetchAhead(queued);
  };
}
