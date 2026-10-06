import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
import { desktopMetadata } from "./desktopAction";
export function GraphView(p: { workspaceId: string; includeChatMentions: boolean; refreshKey: string }) {
  const [, setGraph] = useState<unknown>(null);
  const [, setError] = useState<unknown>(null);
  useDesktopLoad([p.workspaceId, p.includeChatMentions, p.refreshKey], "readWorkspaceGraph", { workspaceId: p.workspaceId, includeChatMentions: p.includeChatMentions }, { success: setGraph, failure: setError });
  return desktopMetadata().platform;
}
