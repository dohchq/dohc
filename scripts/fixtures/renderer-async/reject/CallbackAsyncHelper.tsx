import { useCallback, useMemo, useRef, useState } from "react";
import { useDesktopAction, useDesktopCommand, useDesktopEvent, useDesktopLoad } from "./desktopAction";
declare function enrich(v: unknown): Promise<unknown>;
export function A() {
  const [, setX] = useState<unknown>(null);
  const apply = useCallback(async (v: unknown) => { setX(await enrich(v)); }, []);
  function onValue(v: unknown) { apply(v); }
  useDesktopLoad([], "readPage", {}, { success: onValue, failure: () => {} });
  return null;
}
