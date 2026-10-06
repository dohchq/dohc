import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
export function RecordHistory(p: { workspaceId: string; recordId: string; report: (retry: () => void) => void }) {
  const [, setPages] = useState<unknown[]>([]);
  function trim(pages: unknown[]) { return pages.slice(-50); }
  function note(page: unknown) { return page; }
  function appendPage(page: unknown) { void note(page); setPages((pages) => trim([...pages, page])); }
  const [load, pending] = useDesktopAction([p.workspaceId, p.recordId], "getCollectionRecordHistory", {
    success: appendPage,
    failure: () => p.report(() => { load({ workspaceId: p.workspaceId, collectionPath: "c", recordId: p.recordId }); }),
  });
  return pending;
}
