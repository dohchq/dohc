import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
declare function followUp(): Promise<void>;
export function A() {
  const [, setPage] = useState<unknown>(null);
  const onPage = useCallback(async (value: unknown) => { await followUp(); setPage(value); }, []);
  useDesktopLoad([], "readPage", {}, { success: onPage, failure: setPage });
  return null;
}
