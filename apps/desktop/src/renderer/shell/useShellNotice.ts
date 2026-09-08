import { useCallback, useEffect, useRef, useState } from "react";

export function useShellNotice() {
  // Quiet, self-dismissing status line for import/share-mount summaries
  // ("Imported 3 files into notes.") — informational, never the error banner.
  const [shellNotice, setShellNotice] = useState<string | null>(null);
  const shellNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showShellNotice = useCallback((message: string) => {
    setShellNotice(message);
    if (shellNoticeTimer.current) clearTimeout(shellNoticeTimer.current);
    shellNoticeTimer.current = setTimeout(() => setShellNotice(null), 6000);
  }, []);
  useEffect(
    () => () => {
      if (shellNoticeTimer.current) clearTimeout(shellNoticeTimer.current);
    },
    [],
  );
  const dismissShellNotice = useCallback(() => {
    setShellNotice(null);
  }, []);

  return { shellNotice, showShellNotice, dismissShellNotice };
}
