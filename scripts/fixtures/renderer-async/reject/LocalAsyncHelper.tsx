import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function A(p: { workspaceId: string; refreshKey: string }) {
  const [, setGraph] = useState<unknown>(null);
  async function applyGraph(value: unknown) { await Promise.resolve(); setGraph(value); }
  useDesktopLoad([p.workspaceId, p.refreshKey], "readWorkspaceGraph", { workspaceId: p.workspaceId, includeChatMentions: false }, {
    success: (value: unknown) => { void applyGraph(value); },
    failure: () => {},
  });
  return null;
}
