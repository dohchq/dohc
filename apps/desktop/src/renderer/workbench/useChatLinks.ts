import { useCallback, useRef } from "react";
import type { ChatLinksPage } from "@dohc/workspace-contracts/chat-links";
import { bridge } from "../bridge";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";

type Page = NonNullable<ChatLinksPage>;
type More = { cursor: string; pages: Page[] };
const NO_PAGES: Page[] = [];

// Reads only when opened or paged by the caller. A refresh supersedes a page
// still loading, and a page read waits for any read in flight.
export function useChatLinks({ workspaceId, channelWireId, onError }: {
  workspaceId: string;
  channelWireId: string;
  onError(error: unknown): void;
}) {
  const query = useWorkspaceQuery(useWorkspaceSession(), {
    key: `${workspaceId}\0${channelWireId}`,
    manual: true,
    report: onError,
    load: async (_signal, more?: More) => {
      const page = await bridge().chatLinks({ workspaceId, channelWireId, ...(more ? { cursor: more.cursor } : {}) });
      return page
        ? { pages: [...(more?.pages ?? []), page], status: "loaded" as const }
        : { pages: [], status: "unavailable" as const };
    },
  });
  const { retry, retryIfIdle, pending: loading } = query;
  const pages = query.value?.pages ?? NO_PAGES;
  const load = useCallback(() => retry(), [retry]);
  // A caller may keep loadMore across renders, so it pages from the pages
  // shown now, not the pages of the render that made it.
  const shown = useRef(pages);
  shown.current = pages;
  const loadMore = useCallback(() => {
    const cursor = shown.current.at(-1)?.nextCursor;
    return cursor ? retryIfIdle({ cursor, pages: shown.current }) : Promise.resolve();
  }, [retryIfIdle]);
  const status = loading ? "loading" : query.error !== null ? "unavailable" : query.value?.status ?? "idle";
  return { pages, status, loading, load, loadMore };
}
