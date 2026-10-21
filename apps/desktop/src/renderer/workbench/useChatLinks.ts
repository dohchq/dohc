import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ChatLinksPage } from "@dohc/workspace-contracts/chat-links";
import { bridge } from "../bridge";

type Page = NonNullable<ChatLinksPage>;
type Status = "idle" | "loaded" | "unavailable";

// Reads only when opened or paged by the caller. Each scope owns its requests.
export function useChatLinks({ workspaceId, channelWireId, onError }: {
  workspaceId: string;
  channelWireId: string;
  onError(error: unknown): void;
}) {
  const scope = useRef({ workspaceId, channelWireId, sequence: 0, busy: false, mounted: true });
  if (scope.current.workspaceId !== workspaceId || scope.current.channelWireId !== channelWireId) {
    scope.current = { workspaceId, channelWireId, sequence: 0, busy: false, mounted: true };
  }
  const current = scope.current;
  const [state, setState] = useState<{ scope: typeof current; pages: Page[]; status: Status; loading: boolean }>({
    scope: current, pages: [], status: "idle", loading: false,
  });
  const pages = state.scope === current ? state.pages : [];
  const latest = useRef(pages);
  latest.current = pages;
  useLayoutEffect(() => {
    current.mounted = true;
    return () => { current.mounted = false; current.sequence++; };
  }, [current]);
  const read = useCallback(async (cursor?: string) => {
    if (scope.current !== current || !current.mounted || (cursor && current.busy)) return;
    const sequence = ++current.sequence;
    const active = () => scope.current === current && current.mounted && current.sequence === sequence;
    current.busy = true;
    setState(previous => ({
      scope: current, pages: previous.scope === current ? previous.pages : [],
      status: previous.scope === current ? previous.status : "idle", loading: true,
    }));
    try {
      const page = await bridge().chatLinks({ workspaceId, channelWireId, ...(cursor ? { cursor } : {}) });
      if (!active()) return;
      setState(previous => ({
        scope: current, pages: page ? [...(cursor && previous.scope === current ? previous.pages : []), page] : [],
        status: page ? "loaded" : "unavailable", loading: false,
      }));
    } catch (error) {
      if (active()) {
        setState(previous => ({ ...previous, status: "unavailable", loading: false }));
        onError(error);
      }
    } finally {
      if (active()) {
        current.busy = false;
        setState(previous => ({ ...previous, loading: false }));
      }
    }
  }, [current, workspaceId, channelWireId, onError]);
  const load = useCallback(() => read(), [read]);
  const loadMore = useCallback(() => {
    const cursor = latest.current.at(-1)?.nextCursor;
    return cursor ? read(cursor) : Promise.resolve();
  }, [read]);
  const loading = state.scope === current && state.loading;
  const status = state.scope !== current ? "idle" : loading ? "loading" : state.status;
  return { pages, status, loading, load, loadMore };
}
