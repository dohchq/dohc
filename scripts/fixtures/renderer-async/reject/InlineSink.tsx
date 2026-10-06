import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function A(p: { key: string }) {
  const cache = useRef(new Map<string, unknown>());
  const [, setPage] = useState<unknown>(null);
  useDesktopLoad([p.key], async (desktop: any) => { const page = await desktop.listChatMessages({}); cache.current.set(p.key, page); setPage(page); return page; }, {}, { success: setPage, failure: setPage });
  return null;
}
