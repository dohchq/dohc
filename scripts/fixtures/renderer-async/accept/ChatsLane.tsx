import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
import { readLaneAgents } from "./data/laneAgents";
export function ChatsLane(p: { workspaceId: string; channelIds: readonly string[]; atChannels: boolean }) {
  const cache = useRef<Record<string, any>>({});
  const [, setAgents] = useState<unknown>(null);
  useDesktopLoad([], readLaneAgents,
    p.atChannels ? { workspaceId: p.workspaceId, channelIds: p.channelIds } : null,
    { success: (result: any) => { Object.assign(cache.current, result.updates); setAgents(result.agents); }, failure: () => {} },
    cache.current);
  return null;
}
