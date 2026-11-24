import { views, type WorkspaceData } from "../server/workspaceData";
import type { ChatRowData, ChatSection } from "./types";

type Store = Pick<WorkspaceData, "prefetch">;

export const PREFETCHED_UNREAD = 3;

/** Reads a chat's stream before it opens, and its lanes where phone writes are on. */
export function prefetchChat(data: Store, row: Pick<ChatRowData, "id">, writes: boolean) {
  data.prefetch(views.stream(row.id));
  if (writes) data.prefetch(views.lanes(row.id));
}

/** Prefetches the first unread chats once for each store, from the first list that has any. */
export function unreadPrefetch(writes: boolean) {
  let warmed: Store | null = null;
  return (data: Store, sections: readonly ChatSection[]) => {
    if (warmed === data) return;
    const unread = sections
      .flatMap((section) => section.rows)
      .filter((row) => row.unread)
      .slice(0, PREFETCHED_UNREAD);
    if (unread.length === 0) return;
    warmed = data;
    for (const row of unread) prefetchChat(data, row, writes);
  };
}
